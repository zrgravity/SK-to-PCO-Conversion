/**
 * POST /api/diff/:batchId?offset=N
 * Computes differences for ONE PAGE of SK people against the PCO snapshot.
 * Call repeatedly with offset=nextOffset until done=true.
 *
 * On offset=0 any previous pending_changes for this batch are cleared so the
 * diff can be re-run cleanly (e.g. after user confirms unresolved matches).
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
  getAllPcoPeopleLight,
  getAllPersonMatches,
  getSkPeopleByBatchPage,
  getPcoContactsForPcoIds,
  clearPendingChangesForBatch,
  batchUpsertPersonMatches,
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

/** POST /api/diff/:batchId — compute and store diffs (one page per call) */
diffRoute.post("/:batchId", async (c) => {
  const batchId = c.req.param("batchId");
  const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);
  const perPage = Math.min(100, Math.max(1, parseInt(c.req.query("per_page") ?? "100", 10) || 100));

  const batch = await getBatch(c.env.DB, batchId);
  if (!batch) return c.json({ ok: false, error: "Batch not found" }, 404);

  // On the first page, wipe stale pending_changes so re-runs start fresh.
  if (offset === 0) {
    await clearPendingChangesForBatch(c.env.DB, batchId);
  }

  // ── Load data for this page ──────────────────────────────────────────────
  // Four parallel queries; PcoPersonLight omits raw_data → much less CPU/memory.
  const [allPco, allMatches, allPcoEmailsRaw, skPage] = await Promise.all([
    getAllPcoPeopleLight(c.env.DB),
    getAllPersonMatches(c.env.DB),
    c.env.DB
      .prepare(`SELECT pco_id, address FROM pco_emails`)
      .all<{ pco_id: string; address: string }>(),
    getSkPeopleByBatchPage(c.env.DB, batchId, offset, perPage),
  ]);

  if (allPco.length === 0) {
    return c.json(
      { ok: false, error: "PCO snapshot is empty. Run POST /api/sync first." },
      400,
    );
  }

  // Empty page → we've processed everyone; signal done.
  if (skPage.length === 0) {
    return c.json({
      ok: true,
      data: { batch_id: batchId, changes_this_page: 0, unresolved_matches: 0, unresolved: [], offset, nextOffset: null, done: true },
    });
  }

  // ── Build lookup structures ──────────────────────────────────────────────
  const confirmedMap = new Map(
    allMatches.map((m) => [
      m.sk_individual_id,
      { pco_id: m.pco_person_id, confidence: m.confidence },
    ]),
  );

  const emailsByPcoId = new Map<string, string[]>();
  for (const row of allPcoEmailsRaw.results) {
    const arr = emailsByPcoId.get(row.pco_id) ?? [];
    arr.push(row.address);
    emailsByPcoId.set(row.pco_id, arr);
  }

  const enrichedPco = allPco.map((p) => ({
    ...p,
    emails: emailsByPcoId.get(p.pco_id) ?? [],
  }));
  const pcoById = new Map(enrichedPco.map((p) => [p.pco_id, p]));

  // ── Convert SK rows → SkPerson objects ───────────────────────────────────
  const skPersonObjects = skPage.map((row) => ({
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

  // ── Match this page ──────────────────────────────────────────────────────
  const matcher = new PersonMatcher();
  const { autoMatched, unresolved } = matcher.matchAll(
    skPersonObjects,
    confirmedMap,
    enrichedPco,
  );

  // Batch-upsert auto-matches (1 db.batch call instead of O(N) awaits)
  const matchesToPersist: Array<{
    skId: string;
    pcoId: string;
    confidence: import("../types").PersonMatchRow["confidence"];
    userConfirmed: boolean;
    confirmedBy: null;
  }> = [];
  for (const [skId, result] of autoMatched) {
    if (result.kind === "confirmed" || result.kind === "strong") {
      matchesToPersist.push({
        skId,
        pcoId: result.pco_id,
        confidence: result.confidence as import("../types").PersonMatchRow["confidence"],
        userConfirmed: result.kind === "confirmed",
        confirmedBy: null,
      });
    }
  }
  await batchUpsertPersonMatches(c.env.DB, matchesToPersist);

  // ── Load contacts only for matched PCO IDs on this page ─────────────────
  // WHERE IN (up to 100 IDs) — far cheaper than loading all 5000+ contact rows.
  const matchedPcoIds = [
    ...new Set(
      [...autoMatched.values()]
        .filter((r) => r.kind !== "new" && r.kind !== "unresolved")
        .map((r) => r.pco_id),
    ),
  ];
  const { emailMap, phoneMap, addressMap } = await getPcoContactsForPcoIds(
    c.env.DB,
    matchedPcoIds,
  );

  // ── Build proposed changes ───────────────────────────────────────────────
  const proposedChanges: (ProposedChange & { import_batch_id: string })[] = [];

  for (const sk of skPersonObjects) {
    const matchResult = autoMatched.get(sk.sk_individual_id);

    if (!matchResult || matchResult.kind === "new" || matchResult.kind === "unresolved") {
      proposedChanges.push({ ...createPersonChange(sk), import_batch_id: batchId });
      if (sk.email_home) proposedChanges.push({ import_batch_id: batchId, sk_individual_id: sk.sk_individual_id, pco_person_id: null, change_type: "add_email", field_name: "Home", old_value: null, new_value: JSON.stringify(sk.email_home) });
      if (sk.email_work) proposedChanges.push({ import_batch_id: batchId, sk_individual_id: sk.sk_individual_id, pco_person_id: null, change_type: "add_email", field_name: "Work", old_value: null, new_value: JSON.stringify(sk.email_work) });
      if (sk.home_phone) proposedChanges.push({ import_batch_id: batchId, sk_individual_id: sk.sk_individual_id, pco_person_id: null, change_type: "add_phone", field_name: "Home", old_value: null, new_value: JSON.stringify(sk.home_phone) });
      if (sk.cell_phone) proposedChanges.push({ import_batch_id: batchId, sk_individual_id: sk.sk_individual_id, pco_person_id: null, change_type: "add_phone", field_name: "Mobile", old_value: null, new_value: JSON.stringify(sk.cell_phone) });
      if (sk.work_phone) proposedChanges.push({ import_batch_id: batchId, sk_individual_id: sk.sk_individual_id, pco_person_id: null, change_type: "add_phone", field_name: "Work", old_value: null, new_value: JSON.stringify(sk.work_phone) });
      if (sk.address_street) proposedChanges.push({ import_batch_id: batchId, sk_individual_id: sk.sk_individual_id, pco_person_id: null, change_type: "add_address", field_name: "Home", old_value: null, new_value: JSON.stringify({ street: sk.address_street, city: sk.address_city, state: sk.address_state, zip: sk.address_zip }) });
      continue;
    }

    // Existing person — compute field-level diffs
    const pcoId = matchResult.pco_id;
    const pcoPerson = pcoById.get(pcoId);
    if (!pcoPerson) continue;

    const fieldChanges = diffPersonFields(sk, pcoPerson);
    proposedChanges.push(...fieldChanges.map((fc) => ({ ...fc, import_batch_id: batchId })));

    const emails   = emailMap.get(pcoId)   ?? [];
    const phones   = phoneMap.get(pcoId)   ?? [];
    const addresses = addressMap.get(pcoId) ?? [];

    proposedChanges.push(
      ...[
        ...diffEmails(sk, pcoId, emails.map((e) => ({ id: String(e.id), address: e.address, location: e.location }))),
        ...diffPhones(sk, pcoId, phones.map((p) => ({ id: String(p.id), number: p.number, location: p.location }))),
        ...diffAddresses(sk, pcoId, addresses.map((a) => ({ id: String(a.id), street: a.street, city: a.city, state: a.state, zip: a.zip, location: a.location }))),
      ].map((c2) => ({ ...c2, import_batch_id: batchId })),
    );
  }

  // ── Persist changes ──────────────────────────────────────────────────────
  await insertPendingChanges(c.env.DB, proposedChanges);

  // ── Pagination / done signal ─────────────────────────────────────────────
  // Fewer rows than requested → this is the last page.
  const done = skPage.length < perPage;
  const nextOffset = done ? null : offset + skPage.length;

  if (done) {
    await updateBatchStatus(c.env.DB, batchId, "diffed");
  }

  return c.json({
    ok: true,
    data: {
      batch_id: batchId,
      changes_this_page: proposedChanges.length,
      unresolved_matches: unresolved.length,
      unresolved: unresolved as UnresolvedMatch[],
      offset,
      nextOffset,
      done,
    },
  });
});
