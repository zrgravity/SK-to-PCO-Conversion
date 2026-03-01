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
  insertPcoEmail,
  insertPcoPhone,
  insertPcoAddress,
  clearPcoContactDetails,
} from "../db/queries";
import type { Env } from "../types";

export const syncRoute = new Hono<{ Bindings: Env }>();

/** POST /api/sync — pull PCO snapshot into D1 */
syncRoute.post("/", async (c) => {
  const quick = c.req.query("quick") === "1";
  const pco = new PcoClient(c.env.PCO_APP_ID, c.env.PCO_APP_SECRET);

  let synced = 0;
  let failed = 0;

  for await (const person of pco.getAllPeople()) {
    try {
      const attrs = person.attributes;
      await upsertPcoPerson(c.env.DB, {
        pco_id: person.id,
        remote_id: attrs.remote_id ?? null,
        first_name: attrs.first_name ?? null,
        last_name: attrs.last_name ?? null,
        middle_name: attrs.middle_name ?? null,
        nickname: attrs.nickname ?? null,
        gender: attrs.gender ?? null,
        birthdate: attrs.birthdate ?? null,
        anniversary: attrs.anniversary ?? null,
        membership: attrs.membership ?? null,
        marital_status: attrs.marital_status ?? null,
        status: attrs.status ?? null,
        raw_data: JSON.stringify(person),
      });

      if (!quick) {
        // Fetch and store contact details
        await clearPcoContactDetails(c.env.DB, person.id);

        const [emails, phones, addresses] = await Promise.all([
          pco.getEmails(person.id),
          pco.getPhoneNumbers(person.id),
          pco.getAddresses(person.id),
        ]);

        for (const e of emails) {
          await insertPcoEmail(
            c.env.DB,
            person.id,
            e.attributes.address,
            e.attributes.location,
            e.attributes.primary,
          );
        }
        for (const p of phones) {
          await insertPcoPhone(
            c.env.DB,
            person.id,
            p.attributes.number,
            p.attributes.location,
            p.attributes.primary,
          );
        }
        for (const a of addresses) {
          await insertPcoAddress(
            c.env.DB,
            person.id,
            a.attributes.street ?? null,
            a.attributes.city ?? null,
            a.attributes.state ?? null,
            a.attributes.zip ?? null,
            a.attributes.location,
          );
        }
      }

      synced++;
    } catch (err) {
      console.error(`Failed to sync person ${person.id}:`, err);
      failed++;
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
