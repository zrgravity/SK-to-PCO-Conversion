// Shared types and environment bindings

export interface Env {
  DB: D1Database;
  PCO_APP_ID: string;
  PCO_APP_SECRET: string;
  /** Cloudflare Access audience tag — empty string disables verification in local dev */
  CF_ACCESS_AUD: string;
}

// ── Database row types (mirrors schema.sql) ──────────────────────────────────

export interface ImportBatchRow {
  id: string;
  filename: string;
  record_count: number;
  status: "imported" | "diffed" | "applied";
  imported_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkPersonRow {
  id: number;
  import_batch_id: string;
  sk_individual_id: string;
  sk_family_id: string | null;
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  preferred_name: string | null;
  gender: string | null;
  birthdate: string | null;
  anniversary: string | null;
  membership: string | null;
  marital_status: string | null;
  home_phone: string | null;
  cell_phone: string | null;
  work_phone: string | null;
  email_home: string | null;
  email_work: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  baptized: string | null;
  baptized_date: string | null;
  include_in_dir: number;
  raw_data: string;
  created_at: string;
}

export interface PcoPersonRow {
  pco_id: string;
  remote_id: number | null;
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  nickname: string | null;
  gender: string | null;
  birthdate: string | null;
  anniversary: string | null;
  membership: string | null;
  marital_status: string | null;
  status: string | null;
  raw_data: string;
  synced_at: string;
}

/** Like PcoPersonRow but without the large raw_data blob — used in diff/match paths. */
export type PcoPersonLight = Omit<PcoPersonRow, "raw_data">;

export interface PersonMatchRow {
  id: number;
  sk_individual_id: string;
  pco_person_id: string;
  confidence: "remote_id" | "name_dob" | "name_email" | "manual";
  user_confirmed: number;
  confirmed_by: string | null;
  created_at: string;
  updated_at: string;
}

export type ChangeType =
  | "create_person"
  | "update_field"
  | "add_email"
  | "update_email"
  | "add_phone"
  | "update_phone"
  | "add_address"
  | "update_address"
  | "household";

export type ChangeStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "applied"
  | "failed";

export interface PendingChangeRow {
  id: number;
  import_batch_id: string;
  sk_individual_id: string | null;
  pco_person_id: string | null;
  change_type: ChangeType;
  field_name: string | null;
  old_value: string | null;  // JSON-encoded
  new_value: string | null;  // JSON-encoded
  status: ChangeStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  applied_at: string | null;
  error_message: string | null;
  created_at: string;
}

// ── API response shapes ───────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ── Ambiguous match (needs user resolution) ───────────────────────────────────

export interface MatchCandidate {
  pco_id: string;
  first_name: string | null;
  last_name: string | null;
  birthdate: string | null;
  email: string | null;
  score: number;  // 0-100 confidence
}

export interface UnresolvedMatch {
  sk_individual_id: string;
  sk_first_name: string | null;
  sk_last_name: string | null;
  sk_birthdate: string | null;
  candidates: MatchCandidate[];
}
