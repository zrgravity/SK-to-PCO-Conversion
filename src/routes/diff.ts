/**
 * POST /api/diff/:batchId
 * Computes differences between a SK import batch and the PCO snapshot,
 * stores them as pending_changes, and returns a summary.
 *
 * GET /api/diff/:batchId
 * Returns the list of pending changes for a batch (with optional status filter).
 */

import { Hono } from "hono";
import { PersonMatcher } from "../matching/matcher";
import {
  diffPersonFields,
  diffEmails,
  diffPhones,
  diffAddresses,
  createPersonChange,
} from "../diff/differ";
import {
  getSkPeopleByBatch,
  getAllPcoPeople,
  getPcoEmails,
  getPcoPhones,
  getPcoAddresses,
  getAllPersonMatches,
  upsertPersonMatch,
  insertPendingChanges,
  getPendingChanges,
  countChanges,
  updateBatchStatus,
  getBatch,
} from "../db/queries";
import type { Env, UnresolvedMatch } from "../types";
import type { ProposedChange } from "../diff/differ";

export const diffRoute = new Hono<{ Bindings: Env }>();

/** GET /api/diff/:batchId — list computed changes */
diffRoute.get("/:batchId", async (c) => {
  const batchId = c.req.param("batchId");
  const status = c.req.query("status") as import("../types").ChangeStatus | undefined;

  const [batch, changes, counts] = await Promise.all([
    getBatch(c.env.DB, batchId),
    getPendingChanges(c.env.DB, batchId, status),
    countChanges(c.env.DB, batchId),
  ]);

  if (!batch) return c.json({ ok: false, error: "Batch not found" }, 404);

  return c.json({ ok: true, data: { batch, changes, counts } });
});

/** POST /api/diff/:batchId — compute and store diffs */
diffRoute.post("/:batchId", async (c) => {
  const batchId = c.req.param("batchId");
  const batch = await getBatch(c.env.DB, batchId);
  if (!batch) return c.json({ ok: false, error: "Batch not found" }, 404);

  const [skPeople, allPco, allMatches] = await Promise.all([
    getSkPeopleByBatch(c.env.DB, batchId),
    getAllPcoPeople(c.env.DB),
    getAllPersonMatches(c.env.DB),
  ]);

  if (allPco.length === 0) {
    return c.json(
      {
        ok: false,
        error: "PCO snapshot is empty. Run POST /api/sync first.",
      },
      400,
    );
  }

  // Build confirmed-matches map from DB
  const confirmedMap = new Map(
    allMatches.map((m) => [
      m.sk_individual_id,
      { pco_id: m.pco_person_id, confidence: m.confidence },
    ]),
  );

  // Enrich PCO snapshot with email list for scoring
  // We already have emails in pco_emails table; load them in bulk
  const allPcoEmails = await c.env.DB
    .prepare(`SELECT pco_id, address FROM pco_emails`)
    .all<{ pco_id: string; address: string }>();

  const emailsByPcoId = new Map<string, string[]>();
  for (const row of allPcoEmails.results) {
    const arr = emailsByPcoId.get(row.pco_id) ?? [];
    arr.push(row.address);
    emailsByPcoId.set(row.pco_id, arr);
  }

  const enrichedPco = allPco.map((p) => ({
    ...p,
    emails: emailsByPcoId.get(p.pco_id) ?? [],
  }));

  // Run matcher
  const matcher = new PersonMatcher();
  const skPersonObjects = skPeople.map((row) => ({
    sk_individual_id: row.sk_individual_id,
    sk_family_id: row.sk_family_id,
    first_name: row.first_name,
    last_name: row.last_name,
    middle_name: row.middle_name,
    preferred_name: row.preferred_name,
    gender: row.gender,
    birthdate: row.birthdate,
    anniversary: row.anniversary,
    membership: row.membership,
    marital_status: row.marital_status,
    home_phone: row.home_phone,
    cell_phone: row.cell_phone,
    work_phone: row.work_phone,
    email_home: row.email_home,
    email_work: row.email_work,
    address_street: row.address_street,
    address_city: row.address_city,
    address_state: row.address_state,
    address_zip: row.address_zip,
    baptized: row.baptized,
    baptized_date: row.baptized_date,
    include_in_dir: row.include_in_dir === 1,
    raw: {} as import("../sk/types").SkRawRow,
  }));

  const { autoMatched, unresolved } = matcher.matchAll(
    skPersonObjects,
    confirmedMap,
    enrichedPco,
  );

  // Persist auto-matches back to DB
  for (const [skId, result] of autoMatched) {
    if (result.kind === "confirmed" || result.kind === "strong") {
      await upsertPersonMatch(
        c.env.DB,
        skId,
        result.pco_id,
        result.confidence as import("../types").PersonMatchRow["confidence"],
        result.kind === "confirmed",
        null,
      );
    }
  }

  // Build proposed changes
  const proposedChanges: (ProposedChange & { import_batch_id: string })[] = [];

  for (const sk of skPersonObjects) {
    const matchResult = autoMatched.get(sk.sk_individual_id);

    if (!matchResult || matchResult.kind === "new" || matchResult.kind === "unresolved") {
      // New person — propose creation + contact fields
      proposedChanges.push({
        ...createPersonChange(sk),
        import_batch_id: batchId,
      });
      // Also add email/phone/address changes pointing at null pco_person_id
      // (they will be applied after the person is created)
      if (sk.email_home) {
        proposedChanges.push({
          import_batch_id: batchId,
          sk_individual_id: sk.sk_individual_id,
          pco_person_id: null,
          change_type: "add_email",
          field_name: "Home",
          old_value: null,
          new_value: JSON.stringify(sk.email_home),
        });
      }
      if (sk.email_work) {
        proposedChanges.push({
          import_batch_id: batchId,
          sk_individual_id: sk.sk_individual_id,
          pco_person_id: null,
          change_type: "add_email",
          field_name: "Work",
          old_value: null,
          new_value: JSON.stringify(sk.email_work),
        });
      }
      if (sk.home_phone) {
        proposedChanges.push({
          import_batch_id: batchId,
          sk_individual_id: sk.sk_individual_id,
          pco_person_id: null,
          change_type: "add_phone",
          field_name: "Home",
          old_value: null,
          new_value: JSON.stringify(sk.home_phone),
        });
      }
      if (sk.cell_phone) {
        proposedChanges.push({
          import_batch_id: batchId,
          sk_individual_id: sk.sk_individual_id,
          pco_person_id: null,
          change_type: "add_phone",
          field_name: "Mobile",
          old_value: null,
          new_value: JSON.stringify(sk.cell_phone),
        });
      }
      if (sk.work_phone) {
        proposedChanges.push({
          import_batch_id: batchId,
          sk_individual_id: sk.sk_individual_id,
          pco_person_id: null,
          change_type: "add_phone",
          field_name: "Work",
          old_value: null,
          new_value: JSON.stringify(sk.work_phone),
        });
      }
      if (sk.address_street) {
        proposedChanges.push({
          import_batch_id: batchId,
          sk_individual_id: sk.sk_individual_id,
          pco_person_id: null,
          change_type: "add_address",
          field_name: "Home",
          old_value: null,
          new_value: JSON.stringify({
            street: sk.address_street,
            city: sk.address_city,
            state: sk.address_state,
            zip: sk.address_zip,
          }),
        });
      }
      continue;
    }

    // Existing person — compute field-level diffs
    const pcoId = matchResult.pco_id;
    const pcoPerson = enrichedPco.find((p) => p.pco_id === pcoId);
    if (!pcoPerson) continue;

    const fieldChanges = diffPersonFields(sk, pcoPerson);
    proposedChanges.push(
      ...fieldChanges.map((fc) => ({ ...fc, import_batch_id: batchId })),
    );

    // Contact diffs
    const [emails, phones, addresses] = await Promise.all([
      getPcoEmails(c.env.DB, pcoId),
      getPcoPhones(c.env.DB, pcoId),
      getPcoAddresses(c.env.DB, pcoId),
    ]);

    const emailChanges = diffEmails(
      sk,
      pcoId,
      emails.map((e) => ({ id: String(e.id), address: e.address, location: e.location })),
    );
    const phoneChanges = diffPhones(
      sk,
      pcoId,
      phones.map((p) => ({ id: String(p.id), number: p.number, location: p.location })),
    );
    const addrChanges = diffAddresses(
      sk,
      pcoId,
      addresses.map((a) => ({
        id: String(a.id),
        street: a.street,
        city: a.city,
        state: a.state,
        zip: a.zip,
        location: a.location,
      })),
    );

    proposedChanges.push(
      ...[...emailChanges, ...phoneChanges, ...addrChanges].map((c2) => ({
        ...c2,
        import_batch_id: batchId,
      })),
    );
  }

  // Store changes in DB
  if (proposedChanges.length > 0) {
    await insertPendingChanges(c.env.DB, proposedChanges);
  }

  await updateBatchStatus(c.env.DB, batchId, "diffed");

  const counts = await countChanges(c.env.DB, batchId);

  return c.json({
    ok: true,
    data: {
      batch_id: batchId,
      total_changes: proposedChanges.length,
      counts,
      unresolved_matches: unresolved.length,
      unresolved,
    },
  });
});
