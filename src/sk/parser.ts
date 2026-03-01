import type { SkRawRow, SkPerson } from "./types";

// ── CSV tokeniser ─────────────────────────────────────────────────────────────

/**
 * RFC 4180-compliant CSV parser. Returns an array of objects keyed by the
 * header row. Works in both the Worker runtime and Node.js / Vitest.
 */
export function parseCsv(text: string): SkRawRow[] {
  const lines = tokeniseCsv(text);
  if (lines.length < 2) return [];

  const headers = lines[0];
  const rows: SkRawRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i];
    if (cells.every((c) => c.trim() === "")) continue; // skip blank rows
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = cells[idx] ?? "";
    });
    rows.push(row as SkRawRow);
  }
  return rows;
}

/** Splits a CSV text into a 2-D array of strings (handles quoted fields). */
function tokeniseCsv(text: string): string[][] {
  const result: string[][] = [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let pos = 0;
  const n = normalized.length;

  while (pos < n) {
    const row: string[] = [];
    // Parse one row
    while (pos <= n) {
      if (pos === n || normalized[pos] === "\n") {
        row.push("");
        pos++;
        break;
      }
      if (normalized[pos] === '"') {
        // Quoted field
        pos++; // skip opening quote
        let cell = "";
        while (pos < n) {
          if (normalized[pos] === '"') {
            if (normalized[pos + 1] === '"') {
              cell += '"';
              pos += 2;
            } else {
              pos++; // skip closing quote
              break;
            }
          } else {
            cell += normalized[pos++];
          }
        }
        row.push(cell);
        // After closing quote, expect comma or newline
        if (pos < n && normalized[pos] === ",") pos++;
        else if (pos < n && normalized[pos] === "\n") { pos++; break; }
        else if (pos === n) break;
      } else {
        // Unquoted field
        let cell = "";
        while (pos < n && normalized[pos] !== "," && normalized[pos] !== "\n") {
          cell += normalized[pos++];
        }
        row.push(cell);
        if (pos < n && normalized[pos] === ",") pos++;
        else if (pos < n && normalized[pos] === "\n") { pos++; break; }
        else if (pos === n) break;
      }
    }
    if (row.length > 1 || row[0] !== "") {
      result.push(row);
    }
  }
  return result;
}

// ── Date normalisation ────────────────────────────────────────────────────────

/**
 * Parses SK date strings to ISO YYYY-MM-DD.
 * SK exports dates as "MM/DD/YYYY" or "  /  /    " (empty).
 * Returns null for empty or unparseable dates.
 */
export function parseSkDate(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\s+/g, "");
  if (!trimmed || trimmed === "//") return null;
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, mm, dd, yyyy] = match;
  if (parseInt(yyyy) === 0) return null;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// ── Phone normalisation ───────────────────────────────────────────────────────

/**
 * Strips formatting from a phone number and returns digits-only.
 * Returns null if fewer than 7 digits.
 */
export function normalisePhone(value: string | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits;
}

// ── Gender normalisation ──────────────────────────────────────────────────────

export function normaliseGender(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "male" || v === "m") return "Male";
  if (v === "female" || v === "f") return "Female";
  return value.trim() || null;
}

// ── Main mapper ───────────────────────────────────────────────────────────────

/** Maps a raw SK CSV row to a normalised SkPerson record. */
export function rowToSkPerson(row: SkRawRow): SkPerson | null {
  const id = row["Individual ID"]?.trim();
  if (!id) return null; // cannot use a record without an ID

  return {
    sk_individual_id: id,
    sk_family_id: row["Family ID"]?.trim() || null,
    first_name: row["First Name"]?.trim() || null,
    last_name: row["Last Name"]?.trim() || null,
    middle_name: row["Middle Name"]?.trim() || null,
    preferred_name: row["Preferred Name"]?.trim() || null,
    gender: normaliseGender(row["Gender"]),
    birthdate: parseSkDate(row["Birth Date"]),
    anniversary: parseSkDate(row["Wedding Date"]),
    membership: row["Member Status"]?.trim() || null,
    marital_status: row["Marital Status"]?.trim() || null,
    home_phone: normalisePhone(row["Home Phone"]),
    cell_phone: normalisePhone(row["Cell Phone"]),
    work_phone: normalisePhone(row["Work Phone"]),
    email_home: row["E-Mail"]?.trim().toLowerCase() || null,
    email_work: row["Email 2"]?.trim().toLowerCase() || null,
    address_street: row["Address"]?.trim() || null,
    address_city: row["City"]?.trim() || null,
    address_state: row["State"]?.trim() || null,
    address_zip: row["Zip Code"]?.trim() || null,
    baptized: row["Baptized"]?.trim() || null,
    baptized_date: parseSkDate(row["Baptized Date"]),
    include_in_dir: (row["Include in Directory"] ?? "Y").trim().toUpperCase() !== "N",
    raw: row,
  };
}

// ── Full parse pipeline ───────────────────────────────────────────────────────

export interface ParseResult {
  people: SkPerson[];
  skipped: number;
  errors: string[];
}

/** Parse a full SK CSV export text into normalised SkPerson records. */
export function parseSkExport(csvText: string): ParseResult {
  const rows = parseCsv(csvText);
  const people: SkPerson[] = [];
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      const person = rowToSkPerson(row);
      if (person) {
        people.push(person);
      } else {
        skipped++;
      }
    } catch (e) {
      errors.push(String(e));
      skipped++;
    }
  }

  return { people, skipped, errors };
}
