/**
 * D1 database helper functions.
 * All queries go through these typed wrappers to keep SQL out of route handlers.
 */

import type {
  ImportBatchRow,
  SkPersonRow,
  PcoPersonRow,
  PersonMatchRow,
  PendingChangeRow,
  ChangeStatus,
} from "../types";

// ── Import batches ─────────────────────────────────────────────────────────────

export async function createImportBatch(
  db: D1Database,
  id: string,
  filename: string,
  recordCount: number,
  importedBy: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO import_batches (id, filename, record_count, imported_by)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(id, filename, recordCount, importedBy)
    .run();
}

export async function getBatch(
  db: D1Database,
  id: string,
): Promise<ImportBatchRow | null> {
  return db
    .prepare(`SELECT * FROM import_batches WHERE id = ?`)
    .bind(id)
    .first<ImportBatchRow>();
}

export async function listBatches(db: D1Database): Promise<ImportBatchRow[]> {
  const result = await db
    .prepare(`SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 50`)
    .all<ImportBatchRow>();
  return result.results;
}

export async function updateBatchStatus(
  db: D1Database,
  id: string,
  status: ImportBatchRow["status"],
): Promise<void> {
  await db
    .prepare(
      `UPDATE import_batches SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
    .bind(status, id)
    .run();
}

// ── SK people ─────────────────────────────────────────────────────────────────

export async function insertSkPeople(
  db: D1Database,
  rows: Omit<SkPersonRow, "id" | "created_at">[],
): Promise<void> {
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const stmts = chunk.map((row) =>
      db
        .prepare(
          `INSERT INTO sk_people
             (import_batch_id, sk_individual_id, sk_family_id, first_name, last_name,
              middle_name, preferred_name, gender, birthdate, anniversary, membership,
              marital_status, home_phone, cell_phone, work_phone, email_home, email_work,
              address_street, address_city, address_state, address_zip,
              baptized, baptized_date, include_in_dir, raw_data)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          row.import_batch_id,
          row.sk_individual_id,
          row.sk_family_id,
          row.first_name,
          row.last_name,
          row.middle_name,
          row.preferred_name,
          row.gender,
          row.birthdate,
          row.anniversary,
          row.membership,
          row.marital_status,
          row.home_phone,
          row.cell_phone,
          row.work_phone,
          row.email_home,
          row.email_work,
          row.address_street,
          row.address_city,
          row.address_state,
          row.address_zip,
          row.baptized,
          row.baptized_date,
          row.include_in_dir,
          row.raw_data,
        ),
    );
    await db.batch(stmts);
  }
}

export async function getSkPeopleByBatch(
  db: D1Database,
  batchId: string,
): Promise<SkPersonRow[]> {
  const result = await db
    .prepare(`SELECT * FROM sk_people WHERE import_batch_id = ? ORDER BY last_name, first_name`)
    .bind(batchId)
    .all<SkPersonRow>();
  return result.results;
}

// ── PCO people snapshot ───────────────────────────────────────────────────────

export async function upsertPcoPerson(
  db: D1Database,
  row: Omit<PcoPersonRow, "synced_at">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pco_people
         (pco_id, remote_id, first_name, last_name, middle_name, nickname,
          gender, birthdate, anniversary, membership, marital_status, status, raw_data, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(pco_id) DO UPDATE SET
         remote_id      = excluded.remote_id,
         first_name     = excluded.first_name,
         last_name      = excluded.last_name,
         middle_name    = excluded.middle_name,
         nickname       = excluded.nickname,
         gender         = excluded.gender,
         birthdate      = excluded.birthdate,
         anniversary    = excluded.anniversary,
         membership     = excluded.membership,
         marital_status = excluded.marital_status,
         status         = excluded.status,
         raw_data       = excluded.raw_data,
         synced_at      = CURRENT_TIMESTAMP`,
    )
    .bind(
      row.pco_id,
      row.remote_id,
      row.first_name,
      row.last_name,
      row.middle_name,
      row.nickname,
      row.gender,
      row.birthdate,
      row.anniversary,
      row.membership,
      row.marital_status,
      row.status,
      row.raw_data,
    )
    .run();
}

export async function getAllPcoPeople(db: D1Database): Promise<PcoPersonRow[]> {
  const result = await db
    .prepare(`SELECT * FROM pco_people ORDER BY last_name, first_name`)
    .all<PcoPersonRow>();
  return result.results;
}

export async function getPcoPerson(
  db: D1Database,
  pcoId: string,
): Promise<PcoPersonRow | null> {
  return db
    .prepare(`SELECT * FROM pco_people WHERE pco_id = ?`)
    .bind(pcoId)
    .first<PcoPersonRow>();
}

export async function getPcoEmails(
  db: D1Database,
  pcoId: string,
): Promise<Array<{ id: number; address: string; location: string }>> {
  const result = await db
    .prepare(`SELECT id, address, location FROM pco_emails WHERE pco_id = ?`)
    .bind(pcoId)
    .all<{ id: number; address: string; location: string }>();
  return result.results;
}

export async function getPcoPhones(
  db: D1Database,
  pcoId: string,
): Promise<Array<{ id: number; number: string; location: string }>> {
  const result = await db
    .prepare(`SELECT id, number, location FROM pco_phone_numbers WHERE pco_id = ?`)
    .bind(pcoId)
    .all<{ id: number; number: string; location: string }>();
  return result.results;
}

export async function getPcoAddresses(
  db: D1Database,
  pcoId: string,
): Promise<Array<{ id: number; street: string | null; city: string | null; state: string | null; zip: string | null; location: string }>> {
  const result = await db
    .prepare(`SELECT id, street, city, state, zip, location FROM pco_addresses WHERE pco_id = ?`)
    .bind(pcoId)
    .all<{ id: number; street: string | null; city: string | null; state: string | null; zip: string | null; location: string }>();
  return result.results;
}

export async function getAllPcoEmailsBulk(
  db: D1Database,
): Promise<Map<string, Array<{ id: number; address: string; location: string }>>> {
  const result = await db
    .prepare(`SELECT pco_id, id, address, location FROM pco_emails`)
    .all<{ pco_id: string; id: number; address: string; location: string }>();
  const map = new Map<string, Array<{ id: number; address: string; location: string }>>();
  for (const row of result.results) {
    const arr = map.get(row.pco_id) ?? [];
    arr.push({ id: row.id, address: row.address, location: row.location });
    map.set(row.pco_id, arr);
  }
  return map;
}

export async function getAllPcoPhonesBulk(
  db: D1Database,
): Promise<Map<string, Array<{ id: number; number: string; location: string }>>> {
  const result = await db
    .prepare(`SELECT pco_id, id, number, location FROM pco_phone_numbers`)
    .all<{ pco_id: string; id: number; number: string; location: string }>();
  const map = new Map<string, Array<{ id: number; number: string; location: string }>>();
  for (const row of result.results) {
    const arr = map.get(row.pco_id) ?? [];
    arr.push({ id: row.id, number: row.number, location: row.location });
    map.set(row.pco_id, arr);
  }
  return map;
}

export async function getAllPcoAddressesBulk(
  db: D1Database,
): Promise<Map<string, Array<{ id: number; street: string | null; city: string | null; state: string | null; zip: string | null; location: string }>>> {
  const result = await db
    .prepare(`SELECT pco_id, id, street, city, state, zip, location FROM pco_addresses`)
    .all<{ pco_id: string; id: number; street: string | null; city: string | null; state: string | null; zip: string | null; location: string }>();
  const map = new Map<string, Array<{ id: number; street: string | null; city: string | null; state: string | null; zip: string | null; location: string }>>();
  for (const row of result.results) {
    const arr = map.get(row.pco_id) ?? [];
    arr.push({ id: row.id, street: row.street, city: row.city, state: row.state, zip: row.zip, location: row.location });
    map.set(row.pco_id, arr);
  }
  return map;
}

export async function clearAllPcoContactDetails(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM pco_emails`),
    db.prepare(`DELETE FROM pco_phone_numbers`),
    db.prepare(`DELETE FROM pco_addresses`),
  ]);
}

export async function insertPcoEmail(
  db: D1Database,
  pcoId: string,
  address: string,
  location: string,
  primary: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pco_emails (pco_id, address, location, primary_e) VALUES (?,?,?,?)`,
    )
    .bind(pcoId, address, location, primary ? 1 : 0)
    .run();
}

export async function insertPcoPhone(
  db: D1Database,
  pcoId: string,
  number: string,
  location: string,
  primary: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pco_phone_numbers (pco_id, number, location, primary_p) VALUES (?,?,?,?)`,
    )
    .bind(pcoId, number, location, primary ? 1 : 0)
    .run();
}

export async function insertPcoAddress(
  db: D1Database,
  pcoId: string,
  street: string | null,
  city: string | null,
  state: string | null,
  zip: string | null,
  location: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pco_addresses (pco_id, street, city, state, zip, location) VALUES (?,?,?,?,?,?)`,
    )
    .bind(pcoId, street, city, state, zip, location)
    .run();
}

// ── Person matches ────────────────────────────────────────────────────────────

export async function upsertPersonMatch(
  db: D1Database,
  skId: string,
  pcoId: string,
  confidence: PersonMatchRow["confidence"],
  userConfirmed: boolean,
  confirmedBy: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO person_matches
         (sk_individual_id, pco_person_id, confidence, user_confirmed, confirmed_by)
       VALUES (?,?,?,?,?)
       ON CONFLICT(sk_individual_id) DO UPDATE SET
         pco_person_id  = excluded.pco_person_id,
         confidence     = excluded.confidence,
         user_confirmed = excluded.user_confirmed,
         confirmed_by   = excluded.confirmed_by,
         updated_at     = CURRENT_TIMESTAMP`,
    )
    .bind(skId, pcoId, confidence, userConfirmed ? 1 : 0, confirmedBy)
    .run();
}

export async function getAllPersonMatches(
  db: D1Database,
): Promise<PersonMatchRow[]> {
  const result = await db
    .prepare(`SELECT * FROM person_matches`)
    .all<PersonMatchRow>();
  return result.results;
}

export async function getPersonMatch(
  db: D1Database,
  skId: string,
): Promise<PersonMatchRow | null> {
  return db
    .prepare(`SELECT * FROM person_matches WHERE sk_individual_id = ?`)
    .bind(skId)
    .first<PersonMatchRow>();
}

// ── Pending changes ───────────────────────────────────────────────────────────

export async function insertPendingChanges(
  db: D1Database,
  changes: Omit<PendingChangeRow, "id" | "status" | "reviewed_by" | "reviewed_at" | "applied_at" | "error_message" | "created_at">[],
): Promise<void> {
  const CHUNK = 50;
  for (let i = 0; i < changes.length; i += CHUNK) {
    const chunk = changes.slice(i, i + CHUNK);
    const stmts = chunk.map((c) =>
      db
        .prepare(
          `INSERT INTO pending_changes
             (import_batch_id, sk_individual_id, pco_person_id, change_type,
              field_name, old_value, new_value)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(
          c.import_batch_id,
          c.sk_individual_id,
          c.pco_person_id,
          c.change_type,
          c.field_name,
          c.old_value,
          c.new_value,
        ),
    );
    await db.batch(stmts);
  }
}

export async function getPendingChanges(
  db: D1Database,
  batchId: string,
  status?: ChangeStatus,
): Promise<PendingChangeRow[]> {
  const sql = status
    ? `SELECT * FROM pending_changes WHERE import_batch_id = ? AND status = ? ORDER BY id`
    : `SELECT * FROM pending_changes WHERE import_batch_id = ? ORDER BY id`;
  const stmt = status
    ? db.prepare(sql).bind(batchId, status)
    : db.prepare(sql).bind(batchId);
  const result = await stmt.all<PendingChangeRow>();
  return result.results;
}

export async function getChange(
  db: D1Database,
  id: number,
): Promise<PendingChangeRow | null> {
  return db
    .prepare(`SELECT * FROM pending_changes WHERE id = ?`)
    .bind(id)
    .first<PendingChangeRow>();
}

export async function updateChangeStatus(
  db: D1Database,
  id: number,
  status: ChangeStatus,
  reviewedBy: string | null,
  opts?: { pcoPersonId?: string; errorMessage?: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE pending_changes SET
         status        = ?,
         reviewed_by   = ?,
         reviewed_at   = ?,
         applied_at    = CASE WHEN ? = 'applied' THEN ? ELSE applied_at END,
         pco_person_id = COALESCE(?, pco_person_id),
         error_message = COALESCE(?, error_message)
       WHERE id = ?`,
    )
    .bind(
      status,
      reviewedBy,
      now,
      status,
      now,
      opts?.pcoPersonId ?? null,
      opts?.errorMessage ?? null,
      id,
    )
    .run();
}

export async function bulkApproveChanges(
  db: D1Database,
  batchId: string,
  reviewedBy: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_changes
       SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE import_batch_id = ? AND status = 'pending'`,
    )
    .bind(reviewedBy, batchId)
    .run();
}

export async function bulkRejectChanges(
  db: D1Database,
  batchId: string,
  reviewedBy: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_changes
       SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE import_batch_id = ? AND status = 'pending'`,
    )
    .bind(reviewedBy, batchId)
    .run();
}

export async function getApprovedChanges(
  db: D1Database,
  batchId: string,
): Promise<PendingChangeRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM pending_changes
       WHERE import_batch_id = ? AND status = 'approved'
       ORDER BY id`,
    )
    .bind(batchId)
    .all<PendingChangeRow>();
  return result.results;
}

export async function countChanges(
  db: D1Database,
  batchId: string,
): Promise<Record<ChangeStatus, number>> {
  const result = await db
    .prepare(
      `SELECT status, COUNT(*) as cnt FROM pending_changes WHERE import_batch_id = ? GROUP BY status`,
    )
    .bind(batchId)
    .all<{ status: string; cnt: number }>();

  const counts: Record<string, number> = {};
  for (const row of result.results) counts[row.status] = row.cnt;
  return counts as Record<ChangeStatus, number>;
}
