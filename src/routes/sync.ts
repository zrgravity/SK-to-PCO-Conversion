/**
 * POST /api/sync
 * Fetches ONE PAGE of people from PCO and stores them in D1.
 * Call repeatedly with ?offset=N until the response has done=true.
 *
 * This paginated design keeps each Worker invocation well under Cloudflare's
 * per-invocation D1 request limit (which counts every statement in a batch).
 *
 * Query params:
 *   ?offset=N   — start offset (default 0). On offset=0 contact tables are
 *                 wiped so re-sync starts clean.
 *   ?quick=1    — skip contact details (people fields only)
 *   ?per_page=N — page size (default 100, max 100)
 */

import { Hono } from "hono";
import { PcoClient } from "../pco/client";
import {
  clearAllPcoContactDetails,
} from "../db/queries";
import type { Env } from "../types";

export const syncRoute = new Hono<{ Bindings: Env }>();

/** POST /api/sync — pull ONE PAGE of PCO people into D1 */
syncRoute.post("/", async (c) => {
  const quick = c.req.query("quick") === "1";
  const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);
  const perPage = Math.min(100, Math.max(1, parseInt(c.req.query("per_page") ?? "100", 10) || 100));
  const pco = new PcoClient(c.env.PCO_APP_ID, c.env.PCO_APP_SECRET);

  let synced = 0;
  let failed = 0;

  // On the first page, wipe contact tables so re-sync starts clean.
  // Subsequent pages just append — contacts were already cleared on page 0.
  if (!quick && offset === 0) {
    await clearAllPcoContactDetails(c.env.DB);
  }

  if (!quick) {
    // Sideload contacts in the same page request → 1 PCO call for this page
    let page;
    try {
      page = await pco.getPeoplePageWithContacts(offset, perPage);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502);
    }

    // Prepare SQL templates ONCE outside the loop.
    // db.prepare() makes a D1 API request each time it is called; calling it
    // once per person would burn hundreds of subrequests before any data is
    // written. db.bind() is a local operation — no network call.
    const stmtPerson = c.env.DB.prepare(
      `INSERT INTO pco_people
         (pco_id, remote_id, first_name, last_name, middle_name, nickname,
          gender, birthdate, anniversary, membership, marital_status, status, raw_data, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(pco_id) DO UPDATE SET
         remote_id = excluded.remote_id, first_name = excluded.first_name,
         last_name = excluded.last_name, middle_name = excluded.middle_name,
         nickname = excluded.nickname, gender = excluded.gender,
         birthdate = excluded.birthdate, anniversary = excluded.anniversary,
         membership = excluded.membership, marital_status = excluded.marital_status,
         status = excluded.status, raw_data = excluded.raw_data,
         synced_at = CURRENT_TIMESTAMP`,
    );
    const stmtEmail   = c.env.DB.prepare(`INSERT INTO pco_emails (pco_id, address, location, primary_e) VALUES (?,?,?,?)`);
    const stmtPhone   = c.env.DB.prepare(`INSERT INTO pco_phone_numbers (pco_id, number, location, primary_p) VALUES (?,?,?,?)`);
    const stmtAddress = c.env.DB.prepare(`INSERT INTO pco_addresses (pco_id, street, city, state, zip, location) VALUES (?,?,?,?,?,?)`);

    // Build all D1 bound statements for this page (no network calls here)
    const stmts: ReturnType<D1Database["prepare"]>[] = [];

    for (const person of page.people) {
      try {
        const attrs = person.attributes;
        stmts.push(stmtPerson.bind(
          person.id, attrs.remote_id ?? null, attrs.first_name ?? null,
          attrs.last_name ?? null, attrs.middle_name ?? null, attrs.nickname ?? null,
          attrs.gender ?? null, attrs.birthdate ?? null, attrs.anniversary ?? null,
          attrs.membership ?? null, attrs.marital_status ?? null, attrs.status ?? null,
          JSON.stringify(person),
        ));

        for (const e of page.emailMap.get(person.id) ?? []) {
          stmts.push(stmtEmail.bind(person.id, e.address, e.location, e.primary ? 1 : 0));
        }
        for (const p of page.phoneMap.get(person.id) ?? []) {
          stmts.push(stmtPhone.bind(person.id, p.number, p.location, p.primary ? 1 : 0));
        }
        for (const a of page.addressMap.get(person.id) ?? []) {
          stmts.push(stmtAddress.bind(person.id, a.street, a.city, a.state, a.zip, a.location));
        }

        synced++;
      } catch (err) {
        console.error(`Failed to build statements for person ${person.id}:`, String(err));
        failed++;
      }
    }

    // Execute all inserts for this page as a single D1 batch.
    // Cloudflare allows up to 100 statements per batch call.
    const BATCH_SIZE = 100;
    for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
      await c.env.DB.batch(stmts.slice(i, i + BATCH_SIZE));
    }

    return c.json({
      ok: true,
      data: {
        synced,
        failed,
        quick,
        offset,
        nextOffset: page.hasMore ? page.nextOffset : null,
        done: !page.hasMore,
      },
    });

  } else {
    // Quick mode — people fields only, no contacts
    let page;
    try {
      page = await pco.getPeoplePage(offset, perPage);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502);
    }

    // Prepare once outside the loop — same reason as full-sync mode above.
    const stmtPerson = c.env.DB.prepare(
      `INSERT INTO pco_people
         (pco_id, remote_id, first_name, last_name, middle_name, nickname,
          gender, birthdate, anniversary, membership, marital_status, status, raw_data, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(pco_id) DO UPDATE SET
         remote_id = excluded.remote_id, first_name = excluded.first_name,
         last_name = excluded.last_name, middle_name = excluded.middle_name,
         nickname = excluded.nickname, gender = excluded.gender,
         birthdate = excluded.birthdate, anniversary = excluded.anniversary,
         membership = excluded.membership, marital_status = excluded.marital_status,
         status = excluded.status, raw_data = excluded.raw_data,
         synced_at = CURRENT_TIMESTAMP`,
    );

    const stmts: ReturnType<D1Database["prepare"]>[] = [];
    for (const person of page.data) {
      try {
        const a = person.attributes;
        stmts.push(stmtPerson.bind(
          person.id, a.remote_id ?? null, a.first_name ?? null,
          a.last_name ?? null, a.middle_name ?? null, a.nickname ?? null,
          a.gender ?? null, a.birthdate ?? null, a.anniversary ?? null,
          a.membership ?? null, a.marital_status ?? null, a.status ?? null,
          JSON.stringify(person),
        ));
        synced++;
      } catch (err) {
        console.error(`Failed to build statement for person ${person.id}:`, String(err));
        failed++;
      }
    }

    const BATCH_SIZE = 100;
    for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
      await c.env.DB.batch(stmts.slice(i, i + BATCH_SIZE));
    }

    const hasMore = !!page.meta.next;
    return c.json({
      ok: true,
      data: {
        synced,
        failed,
        quick,
        offset,
        nextOffset: hasMore ? page.meta.next!.offset : null,
        done: !hasMore,
      },
    });
  }
});

/** GET /api/sync — show last sync stats */
syncRoute.get("/", async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT COUNT(*) as total, MAX(synced_at) as last_sync FROM pco_people`,
  ).first<{ total: number; last_sync: string | null }>();

  return c.json({
    ok: true,
    data: result ?? { total: 0, last_sync: null },
  });
});
