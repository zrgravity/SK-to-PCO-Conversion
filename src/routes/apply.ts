/**
 * POST /api/apply/:batchId?offset=N&limit=N
 * Applies ONE PAGE of approved changes to PCO. Call repeatedly until done=true.
 *
 * Paginated like sync and diff to avoid Cloudflare's per-invocation limits:
 *   - 1000 subrequest limit (each PCO API call + D1 write = 2 subrequests)
 *   - CPU time limit
 *
 * Query params:
 *   ?offset=N  — row offset into approved changes (default 0)
 *   ?limit=N   — page size (default 20, max 25)
 *
 * Returns: { applied, failed, done, nextOffset, counts }
 */

import { Hono } from "hono";
import { PcoClient } from "../pco/client";
import {
  getApprovedChangesPage,
  updateChangeStatus,
  updateBatchStatus,
  upsertPersonMatch,
  getBatch,
  countChanges,
} from "../db/queries";
import type { Env, PendingChangeRow } from "../types";

export const applyRoute = new Hono<{ Bindings: Env }>();

applyRoute.post("/:batchId", async (c) => {
  const batchId = c.req.param("batchId");
  const batch = await getBatch(c.env.DB, batchId);
  if (!batch) return c.json({ ok: false, error: "Batch not found" }, 404);

  const limit  = Math.min(25, Math.max(1, parseInt(c.req.query("limit")  ?? "20", 10) || 20));
  const offset = Math.max(0,              parseInt(c.req.query("offset") ?? "0",  10) || 0);

  const { rows: changes, hasMore } = await getApprovedChangesPage(c.env.DB, batchId, limit, offset);

  if (changes.length === 0) {
    const counts = await countChanges(c.env.DB, batchId);
    return c.json({
      ok: true,
      data: { message: "No approved changes to apply", applied: 0, failed: 0, done: true, nextOffset: offset, counts },
    });
  }

  const pco = new PcoClient(c.env.PCO_APP_ID, c.env.PCO_APP_SECRET);
  const userEmail = c.req.header("CF-Access-Authenticated-User-Email") ?? null;

  // newPersonMap: sk_individual_id → newly created PCO person ID
  // Built within this invocation; follow-on contact adds that arrive in the
  // same page benefit from it. For follow-on changes on a later page the
  // pco_person_id column will have been written by the create_person handler.
  const newPersonMap = new Map<string, string>();

  // failedCreates: sk_individual_ids whose create_person failed this page.
  // Follow-on add_ changes for these will get a meaningful error message.
  const failedCreates = new Set<string>();

  let applied = 0;
  let failed  = 0;

  for (const change of changes) {
    try {
      await applyChange(pco, c.env.DB, change, newPersonMap, failedCreates, userEmail);
      await updateChangeStatus(c.env.DB, change.id, "applied", userEmail);
      applied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateChangeStatus(c.env.DB, change.id, "failed", userEmail, {
        errorMessage: msg,
      });
      // Track create_person failures so follow-on changes get a better message
      if (change.change_type === "create_person" && change.sk_individual_id) {
        failedCreates.add(change.sk_individual_id);
      }
      failed++;
      console.error(`[apply] Change ${change.id} (${change.change_type}) failed:`, msg);
    }
  }

  if (!hasMore && failed === 0) {
    await updateBatchStatus(c.env.DB, batchId, "applied");
  }

  const counts = await countChanges(c.env.DB, batchId);
  return c.json({
    ok: true,
    data: {
      batch_id: batchId,
      applied,
      failed,
      done: !hasMore,
      nextOffset: offset + changes.length,
      counts,
    },
  });
});

// ── Internal apply dispatcher ─────────────────────────────────────────────────

async function applyChange(
  pco: PcoClient,
  db: D1Database,
  change: PendingChangeRow,
  newPersonMap: Map<string, string>,
  failedCreates: Set<string>,
  userEmail: string | null,
): Promise<void> {
  // Resolve pco_person_id — new person may have just been created in this page
  let pcoId = change.pco_person_id;
  if (!pcoId && change.sk_individual_id) {
    pcoId = newPersonMap.get(change.sk_individual_id) ?? null;
  }

  switch (change.change_type) {
    case "create_person": {
      const attrs = JSON.parse(change.new_value ?? "{}");
      const person = await pco.createPerson(attrs);
      const newId = person.id;
      // Store so follow-on contact adds in the same page can use it
      if (change.sk_individual_id) {
        newPersonMap.set(change.sk_individual_id, newId);
        await upsertPersonMatch(
          db,
          change.sk_individual_id,
          newId,
          "remote_id",
          true,
          userEmail,
        );
      }
      // Write the new PCO ID into this row so the UI can link back to PCO
      await updateChangeStatus(db, change.id, "applied", userEmail, {
        pcoPersonId: newId,
      });
      return;
    }

    case "update_field": {
      if (!pcoId) throw new Error(missingPcoIdMessage(change, failedCreates));
      const value = JSON.parse(change.new_value ?? "null");
      await pco.updatePerson(pcoId, { [change.field_name!]: value });
      return;
    }

    case "add_email": {
      if (!pcoId) throw new Error(missingPcoIdMessage(change, failedCreates));
      const address = JSON.parse(change.new_value ?? "null");
      await pco.createEmail(pcoId, {
        address,
        location: (change.field_name as "Home" | "Work") ?? "Home",
      });
      return;
    }

    case "update_email": {
      if (!pcoId) throw new Error(missingPcoIdMessage(change, failedCreates));
      const address = JSON.parse(change.new_value ?? "null");
      await pco.updateEmail(pcoId, change.field_name!, { address });
      return;
    }

    case "add_phone": {
      if (!pcoId) throw new Error(missingPcoIdMessage(change, failedCreates));
      const number = JSON.parse(change.new_value ?? "null");
      await pco.createPhoneNumber(pcoId, {
        number,
        location: (change.field_name as "Home" | "Mobile" | "Work") ?? "Home",
      });
      return;
    }

    case "update_phone": {
      if (!pcoId) throw new Error(missingPcoIdMessage(change, failedCreates));
      const number = JSON.parse(change.new_value ?? "null");
      await pco.updatePhoneNumber(pcoId, change.field_name!, { number });
      return;
    }

    case "add_address": {
      if (!pcoId) throw new Error(missingPcoIdMessage(change, failedCreates));
      const addr = JSON.parse(change.new_value ?? "{}");
      await pco.createAddress(pcoId, {
        street: addr.street || null,
        city: addr.city || null,
        state: addr.state || null,
        zip: addr.zip || null,
        location: (change.field_name as "Home" | "Work") ?? "Home",
      });
      return;
    }

    case "update_address": {
      if (!pcoId) throw new Error(missingPcoIdMessage(change, failedCreates));
      const addr = JSON.parse(change.new_value ?? "{}");
      await pco.updateAddress(pcoId, change.field_name!, {
        street: addr.street || null,
        city: addr.city || null,
        state: addr.state || null,
        zip: addr.zip || null,
      });
      return;
    }

    case "household":
      // Household management is future work — skip silently for now
      return;

    default:
      throw new Error(`Unknown change_type: ${change.change_type}`);
  }
}

/**
 * Build a meaningful error message when a change has no PCO person ID.
 * If the person's create_person failed earlier in this page, say so explicitly.
 */
function missingPcoIdMessage(change: PendingChangeRow, failedCreates: Set<string>): string {
  if (change.sk_individual_id && failedCreates.has(change.sk_individual_id)) {
    return `Skipped — person creation failed for SK ${change.sk_individual_id}`;
  }
  return `No PCO person ID for ${change.change_type} change (SK: ${change.sk_individual_id ?? "?"})`;
}
