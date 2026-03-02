/**
 * SK → PCO Cloudflare Worker
 * Main entry point — mounts all API routes under /api/* and serves the UI.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { importRoute } from "./routes/import";
import { syncRoute } from "./routes/sync";
import { diffRoute } from "./routes/diff";
import { reviewRoute } from "./routes/review";
import { applyRoute } from "./routes/apply";
import { matchesRoute } from "./routes/matches";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

// ── CORS (restrict to same origin in production) ───────────────────────────
app.use("/api/*", cors());

// ── Auth middleware ─────────────────────────────────────────────────────────
// Cloudflare Access headers are trusted; additional JWT verification is done
// here when CF_ACCESS_AUD is set.
app.use("/api/*", async (c, next) => {
  const aud = c.env.CF_ACCESS_AUD;
  if (!aud) {
    // Local dev — skip verification
    return next();
  }

  const jwt = c.req.header("CF-Access-Jwt-Assertion");
  if (!jwt) {
    return c.json({ ok: false, error: "Missing CF Access token" }, 401);
  }

  // Verify audience claim in the JWT without a library dependency
  try {
    const [, payloadB64] = jwt.split(".");
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;

    const audClaim = payload.aud;
    const audList = Array.isArray(audClaim) ? audClaim : [audClaim];
    if (!audList.includes(aud)) {
      return c.json({ ok: false, error: "Invalid audience" }, 401);
    }
  } catch {
    return c.json({ ok: false, error: "Invalid token" }, 401);
  }

  return next();
});

// ── API routes ──────────────────────────────────────────────────────────────
app.route("/api/import", importRoute);
app.route("/api/sync", syncRoute);
app.route("/api/diff", diffRoute);
app.route("/api/review", reviewRoute);
app.route("/api/apply", applyRoute);
app.route("/api/matches", matchesRoute);

// ── Health check ────────────────────────────────────────────────────────────
app.get("/api/health", (c) => {
  return c.json({
    ok: true,
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
});

// ── TEMP: full database wipe ─────────────────────────────────────────────────
// Remove this route after the one-time reset is done.
app.post("/api/admin/reset-db", async (c) => {
  if (c.req.query("confirm") !== "yes") {
    return c.json({ ok: false, error: "Pass ?confirm=yes to proceed" }, 400);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM pending_changes"),
    c.env.DB.prepare("DELETE FROM person_matches"),
    c.env.DB.prepare("DELETE FROM pco_household_members"),
    c.env.DB.prepare("DELETE FROM pco_households"),
    c.env.DB.prepare("DELETE FROM pco_addresses"),
    c.env.DB.prepare("DELETE FROM pco_phone_numbers"),
    c.env.DB.prepare("DELETE FROM pco_emails"),
    c.env.DB.prepare("DELETE FROM pco_people"),
    c.env.DB.prepare("DELETE FROM sk_people"),
    c.env.DB.prepare("DELETE FROM import_batches"),
  ]);
  return c.json({ ok: true, message: "All tables cleared." });
});

// ── 404 for unmatched API calls ─────────────────────────────────────────────
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ ok: false, error: "Not found" }, 404);
  }
  // All other paths are handled by the static assets directory (public/)
  return c.text("Not found", 404);
});

export default app;
