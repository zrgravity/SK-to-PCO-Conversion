/**
 * SK CSV raw column names (Servant Keeper export headers).
 * These are the canonical field names as exported from SK Groups Keeper.
 * Users may export a subset; unrecognised columns are ignored.
 */
export const SK_COLUMNS = [
  "Individual ID",
  "Family ID",
  "Family Name",
  "First Name",
  "Last Name",
  "Middle Name",
  "Preferred Name",
  "Gender",
  "Birth Date",
  "Wedding Date",
  "Member Status",
  "Marital Status",
  "Home Phone",
  "Cell Phone",
  "Work Phone",
  "E-Mail",
  "Email 2",
  "Address",
  "City",
  "State",
  "Zip Code",
  "Baptized",
  "Baptized Date",
  "Include in Directory",
  "Individual Notes",
  "Date Last Edited",
] as const;

export type SkColumn = (typeof SK_COLUMNS)[number];

/** A raw row from the SK CSV, keyed by column header */
export type SkRawRow = Partial<Record<SkColumn, string>>;

/** Normalised person record parsed from a SK row */
export interface SkPerson {
  sk_individual_id: string;
  sk_family_id: string | null;
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  preferred_name: string | null;
  gender: string | null;         // 'Male' | 'Female' normalised to 'M' | 'F'
  birthdate: string | null;      // ISO YYYY-MM-DD
  anniversary: string | null;    // ISO YYYY-MM-DD
  membership: string | null;
  marital_status: string | null;
  home_phone: string | null;     // E.164-normalised where possible
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
  include_in_dir: boolean;
  raw: SkRawRow;  // all original fields for audit trail
}
