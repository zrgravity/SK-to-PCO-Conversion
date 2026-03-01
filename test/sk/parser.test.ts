import { describe, it, expect } from "vitest";
import {
  parseCsv,
  parseSkDate,
  normalisePhone,
  normaliseGender,
  rowToSkPerson,
  parseSkExport,
} from "../../src/sk/parser";

// ── parseCsv ──────────────────────────────────────────────────────────────────

describe("parseCsv", () => {
  it("parses a simple CSV with header", () => {
    const csv = `Name,Age\nAlice,30\nBob,25`;
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Name: "Alice", Age: "30" });
    expect(rows[1]).toMatchObject({ Name: "Bob", Age: "25" });
  });

  it("handles quoted fields with commas", () => {
    const csv = `Name,Address\n"Smith, John","123 Main St, Apt 4"`;
    const rows = parseCsv(csv);
    expect(rows[0]).toMatchObject({ Name: "Smith, John", Address: "123 Main St, Apt 4" });
  });

  it("handles escaped quotes inside quoted fields", () => {
    const csv = `Name\n"He said ""hello"""`; 
    const rows = parseCsv(csv);
    expect(rows[0].Name).toBe(`He said "hello"`);
  });

  it("returns empty array for header-only CSV", () => {
    expect(parseCsv("A,B,C")).toHaveLength(0);
  });

  it("skips blank rows", () => {
    const csv = `Name\nAlice\n\nBob`;
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it("handles Windows CRLF line endings", () => {
    const csv = "Name,Age\r\nAlice,30\r\nBob,25";
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
  });
});

// ── parseSkDate ────────────────────────────────────────────────────────────────

describe("parseSkDate", () => {
  it("parses MM/DD/YYYY date", () => {
    expect(parseSkDate("05/15/1975")).toBe("1975-05-15");
  });

  it("returns null for empty SK date pattern", () => {
    expect(parseSkDate("  /  /    ")).toBeNull();
    expect(parseSkDate("//")).toBeNull();
  });

  it("returns null for undefined/empty", () => {
    expect(parseSkDate(undefined)).toBeNull();
    expect(parseSkDate("")).toBeNull();
  });

  it("pads single-digit month and day", () => {
    expect(parseSkDate("1/5/2000")).toBe("2000-01-05");
  });

  it("returns null for year 0000", () => {
    expect(parseSkDate("01/01/0000")).toBeNull();
  });
});

// ── normalisePhone ────────────────────────────────────────────────────────────

describe("normalisePhone", () => {
  it("strips formatting from phone", () => {
    expect(normalisePhone("(555) 555-1234")).toBe("5555551234");
  });

  it("returns null for short numbers", () => {
    expect(normalisePhone("123")).toBeNull();
  });

  it("returns null for empty/undefined", () => {
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone(undefined)).toBeNull();
  });
});

// ── normaliseGender ───────────────────────────────────────────────────────────

describe("normaliseGender", () => {
  it("normalises Male", () => {
    expect(normaliseGender("Male")).toBe("Male");
    expect(normaliseGender("male")).toBe("Male");
    expect(normaliseGender("M")).toBe("Male");
  });

  it("normalises Female", () => {
    expect(normaliseGender("Female")).toBe("Female");
    expect(normaliseGender("FEMALE")).toBe("Female");
    expect(normaliseGender("f")).toBe("Female");
  });

  it("returns null for empty", () => {
    expect(normaliseGender("")).toBeNull();
    expect(normaliseGender(undefined)).toBeNull();
  });
});

// ── rowToSkPerson ─────────────────────────────────────────────────────────────

describe("rowToSkPerson", () => {
  it("returns null if Individual ID is missing", () => {
    expect(rowToSkPerson({})).toBeNull();
    expect(rowToSkPerson({ "First Name": "John" })).toBeNull();
  });

  it("maps core fields", () => {
    const row = {
      "Individual ID": "1001",
      "Family ID": "2001",
      "First Name": "John",
      "Last Name": "Smith",
      "Middle Name": "Robert",
      "Gender": "Male",
      "Birth Date": "05/15/1975",
      "Wedding Date": "06/20/2000",
      "Member Status": "Member",
      "E-Mail": "john@example.com",
      "Email 2": "john@work.com",
      "Home Phone": "555-555-1234",
      "Cell Phone": "555-555-9876",
      "Address": "123 Main St",
      "City": "Springfield",
      "State": "IL",
      "Zip Code": "62701",
    } as import("../../src/sk/types").SkRawRow;

    const person = rowToSkPerson(row);
    expect(person).not.toBeNull();
    expect(person!.sk_individual_id).toBe("1001");
    expect(person!.sk_family_id).toBe("2001");
    expect(person!.first_name).toBe("John");
    expect(person!.last_name).toBe("Smith");
    expect(person!.gender).toBe("Male");
    expect(person!.birthdate).toBe("1975-05-15");
    expect(person!.anniversary).toBe("2000-06-20");
    expect(person!.email_home).toBe("john@example.com");
    expect(person!.email_work).toBe("john@work.com");
    expect(person!.home_phone).toBe("5555551234");
    expect(person!.cell_phone).toBe("5555559876");
    expect(person!.address_street).toBe("123 Main St");
    expect(person!.address_city).toBe("Springfield");
    expect(person!.address_state).toBe("IL");
    expect(person!.address_zip).toBe("62701");
    expect(person!.include_in_dir).toBe(true);
  });

  it("sets include_in_dir to false when N", () => {
    const row = { "Individual ID": "1", "Include in Directory": "N" } as import("../../src/sk/types").SkRawRow;
    expect(rowToSkPerson(row)!.include_in_dir).toBe(false);
  });
});

// ── parseSkExport (integration) ────────────────────────────────────────────────

// Embedded fixture (Workers runtime does not support fs.readFileSync)
const SAMPLE_SK_CSV = `"Individual ID","Family ID","Family Name","First Name","Last Name","Middle Name","Preferred Name","Gender","Birth Date","Wedding Date","Member Status","Marital Status","Home Phone","Cell Phone","Work Phone","E-Mail","Email 2","Address","City","State","Zip Code","Baptized","Baptized Date","Include in Directory"
"1001","2001","Smith Family","John","Smith","Robert","Johnny","Male","05/15/1975","06/20/2000","Member","Married","555-555-1234","555-555-9876","","john.smith@example.com","john.smith@work.com","123 Main St","Springfield","IL","62701","Yes","03/12/2001","Y"
"1002","2001","Smith Family","Jane","Smith","Marie","","Female","09/22/1978","06/20/2000","Member","Married","555-555-1234","555-555-4321","","jane.smith@example.com","","123 Main St","Springfield","IL","62701","","  /  /    ","Y"
"1003","2002","Johnson Family","Robert","Johnson","","Bob","Male","11/03/1965","","Regular Attender","Single","555-555-2222","555-555-3333","555-555-4444","bob.johnson@example.com","","456 Oak Ave","Springfield","IL","62702","","  /  /    ","Y"
"1004","2003","Williams Family","Mary","Williams","Louise","","Female","02/14/1990","","","Single","","555-555-7777","","mary.williams@example.com","","789 Pine Rd","Springfield","IL","62703","","  /  /    ","N"
"","","","","Incomplete Row","","","","  /  /    ","  /  /    ","","","","","","","","","","","","","  /  /    ",""`;

describe("parseSkExport", () => {
  it("parses the sample fixture CSV", () => {
    const { people, skipped } = parseSkExport(SAMPLE_SK_CSV);
    // Row with empty Individual ID should be skipped
    expect(people.length).toBe(4);
    expect(skipped).toBeGreaterThanOrEqual(1);

    const john = people.find((p) => p.sk_individual_id === "1001");
    expect(john).toBeDefined();
    expect(john!.first_name).toBe("John");
    expect(john!.birthdate).toBe("1975-05-15");
    expect(john!.anniversary).toBe("2000-06-20");
  });
});
