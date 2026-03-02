/**
 * Review routes — approve, reject, bulk-approve, bulk-reject individual changes.
 *
 * POST /api/review/:changeId/approve
 * POST /api/review/:changeId/reject
 * POST /api/review/batch/:batchId/approve-all
 * POST /api/review/batch/:batchId/reject-all
 */

import { Hono } from "hono";
import {
  getChange,
  updateChangeStatus,
  bulkApproveChanges,
  bulkRejectChanges,
  bulkRejectByField,
  getBatch,
} from "../db/queries";
import type { Env } from "../types";

export const reviewRoute = new Hono<{ Bindings: Env }>();

const getUserEmail = (c: { req: { header: (name: string) => string | undefined } }) =>
  c.req.header("CF-Access-Authenticated-User-Email") ?? null;

/** Approve a single change */
reviewRoute.post("/:changeId/approve", async (c) => {
  const changeId = parseInt(c.req.param("changeId"), 10);
  const change = await getChange(c.env.DB, changeId);
  if (!change) return c.json({ ok: false, error: "Change not found" }, 404);
  if (change.status !== "pending") {
    return c.json(
      { ok: false, error: `Change is already ${change.status}` },
      409,
    );
  }
  await updateChangeStatus(c.env.DB, changeId, "approved", getUserEmail(c));
  return c.json({ ok: true, data: { id: changeId, status: "approved" } });
});

/** Reject a single change */
reviewRoute.post("/:changeId/reject", async (c) => {
  const changeId = parseInt(c.req.param("changeId"), 10);
  const change = await getChange(c.env.DB, changeId);
  if (!change) return c.json({ ok: false, error: "Change not found" }, 404);
  if (change.status !== "pending") {
    return c.json(
      { ok: false, error: `Change is already ${change.status}` },
      409,
    );
  }
  await updateChangeStatus(c.env.DB, changeId, "rejected", getUserEmail(c));
  return c.json({ ok: true, data: { id: changeId, status: "rejected" } });
});

/** Revert an approved/rejected change back to pending */
reviewRoute.post("/:changeId/reset", async (c) => {
  const changeId = parseInt(c.req.param("changeId"), 10);
  const change = await getChange(c.env.DB, changeId);
  if (!change) return c.json({ ok: false, error: "Change not found" }, 404);
  if (change.status === "applied") {
    return c.json(
      { ok: false, error: "Cannot reset an already-applied change" },
      409,
    );
  }
  await updateChangeStatus(c.env.DB, changeId, "pending", null);
  return c.json({ ok: true, data: { id: changeId, status: "pending" } });
});

/** Bulk-approve all pending changes in a batch */
reviewRoute.post("/batch/:batchId/approve-all", async (c) => {
  const batchId = c.req.param("batchId");
  const batch = await getBatch(c.env.DB, batchId);
  if (!batch) return c.json({ ok: false, error: "Batch not found" }, 404);
  await bulkApproveChanges(c.env.DB, batchId, getUserEmail(c));
  return c.json({ ok: true, data: { batch_id: batchId, action: "approve-all" } });
});

/** Bulk-reject all pending changes in a batch */
reviewRoute.post("/batch/:batchId/reject-all", async (c) => {
  const batchId = c.req.param("batchId");
  const batch = await getBatch(c.env.DB, batchId);
  if (!batch) return c.json({ ok: false, error: "Batch not found" }, 404);
  await bulkRejectChanges(c.env.DB, batchId, getUserEmail(c));
  return c.json({ ok: true, data: { batch_id: batchId, action: "reject-all" } });
});

/** Bulk-reject all pending update_field changes for a specific field (e.g. marital_status) */
reviewRoute.post("/batch/:batchId/reject-field/:fieldName", async (c) => {
  const batchId = c.req.param("batchId");
  const fieldName = c.req.param("fieldName");
  const batch = await getBatch(c.env.DB, batchId);
  if (!batch) return c.json({ ok: false, error: "Batch not found" }, 404);
  const rejected = await bulkRejectByField(c.env.DB, batchId, fieldName, getUserEmail(c));
  return c.json({ ok: true, data: { batch_id: batchId, field: fieldName, rejected } });
});
