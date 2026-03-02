/**
 * POST /api/sync
 * Fetches all people from PCO and stores a snapshot in D1.
 * This can take a while for large organisations; it streams progress via SSE
 * or returns a summary on completion.
 *
 * Query params:
 *   ?quick=1  — skip per-person detail fetch (emails/phones/addresses)
 *              Use this for large orgs when you only need to refresh person records.
 */

import { Hono } from "hono";
import { PcoClient } from "../pco/client";
import {
  upsertPcoPerson,
  clearAllPcoContactDetails,
} from "../db/queries";
import type { Env } from "../types";

export const syncRoute = new Hono<{ Bindings: Env }>();

/** POST /api/sync — pull PCO snapshot into D1 */
syncRoute.post("/", async (c) => {
  const quick = c.req.query("quick") === "1";
  const pco = new PcoClient(c.env.PCO_APP_ID, c.env.PCO_APP_SECRET);

  let synced = 0;
  let failed = 0;

  if (!quick) {
    // Clear all contact details once upfront so we can re-insert cleanly.
    // Doing this per-person would be O(N) D1 round trips; once is O(1).
    await clearAllPcoContactDetails(c.env.DB);
  }

  let offset = 0;
  const perPage = 100;

  while (true) {
    if (!quick) {
      // Sideload contacts in the same page request → 1 PCO call per page
      // instead of 1 + N*3 PCO calls per page.
      let page;
      try {
        page = await pco.getPeoplePageWithContacts(offset, perPage);
      } catch (err) {
        console.error(`Failed to fetch people page at offset ${offset}:`, err);
        break;
      }

      // Collect D1 statements for this whole page and run as a single batch
      const stmts: ReturnType<D1Database["prepare"]>[] = [];

      for (const person of page.people) {
        try {
          const attrs = person.attributes;
          stmts.push(
            c.env.DB
              .prepare(
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
              )
              .bind(
                person.id, attrs.remote_id ?? null, attrs.first_name ?? null,
                attrs.last_name ?? null, attrs.middle_name ?? null, attrs.nickname ?? null,
                attrs.gender ?? null, attrs.birthdate ?? null, attrs.anniversary ?? null,
                attrs.membership ?? null, attrs.marital_status ?? null, attrs.status ?? null,
                JSON.stringify(person),
              ),
          );

          for (const e of page.emailMap.get(person.id) ?? []) {
            stmts.push(
              c.env.DB.prepare(`INSERT INTO pco_emails (pco_id, address, location, primary_e) VALUES (?,?,?,?)`)
                .bind(person.id, e.address, e.location, e.primary ? 1 : 0),
            );
          }
          for (const p of page.phoneMap.get(person.id) ?? []) {
            stmts.push(
              c.env.DB.prepare(`INSERT INTO pco_phone_numbers (pco_id, number, location, primary_p) VALUES (?,?,?,?)`)
                .bind(person.id, p.number, p.location, p.primary ? 1 : 0),
            );
          }
          for (const a of page.addressMap.get(person.id) ?? []) {
            stmts.push(
              c.env.DB.prepare(`INSERT INTO pco_addresses (pco_id, street, city, state, zip, location) VALUES (?,?,?,?,?,?)`)
                .bind(person.id, a.street, a.city, a.state, a.zip, a.location),
            );
          }

          synced++;
        } catch (err) {
          console.error(`Failed to build statements for person ${person.id}:`, err);
          failed++;
        }
      }

      // Execute all inserts for this page in a single D1 batch
      const BATCH_SIZE = 100;
      for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
        await c.env.DB.batch(stmts.slice(i, i + BATCH_SIZE));
      }

      if (!page.hasMore) break;
      offset = page.nextOffset;

    } else {
      // Quick mode — people fields only, no contacts
      let page;
      try {
        page = await pco.getPeoplePage(offset, perPage);
      } catch (err) {
        console.error(`Failed to fetch people page at offset ${offset}:`, err);
        break;
      }

      for (const person of page.data) {
        try {
          await upsertPcoPerson(c.env.DB, {
            pco_id: person.id,
            remote_id: person.attributes.remote_id ?? null,
            first_name: person.attributes.first_name ?? null,
            last_name: person.attributes.last_name ?? null,
            middle_name: person.attributes.middle_name ?? null,
            nickname: person.attributes.nickname ?? null,
            gender: person.attributes.gender ?? null,
            birthdate: person.attributes.birthdate ?? null,
            anniversary: person.attributes.anniversary ?? null,
            membership: person.attributes.membership ?? null,
            marital_status: person.attributes.marital_status ?? null,
            status: person.attributes.status ?? null,
            raw_data: JSON.stringify(person),
          });
          synced++;
        } catch (err) {
          console.error(`Failed to sync person ${person.id}:`, err);
          failed++;
        }
      }

      if (!page.meta.next) break;
      offset = page.meta.next.offset;
    }
  }

  return c.json({
    ok: true,
    data: {
      synced,
      failed,
      quick,
      synced_at: new Date().toISOString(),
    },
  });
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
