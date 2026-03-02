/**
 * POST /api/import
 * Accepts a multipart form with a CSV file from Servant Keeper.
 * Parses it, stores the people in D1, returns batch info + any parse errors.
 */

import { Hono } from "hono";
import { parseSkExport, detectCsvHeaders } from "../sk/parser";
import {
  createImportBatch,
  insertSkPeople,
  listBatches,
  getBatch,
} from "../db/queries";
import type { Env } from "../types";

export const importRoute = new Hono<{ Bindings: Env }>();

/** GET /api/import — list recent import batches */
importRoute.get("/", async (c) => {
  const batches = await listBatches(c.env.DB);
  return c.json({ ok: true, data: batches });
});

/** GET /api/import/:batchId — get info about a specific batch */
importRoute.get("/:batchId", async (c) => {
  const batch = await getBatch(c.env.DB, c.req.param("batchId"));
  if (!batch) return c.json({ ok: false, error: "Batch not found" }, 404);
  return c.json({ ok: true, data: batch });
});

/** Decode a File/Blob buffer handling UTF-16 LE/BE and UTF-8 BOMs (SK exports from Windows). */
async function decodeCsvFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer, 0, 4);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
    // UTF-16 LE BOM — common from SK Windows export / Excel "Save As CSV UTF-16"
    return new TextDecoder("utf-16le").decode(buffer);
  }
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
    // UTF-16 BE BOM
    return new TextDecoder("utf-16be").decode(buffer);
  }
  // UTF-8 (parser already strips UTF-8 BOM \uFEFF)
  return new TextDecoder("utf-8").decode(buffer);
}

/** POST /api/import — upload a SK CSV file */
importRoute.post("/", async (c) => {
  const userEmail = c.req.header("CF-Access-Authenticated-User-Email") ?? null;

  let csvText: string;
  let filename = "upload.csv";

  const contentType = c.req.header("Content-Type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!file || typeof file === "string") {
      return c.json({ ok: false, error: "No file provided in form field 'file'" }, 400);
    }
    filename = (file as File).name || filename;
    csvText = await decodeCsvFile(file as File);
  } else {
    // Fallback: raw CSV body
    csvText = await c.req.text();
  }

  if (!csvText.trim()) {
    return c.json({ ok: false, error: "Empty CSV" }, 400);
  }

  const { people, skipped, errors } = parseSkExport(csvText);

  if (people.length === 0) {
    const detectedHeaders = detectCsvHeaders(csvText);
    return c.json(
      {
        ok: false,
        error: "No valid records found. Ensure the CSV has an 'Individual ID' column.",
        detected_headers: detectedHeaders,
        parse_errors: errors,
      },
      422,
    );
  }

  // Generate a batch UUID
  const batchId = crypto.randomUUID();

  await createImportBatch(c.env.DB, batchId, filename, people.length, userEmail);

  await insertSkPeople(
    c.env.DB,
    people.map((p) => ({
      import_batch_id: batchId,
      sk_individual_id: p.sk_individual_id,
      sk_family_id: p.sk_family_id,
      first_name: p.first_name,
      last_name: p.last_name,
      middle_name: p.middle_name,
      preferred_name: p.preferred_name,
      gender: p.gender,
      birthdate: p.birthdate,
      anniversary: p.anniversary,
      membership: p.membership,
      marital_status: p.marital_status,
      home_phone: p.home_phone,
      cell_phone: p.cell_phone,
      work_phone: p.work_phone,
      email_home: p.email_home,
      email_work: p.email_work,
      address_street: p.address_street,
      address_city: p.address_city,
      address_state: p.address_state,
      address_zip: p.address_zip,
      baptized: p.baptized,
      baptized_date: p.baptized_date,
      include_in_dir: p.include_in_dir ? 1 : 0,
      raw_data: JSON.stringify(p.raw),
    })),
  );

  return c.json({
    ok: true,
    data: {
      batch_id: batchId,
      filename,
      record_count: people.length,
      skipped,
      parse_errors: errors,
    },
  });
});
