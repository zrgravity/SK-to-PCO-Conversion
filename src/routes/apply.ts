/**
 * POST /api/apply/:batchId
 * Applies all approved changes in a batch to PCO via the API.
 * Each change is applied individually and its status is updated.
 * Returns a summary of applied / failed counts.
 */

import { Hono } from "hono";
import { PcoClient } from "../pco/client";
import {
  getApprovedChanges,
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

  const changes = await getApprovedChanges(c.env.DB, batchId);
  if (changes.length === 0) {
    return c.json({
      ok: true,
      data: { message: "No approved changes to apply", applied: 0, failed: 0 },
    });
  }

  const pco = new PcoClient(c.env.PCO_APP_ID, c.env.PCO_APP_SECRET);
  const userEmail = c.req.header("CF-Access-Authenticated-User-Email") ?? null;

  // Map sk_individual_id → new PCO person ID (populated as we create new people)
  const newPersonMap = new Map<string, string>();

  let applied = 0;
  let failed = 0;

  for (const change of changes) {
    try {
      await applyChange(pco, c.env.DB, change, newPersonMap, userEmail);
      await updateChangeStatus(c.env.DB, change.id, "applied", userEmail);
      applied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateChangeStatus(c.env.DB, change.id, "failed", userEmail, {
        errorMessage: msg,
      });
      failed++;
      console.error(`[apply] Change ${change.id} failed:`, msg);
    }
  }

  if (failed === 0) {
    await updateBatchStatus(c.env.DB, batchId, "applied");
  }

  const counts = await countChanges(c.env.DB, batchId);
  return c.json({
    ok: true,
    data: { batch_id: batchId, applied, failed, counts },
  });
});

// ── Internal apply dispatcher ─────────────────────────────────────────────────

async function applyChange(
  pco: PcoClient,
  db: D1Database,
  change: PendingChangeRow,
  newPersonMap: Map<string, string>,
  userEmail: string | null,
): Promise<void> {
  // Resolve pco_person_id — new person may have just been created in this run
  let pcoId = change.pco_person_id;
  if (!pcoId && change.sk_individual_id) {
    pcoId = newPersonMap.get(change.sk_individual_id) ?? null;
  }

  switch (change.change_type) {
    case "create_person": {
      const attrs = JSON.parse(change.new_value ?? "{}");
      const person = await pco.createPerson(attrs);
      const newId = person.id;
      // Store the new PCO ID so follow-on changes for this SK person can use it
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
      // Update this change row with the new pco_person_id
      await updateChangeStatus(db, change.id, "applied", userEmail, {
        pcoPersonId: newId,
      });
      return;
    }

    case "update_field": {
      if (!pcoId) throw new Error("No PCO person ID for update_field change");
      const value = JSON.parse(change.new_value ?? "null");
      await pco.updatePerson(pcoId, { [change.field_name!]: value });
      return;
    }

    case "add_email": {
      if (!pcoId) throw new Error("No PCO person ID for add_email change");
      const address = JSON.parse(change.new_value ?? "null");
      await pco.createEmail(pcoId, {
        address,
        location: (change.field_name as "Home" | "Work") ?? "Home",
      });
      return;
    }

    case "update_email": {
      if (!pcoId) throw new Error("No PCO person ID for update_email change");
      const address = JSON.parse(change.new_value ?? "null");
      await pco.updateEmail(pcoId, change.field_name!, { address });
      return;
    }

    case "add_phone": {
      if (!pcoId) throw new Error("No PCO person ID for add_phone change");
      const number = JSON.parse(change.new_value ?? "null");
      await pco.createPhoneNumber(pcoId, {
        number,
        location: (change.field_name as "Home" | "Mobile" | "Work") ?? "Home",
      });
      return;
    }

    case "update_phone": {
      if (!pcoId) throw new Error("No PCO person ID for update_phone change");
      const number = JSON.parse(change.new_value ?? "null");
      await pco.updatePhoneNumber(pcoId, change.field_name!, { number });
      return;
    }

    case "add_address": {
      if (!pcoId) throw new Error("No PCO person ID for add_address change");
      const addr = JSON.parse(change.new_value ?? "{}");
      await pco.createAddress(pcoId, {
        street: addr.street,
        city: addr.city,
        state: addr.state,
        zip: addr.zip,
        location: (change.field_name as "Home" | "Work") ?? "Home",
      });
      return;
    }

    case "update_address": {
      if (!pcoId) throw new Error("No PCO person ID for update_address change");
      const addr = JSON.parse(change.new_value ?? "{}");
      await pco.updateAddress(pcoId, change.field_name!, {
        street: addr.street,
        city: addr.city,
        state: addr.state,
        zip: addr.zip,
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
