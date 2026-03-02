/** Subset of PCO People API types used by this application */

export interface PcoApiMeta {
  total_count: number;
  count: number;
  next?: { offset: number };
  prev?: { offset: number };
  can_order_by: string[];
  can_query_by: string[];
  parent?: { id: string; type: string };
}

export interface PcoResource<T = Record<string, unknown>> {
  type: string;
  id: string;
  attributes: T;
  relationships?: Record<string, { data: { type: string; id: string } | null }>;
  links?: Record<string, string>;
}

export interface PcoListResponse<T> {
  data: PcoResource<T>[];
  included?: PcoResource<Record<string, unknown>>[];
  meta: PcoApiMeta;
  links: Record<string, string>;
}

export interface PcoSingleResponse<T> {
  data: PcoResource<T>;
  included?: PcoResource<Record<string, unknown>>[];
}

// ── Person attributes ─────────────────────────────────────────────────────────

export interface PcoPersonAttributes {
  first_name: string;
  last_name: string;
  middle_name: string | null;
  nickname: string | null;
  given_name: string | null;
  gender: string | null;
  birthdate: string | null;         // YYYY-MM-DD
  anniversary: string | null;       // YYYY-MM-DD
  membership: string | null;
  marital_status: string | null;
  status: string;
  remote_id: number | null;
  created_at: string;
  updated_at: string;
  name: string;
  child: boolean;
}

export type PcoPerson = PcoResource<PcoPersonAttributes>;

// ── Email attributes ──────────────────────────────────────────────────────────

export interface PcoEmailAttributes {
  address: string;
  location: "Home" | "Work" | "Other";
  primary: boolean;
  created_at: string;
  updated_at: string;
}

export type PcoEmail = PcoResource<PcoEmailAttributes>;

// ── Phone number attributes ───────────────────────────────────────────────────

export interface PcoPhoneAttributes {
  number: string;
  carrier: string | null;
  location: "Home" | "Mobile" | "Work" | "Pager" | "Fax" | "Skype" | "Other";
  primary: boolean;
  created_at: string;
  updated_at: string;
}

export type PcoPhone = PcoResource<PcoPhoneAttributes>;

// ── Address attributes ────────────────────────────────────────────────────────

export interface PcoAddressAttributes {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  location: "Home" | "Work" | "Other";
  primary: boolean;
  created_at: string;
  updated_at: string;
}

export type PcoAddress = PcoResource<PcoAddressAttributes>;

// ── Household attributes ──────────────────────────────────────────────────────

export interface PcoHouseholdAttributes {
  name: string;
  member_count: number;
  primary_contact_name: string | null;
  created_at: string;
  updated_at: string;
}

export type PcoHousehold = PcoResource<PcoHouseholdAttributes>;

// ── Marital status ────────────────────────────────────────────────────────────

export interface PcoMaritalStatusAttributes {
  value: string;
}

export type PcoMaritalStatus = PcoResource<PcoMaritalStatusAttributes>;

// ── Combined person details (with related records) ────────────────────────────

export interface PcoPersonDetails {
  person: PcoPerson;
  emails: PcoEmail[];
  phones: PcoPhone[];
  addresses: PcoAddress[];
  maritalStatus: string | null;
}
