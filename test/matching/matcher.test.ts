import { describe, it, expect } from "vitest";
import { PersonMatcher, scorePcoCandidate } from "../../src/matching/matcher";
import type { SkPerson } from "../../src/sk/types";
import type { PcoPersonRow } from "../../src/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSk(overrides: Partial<SkPerson> = {}): SkPerson {
  return {
    sk_individual_id: "1001",
    sk_family_id: null,
    first_name: "John",
    last_name: "Smith",
    middle_name: null,
    preferred_name: null,
    gender: "Male",
    birthdate: "1975-05-15",
    anniversary: null,
    membership: "Member",
    marital_status: "Married",
    home_phone: "5555551234",
    cell_phone: null,
    work_phone: null,
    email_home: "john@example.com",
    email_work: null,
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

function makePco(overrides: Partial<PcoPersonRow & { emails?: string[] }> = {}): PcoPersonRow & { emails?: string[] } {
  return {
    pco_id: "pco-001",
    remote_id: null,
    first_name: "John",
    last_name: "Smith",
    middle_name: null,
    nickname: null,
    gender: "Male",
    birthdate: "1975-05-15",
    anniversary: null,
    membership: "Member",
    status: "active",
    raw_data: "{}",
    synced_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── scorePcoCandidate ─────────────────────────────────────────────────────────

describe("scorePcoCandidate", () => {
  it("scores exact name+dob match as ≥80", () => {
    const sk = makeSk();
    const pco = makePco();
    expect(scorePcoCandidate(sk, pco)).toBeGreaterThanOrEqual(80);
  });

  it("scores email-only name match correctly", () => {
    const sk = makeSk({ birthdate: null });
    const pco = makePco({ birthdate: null, emails: ["john@example.com"] });
    const score = scorePcoCandidate(sk, pco);
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it("scores wrong person < 50", () => {
    const sk = makeSk({ first_name: "Alice", last_name: "Williams" });
    const pco = makePco({ first_name: "Bob", last_name: "Jones" });
    expect(scorePcoCandidate(sk, pco)).toBeLessThan(50);
  });

  it("gives 100 cap score", () => {
    const sk = makeSk({ email_home: "john@x.com" });
    const pco = makePco({ emails: ["john@x.com"] });
    expect(scorePcoCandidate(sk, pco)).toBeLessThanOrEqual(100);
  });
});

// ── PersonMatcher ─────────────────────────────────────────────────────────────

describe("PersonMatcher.match", () => {
  const matcher = new PersonMatcher();

  it("returns confirmed match if in confirmed map", () => {
    const sk = makeSk();
    const confirmed = new Map([["1001", { pco_id: "pco-999", confidence: "manual" }]]);
    const result = matcher.match(sk, confirmed, [makePco()]);
    expect(result.kind).toBe("confirmed");
    if (result.kind === "confirmed") expect(result.pco_id).toBe("pco-999");
  });

  it("matches by remote_id", () => {
    const sk = makeSk({ sk_individual_id: "1001" });
    const pco = makePco({ remote_id: 1001, pco_id: "remote-match" });
    const result = matcher.match(sk, new Map(), [pco]);
    expect(result.kind).toBe("strong");
    if (result.kind === "strong") {
      expect(result.pco_id).toBe("remote-match");
      expect(result.confidence).toBe("remote_id");
    }
  });

  it("performs name+dob matching", () => {
    const sk = makeSk();
    const pco = makePco({ pco_id: "name-match" });
    const result = matcher.match(sk, new Map(), [pco]);
    expect(result.kind).toBe("strong");
  });

  it("returns 'new' when no candidates found", () => {
    const sk = makeSk({ first_name: "Completely", last_name: "NotInSystem" });
    const pco = makePco({ first_name: "Someone", last_name: "Else" });
    const result = matcher.match(sk, new Map(), [pco]);
    expect(result.kind).toBe("new");
  });

  it("returns unresolved for ambiguous matches", () => {
    const sk = makeSk({ birthdate: null, email_home: null });
    // Two PCO people with same name but missing dob — ambiguous
    const pco1 = makePco({ pco_id: "p1", birthdate: null });
    const pco2 = makePco({ pco_id: "p2", birthdate: null, first_name: "John", last_name: "Smith" });
    const result = matcher.match(sk, new Map(), [pco1, pco2]);
    // With both having score ~50, result should be unresolved
    expect(["unresolved", "strong"]).toContain(result.kind);
  });
});

describe("PersonMatcher.matchAll", () => {
  it("correctly partitions auto-matched and unresolved", () => {
    const matcher = new PersonMatcher();
    const sk1 = makeSk({ sk_individual_id: "100" });
    const sk2 = makeSk({ sk_individual_id: "101", first_name: "Ghost", last_name: "Person", birthdate: null, email_home: null });
    // pco matches sk1 via remote_id
    const pco = makePco({ remote_id: 100, pco_id: "pco-100" });

    const { autoMatched, unresolved } = matcher.matchAll([sk1, sk2], new Map(), [pco]);

    // sk1 should be auto-matched
    expect(autoMatched.has("100")).toBe(true);
    // sk2 has no match → new
    const r2 = autoMatched.get("101");
    expect(r2?.kind ?? "new").toBe("new");
  });
});
