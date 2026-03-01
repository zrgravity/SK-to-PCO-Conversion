/**
 * Matches routes — view and manually set SK → PCO person associations.
 *
 * GET  /api/matches         — list all stored matches
 * GET  /api/matches/:skId   — get match for a specific SK individual
 * POST /api/matches         — manually confirm or create a match
 * DELETE /api/matches/:skId — remove a match (will need re-matching next diff)
 */

import { Hono } from "hono";
import {
  getAllPersonMatches,
  getPersonMatch,
  upsertPersonMatch,
} from "../db/queries";
import type { Env } from "../types";

export const matchesRoute = new Hono<{ Bindings: Env }>();

matchesRoute.get("/", async (c) => {
  const matches = await getAllPersonMatches(c.env.DB);
  return c.json({ ok: true, data: matches });
});

matchesRoute.get("/:skId", async (c) => {
  const match = await getPersonMatch(c.env.DB, c.req.param("skId"));
  if (!match) return c.json({ ok: false, error: "No match found" }, 404);
  return c.json({ ok: true, data: match });
});

/** Manually confirm a match: { sk_individual_id, pco_person_id } */
matchesRoute.post("/", async (c) => {
  const userEmail = c.req.header("CF-Access-Authenticated-User-Email") ?? null;
  const body = await c.req.json<{ sk_individual_id: string; pco_person_id: string }>();

  if (!body.sk_individual_id || !body.pco_person_id) {
    return c.json({ ok: false, error: "sk_individual_id and pco_person_id are required" }, 400);
  }

  await upsertPersonMatch(
    c.env.DB,
    body.sk_individual_id,
    body.pco_person_id,
    "manual",
    true,
    userEmail,
  );

  return c.json({
    ok: true,
    data: {
      sk_individual_id: body.sk_individual_id,
      pco_person_id: body.pco_person_id,
      confidence: "manual",
    },
  });
});

/** Remove a match */
matchesRoute.delete("/:skId", async (c) => {
  const skId = c.req.param("skId");
  await c.env.DB.prepare(
    `DELETE FROM person_matches WHERE sk_individual_id = ?`,
  )
    .bind(skId)
    .run();
  return c.json({ ok: true, data: { deleted: skId } });
});
