/**
 * Diff computation: compares a normalised SK person record against the
 * corresponding PCO person snapshot and produces a list of changes.
 */

import type { SkPerson } from "../sk/types";
import type { PcoPersonRow, PcoPersonLight, PendingChangeRow, ChangeType } from "../types";

// ── Helper types ──────────────────────────────────────────────────────────────

export interface ProposedChange {
  sk_individual_id: string | null;
  pco_person_id: string | null;
  change_type: ChangeType;
  field_name: string | null;
  old_value: string | null;   // JSON-encoded
  new_value: string | null;   // JSON-encoded
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

function v(x: unknown): string {
  return JSON.stringify(x ?? null);
}

function phoneDigits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

function normEmail(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

// ── Field-level diff ──────────────────────────────────────────────────────────

/**
 * Produce field-level update_field changes between SK and a PCO snapshot.
 * Only emits a change when the SK value is non-empty AND differs from PCO.
 */
export function diffPersonFields(
  sk: SkPerson,
  pco: PcoPersonRow | PcoPersonLight,
): ProposedChange[] {
  const changes: ProposedChange[] = [];

  const fields: Array<{
    field: string;
    skVal: string | null;
    pcoVal: string | null;
  }> = [
    { field: "first_name",     skVal: sk.first_name,      pcoVal: pco.first_name },
    { field: "last_name",      skVal: sk.last_name,       pcoVal: pco.last_name },
    { field: "middle_name",    skVal: sk.middle_name,     pcoVal: pco.middle_name },
    { field: "gender",         skVal: sk.gender,           pcoVal: pco.gender },
    { field: "birthdate",      skVal: sk.birthdate,        pcoVal: pco.birthdate },
    { field: "anniversary",    skVal: sk.anniversary,      pcoVal: pco.anniversary },
    { field: "membership",     skVal: sk.membership,       pcoVal: pco.membership },
    { field: "marital_status", skVal: sk.marital_status,   pcoVal: pco.marital_status },
  ];

  for (const { field, skVal, pcoVal } of fields) {
    if (!skVal) continue;  // don't overwrite PCO with blank
    if (skVal === pcoVal) continue;
    changes.push({
      sk_individual_id: sk.sk_individual_id,
      pco_person_id: pco.pco_id,
      change_type: "update_field",
      field_name: field,
      old_value: v(pcoVal),
      new_value: v(skVal),
    });
  }

  return changes;
}

// ── Email diff ────────────────────────────────────────────────────────────────

export interface PcoEmailSnapshot {
  id: string;
  address: string;
  location: string;
}

export function diffEmails(
  sk: SkPerson,
  pcoPersonId: string,
  existingEmails: PcoEmailSnapshot[],
): ProposedChange[] {
  const changes: ProposedChange[] = [];

  const desired: Array<{ address: string; location: string }> = [];
  if (sk.email_home) desired.push({ address: normEmail(sk.email_home), location: "Home" });
  if (sk.email_work) desired.push({ address: normEmail(sk.email_work), location: "Work" });

  for (const want of desired) {
    const existing = existingEmails.find(
      (e) => normEmail(e.address) === want.address,
    );
    if (existing) continue;  // already present

    // Check if there is an email with same location to update
    const sameLocation = existingEmails.find(
      (e) => e.location.toLowerCase() === want.location.toLowerCase(),
    );
    if (sameLocation) {
      changes.push({
        sk_individual_id: sk.sk_individual_id,
        pco_person_id: pcoPersonId,
        change_type: "update_email",
        field_name: sameLocation.id,
        old_value: v(sameLocation.address),
        new_value: v(want.address),
      });
    } else {
      changes.push({
        sk_individual_id: sk.sk_individual_id,
        pco_person_id: pcoPersonId,
        change_type: "add_email",
        field_name: want.location,
        old_value: null,
        new_value: v(want.address),
      });
    }
  }

  return changes;
}

// ── Phone diff ────────────────────────────────────────────────────────────────

export interface PcoPhoneSnapshot {
  id: string;
  number: string;
  location: string;
}

export function diffPhones(
  sk: SkPerson,
  pcoPersonId: string,
  existingPhones: PcoPhoneSnapshot[],
): ProposedChange[] {
  const changes: ProposedChange[] = [];

  type PhoneEntry = { digits: string; location: string };
  const desired: PhoneEntry[] = [];
  if (sk.home_phone) desired.push({ digits: phoneDigits(sk.home_phone), location: "Home" });
  if (sk.cell_phone) desired.push({ digits: phoneDigits(sk.cell_phone), location: "Mobile" });
  if (sk.work_phone) desired.push({ digits: phoneDigits(sk.work_phone), location: "Work" });

  for (const want of desired) {
    if (!want.digits) continue;

    const existingMatch = existingPhones.find(
      (p) => phoneDigits(p.number) === want.digits,
    );
    if (existingMatch) continue;

    const sameLocation = existingPhones.find(
      (p) => p.location.toLowerCase() === want.location.toLowerCase(),
    );
    if (sameLocation) {
      changes.push({
        sk_individual_id: sk.sk_individual_id,
        pco_person_id: pcoPersonId,
        change_type: "update_phone",
        field_name: sameLocation.id,
        old_value: v(sameLocation.number),
        new_value: v(want.digits),
      });
    } else {
      changes.push({
        sk_individual_id: sk.sk_individual_id,
        pco_person_id: pcoPersonId,
        change_type: "add_phone",
        field_name: want.location,
        old_value: null,
        new_value: v(want.digits),
      });
    }
  }

  return changes;
}

// ── Address diff ──────────────────────────────────────────────────────────────

export interface PcoAddressSnapshot {
  id: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  location: string;
}

export function diffAddresses(
  sk: SkPerson,
  pcoPersonId: string,
  existingAddresses: PcoAddressSnapshot[],
): ProposedChange[] {
  const changes: ProposedChange[] = [];

  if (!sk.address_street && !sk.address_city) return changes;

  const homeAddr = existingAddresses.find(
    (a) => a.location.toLowerCase() === "home",
  );

  const skAddr = {
    street: sk.address_street ?? "",
    city: sk.address_city ?? "",
    state: sk.address_state ?? "",
    zip: sk.address_zip ?? "",
    location: "Home",
  };

  if (homeAddr) {
    const same =
      (homeAddr.street ?? "") === skAddr.street &&
      (homeAddr.city ?? "") === skAddr.city &&
      (homeAddr.state ?? "") === skAddr.state &&
      (homeAddr.zip ?? "") === skAddr.zip;
    if (!same) {
      changes.push({
        sk_individual_id: sk.sk_individual_id,
        pco_person_id: pcoPersonId,
        change_type: "update_address",
        field_name: homeAddr.id,
        old_value: v({
          street: homeAddr.street,
          city: homeAddr.city,
          state: homeAddr.state,
          zip: homeAddr.zip,
        }),
        new_value: v(skAddr),
      });
    }
  } else {
    changes.push({
      sk_individual_id: sk.sk_individual_id,
      pco_person_id: pcoPersonId,
      change_type: "add_address",
      field_name: "Home",
      old_value: null,
      new_value: v(skAddr),
    });
  }

  return changes;
}

// ── Create person diff ────────────────────────────────────────────────────────

/** Generate a single 'create_person' change for a new person. */
export function createPersonChange(sk: SkPerson): ProposedChange {
  return {
    sk_individual_id: sk.sk_individual_id,
    pco_person_id: null,
    change_type: "create_person",
    field_name: null,
    old_value: null,
    new_value: JSON.stringify({
      first_name: sk.first_name,
      last_name: sk.last_name,
      middle_name: sk.middle_name,
      nickname: sk.preferred_name,
      gender: sk.gender,
      birthdate: sk.birthdate,
      anniversary: sk.anniversary,
      membership: sk.membership,
      remote_id: parseInt(sk.sk_individual_id, 10) || null,
    }),
  };
}

// ── Summarise a change for display ────────────────────────────────────────────

export function summariseChange(change: Pick<PendingChangeRow, "change_type" | "field_name" | "old_value" | "new_value">): string {
  switch (change.change_type) {
    case "create_person": {
      const data = JSON.parse(change.new_value ?? "{}");
      return `Create new person: ${data.first_name ?? ""} ${data.last_name ?? ""}`.trim();
    }
    case "update_field":
      return `Update ${change.field_name}: "${JSON.parse(change.old_value ?? "null")}" → "${JSON.parse(change.new_value ?? "null")}"`;
    case "add_email":
      return `Add ${change.field_name} email: ${JSON.parse(change.new_value ?? "null")}`;
    case "update_email":
      return `Update email: "${JSON.parse(change.old_value ?? "null")}" → "${JSON.parse(change.new_value ?? "null")}"`;
    case "add_phone":
      return `Add ${change.field_name} phone: ${JSON.parse(change.new_value ?? "null")}`;
    case "update_phone":
      return `Update phone: "${JSON.parse(change.old_value ?? "null")}" → "${JSON.parse(change.new_value ?? "null")}"`;
    case "add_address":
      return `Add ${change.field_name} address`;
    case "update_address":
      return `Update ${change.field_name} address`;
    case "household":
      return `Update household`;
    default:
      return change.change_type;
  }
}
