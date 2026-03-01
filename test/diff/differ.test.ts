import { describe, it, expect } from "vitest";
import {
  diffPersonFields,
  diffEmails,
  diffPhones,
  diffAddresses,
  createPersonChange,
  summariseChange,
} from "../../src/diff/differ";
import type { SkPerson } from "../../src/sk/types";
import type { PcoPersonRow } from "../../src/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSk(overrides: Partial<SkPerson> = {}): SkPerson {
  return {
    sk_individual_id: "1001",
    sk_family_id: "2001",
    first_name: "John",
    last_name: "Smith",
    middle_name: "Robert",
    preferred_name: "Johnny",
    gender: "Male",
    birthdate: "1975-05-15",
    anniversary: "2000-06-20",
    membership: "Member",
    marital_status: "Married",
    home_phone: "5555551234",
    cell_phone: "5555559876",
    work_phone: null,
    email_home: "john@example.com",
    email_work: "john@work.com",
    address_street: "123 Main St",
    address_city: "Springfield",
    address_state: "IL",
    address_zip: "62701",
    baptized: null,
    baptized_date: null,
    include_in_dir: true,
    raw: {},
    ...overrides,
  };
}

function makePco(overrides: Partial<PcoPersonRow> = {}): PcoPersonRow {
  return {
    pco_id: "pco-001",
    remote_id: 1001,
    first_name: "John",
    last_name: "Smith",
    middle_name: null,
    nickname: null,
    gender: "Male",
    birthdate: "1975-05-15",
    anniversary: "2000-06-20",
    membership: "Member",
    marital_status: "Married",
    status: "active",
    raw_data: "{}",
    synced_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── diffPersonFields ──────────────────────────────────────────────────────────

describe("diffPersonFields", () => {
  it("returns no changes when SK and PCO are identical", () => {
    const sk = makeSk({ middle_name: null, preferred_name: null });
    const pco = makePco();
    expect(diffPersonFields(sk, pco)).toHaveLength(0);
  });

  it("detects changed first_name", () => {
    // Provide a fully matching PCO record so only first_name differs
    const sk = makeSk({ first_name: "Jonathan", middle_name: null, preferred_name: null });
    const pco = makePco({ first_name: "John", middle_name: null, nickname: null });
    const changes = diffPersonFields(sk, pco);
    expect(changes).toHaveLength(1);
    expect(changes[0].field_name).toBe("first_name");
    expect(JSON.parse(changes[0].old_value!)).toBe("John");
    expect(JSON.parse(changes[0].new_value!)).toBe("Jonathan");
  });

  it("does not overwrite PCO value with blank SK value", () => {
    const sk = makeSk({ membership: null });
    const pco = makePco({ membership: "Member" });
    const changes = diffPersonFields(sk, pco);
    expect(changes.find(c => c.field_name === "membership")).toBeUndefined();
  });

  it("includes middle_name and marital_status diffs", () => {
    const sk = makeSk(); // has middle_name: "Robert", marital_status: "Married"
    const pco = makePco({ middle_name: null, marital_status: null }); // PCO has both null
    const changes = diffPersonFields(sk, pco);
    expect(changes.some(c => c.field_name === "middle_name")).toBe(true);
    expect(changes.some(c => c.field_name === "marital_status")).toBe(true);
  });
});

// ── diffEmails ────────────────────────────────────────────────────────────────

describe("diffEmails", () => {
  it("returns empty when email already present", () => {
    const sk = makeSk();
    const changes = diffEmails(sk, "pco-001", [
      { id: "e1", address: "john@example.com", location: "Home" },
      { id: "e2", address: "john@work.com",    location: "Work" },
    ]);
    expect(changes).toHaveLength(0);
  });

  it("proposes add_email when Home email missing", () => {
    const sk = makeSk({ email_work: null });
    const changes = diffEmails(sk, "pco-001", []);
    expect(changes).toHaveLength(1);
    expect(changes[0].change_type).toBe("add_email");
    expect(changes[0].field_name).toBe("Home");
  });

  it("proposes update_email when same location but different address", () => {
    // No email_work so only the Home email diff is expected
    const sk = makeSk({ email_home: "newemail@example.com", email_work: null });
    const changes = diffEmails(sk, "pco-001", [
      { id: "e1", address: "oldemail@example.com", location: "Home" },
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0].change_type).toBe("update_email");
    expect(JSON.parse(changes[0].new_value!)).toBe("newemail@example.com");
  });
});

// ── diffPhones ────────────────────────────────────────────────────────────────

describe("diffPhones", () => {
  it("returns empty when all phones match", () => {
    const sk = makeSk({ work_phone: null });
    const changes = diffPhones(sk, "pco-001", [
      { id: "p1", number: "5555551234", location: "Home" },
      { id: "p2", number: "5555559876", location: "Mobile" },
    ]);
    expect(changes).toHaveLength(0);
  });

  it("proposes add_phone for new home number", () => {
    const sk = makeSk({ cell_phone: null });
    const changes = diffPhones(sk, "pco-001", []);
    expect(changes.some(c => c.change_type === "add_phone")).toBe(true);
  });
});

// ── diffAddresses ─────────────────────────────────────────────────────────────

describe("diffAddresses", () => {
  it("returns empty when address matches", () => {
    const sk = makeSk();
    const changes = diffAddresses(sk, "pco-001", [
      { id: "a1", street: "123 Main St", city: "Springfield", state: "IL", zip: "62701", location: "Home" },
    ]);
    expect(changes).toHaveLength(0);
  });

  it("proposes add_address when no address exists", () => {
    const sk = makeSk();
    const changes = diffAddresses(sk, "pco-001", []);
    expect(changes).toHaveLength(1);
    expect(changes[0].change_type).toBe("add_address");
  });

  it("proposes update_address when address changed", () => {
    const sk = makeSk({ address_street: "456 New Ave" });
    const changes = diffAddresses(sk, "pco-001", [
      { id: "a1", street: "123 Main St", city: "Springfield", state: "IL", zip: "62701", location: "Home" },
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0].change_type).toBe("update_address");
  });

  it("returns empty when SK has no address data", () => {
    const sk = makeSk({ address_street: null, address_city: null });
    const changes = diffAddresses(sk, "pco-001", []);
    expect(changes).toHaveLength(0);
  });
});

// ── createPersonChange ────────────────────────────────────────────────────────

describe("createPersonChange", () => {
  it("creates a create_person change with correct fields", () => {
    const sk = makeSk();
    const change = createPersonChange(sk);
    expect(change.change_type).toBe("create_person");
    expect(change.pco_person_id).toBeNull();
    const data = JSON.parse(change.new_value!);
    expect(data.first_name).toBe("John");
    expect(data.last_name).toBe("Smith");
    expect(data.remote_id).toBe(1001);
  });
});

// ── summariseChange ───────────────────────────────────────────────────────────

describe("summariseChange", () => {
  it("summarises create_person", () => {
    const s = summariseChange({
      change_type: "create_person",
      field_name: null,
      old_value: null,
      new_value: JSON.stringify({ first_name: "Alice", last_name: "Jones" }),
    });
    expect(s).toContain("Alice");
    expect(s).toContain("Jones");
  });

  it("summarises update_field", () => {
    const s = summariseChange({
      change_type: "update_field",
      field_name: "first_name",
      old_value: '"John"',
      new_value: '"Jonathan"',
    });
    expect(s).toContain("first_name");
    expect(s).toContain("Jonathan");
  });
});
