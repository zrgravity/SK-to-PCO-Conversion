/**
 * Person matching: determines which PCO person corresponds to a SK record.
 *
 * Priority order:
 *  1. Confirmed match in `person_matches` table (stored from previous runs)
 *  2. PCO remote_id field == SK Individual ID
 *  3. Exact name + birthdate
 *  4. Exact name + email address
 *  5. Present candidates to user for manual resolution
 */

import type { SkPerson } from "../sk/types";
import type { PcoPersonRow, PcoPersonLight } from "../types";
import type { MatchCandidate, UnresolvedMatch } from "../types";

// ── Scoring helpers ───────────────────────────────────────────────────────────

/** Normalise a string for loose comparison (lower, trim, collapse whitespace). */
function normalise(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** Returns true if both non-empty values match case-insensitively. */
function matches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalise(a) === normalise(b);
}

// ── Candidate scoring ─────────────────────────────────────────────────────────

// Accept either the full row (from sync) or the light row (no raw_data, from diff)
type PcoSnapshot = (PcoPersonRow | PcoPersonLight) & {
  emails?: string[];  // email addresses from pco_emails
};

/**
 * Score a PCO snapshot record against a SK person.
 * Returns 0-100. Scores ≥ 80 are treated as strong matches.
 */
export function scorePcoCandidate(sk: SkPerson, pco: PcoSnapshot): number {
  let score = 0;

  // First + last name (50 pts)
  const firstMatch = matches(sk.first_name, pco.first_name);
  const lastMatch = matches(sk.last_name, pco.last_name);
  if (firstMatch && lastMatch) score += 50;
  else if (lastMatch) score += 15;
  else if (firstMatch) score += 10;

  // Birthdate (30 pts)
  if (sk.birthdate && pco.birthdate && sk.birthdate === pco.birthdate) {
    score += 30;
  }

  // Email (15 pts)
  const skEmails = [sk.email_home, sk.email_work]
    .filter(Boolean)
    .map((e) => normalise(e));
  const pcoEmails = (pco.emails ?? [])
    .map((e) => normalise(e));
  if (skEmails.some((e) => pcoEmails.includes(e))) {
    score += 15;
  }

  // Middle name or nickname alignment (5 pts)
  if (matches(sk.preferred_name || sk.first_name, pco.nickname || pco.first_name)) {
    score += 5;
  }

  return Math.min(100, score);
}

// ── Match result types ────────────────────────────────────────────────────────

export type MatchResult =
  | { kind: "confirmed"; pco_id: string; confidence: string }
  | { kind: "strong"; pco_id: string; confidence: string; score: number }
  | { kind: "unresolved"; candidates: MatchCandidate[] }
  | { kind: "new" };  // No match found — this person should be created

// ── Main matcher ──────────────────────────────────────────────────────────────

export class PersonMatcher {
  /**
   * Attempt to match a single SK person to a PCO record.
   *
   * @param sk              The SK person to match.
   * @param confirmedMap    Preloaded map of sk_individual_id → pco_person_id from DB.
   * @param allPco          Full PCO snapshot to search against.
   */
  match(
    sk: SkPerson,
    confirmedMap: Map<string, { pco_id: string; confidence: string }>,
    allPco: PcoSnapshot[],
  ): MatchResult {
    // 1. Previously confirmed match
    const confirmed = confirmedMap.get(sk.sk_individual_id);
    if (confirmed) {
      return { kind: "confirmed", pco_id: confirmed.pco_id, confidence: confirmed.confidence };
    }

    // 2. PCO remote_id matches SK individual ID (numeric)
    const skIdNum = parseInt(sk.sk_individual_id, 10);
    if (!isNaN(skIdNum)) {
      const byRemote = allPco.find(
        (p) => p.remote_id !== null && p.remote_id === skIdNum,
      );
      if (byRemote) {
        return { kind: "strong", pco_id: byRemote.pco_id, confidence: "remote_id", score: 100 };
      }
    }

    // 3 & 4. Score all PCO records
    const scored = allPco
      .map((pco) => ({ pco, score: scorePcoCandidate(sk, pco) }))
      .filter(({ score }) => score >= 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);  // top 5 candidates

    if (scored.length === 0) {
      return { kind: "new" };
    }

    const best = scored[0];
    const secondBest = scored[1];
    const gap = secondBest ? best.score - secondBest.score : best.score;

    // Rule 1: Strong match — name + DOB (score ≥ 80, clear leader by ≥ 20 pts)
    if (best.score >= 80 && gap >= 20) {
      const confidence = best.pco.remote_id !== null ? "remote_id" : "name_dob";
      return { kind: "strong", pco_id: best.pco.pco_id, confidence, score: best.score };
    }

    // Rule 2: Name + email (score ≥ 65, leader by ≥ 10 pts) — email is strong corroboration
    if (best.score >= 65 && gap >= 10) {
      return { kind: "strong", pco_id: best.pco.pco_id, confidence: "name_email", score: best.score };
    }

    // Rule 3: Single unambiguous name match (only candidate, full name matched → score ≥ 55)
    if (scored.length === 1 && best.score >= 55) {
      return { kind: "strong", pco_id: best.pco.pco_id, confidence: "name_only", score: best.score };
    }

    // Ambiguous — needs user input
    const candidates: MatchCandidate[] = scored.map(({ pco, score }) => ({
      pco_id: pco.pco_id,
      first_name: pco.first_name,
      last_name: pco.last_name,
      birthdate: pco.birthdate,
      email: pco.emails?.[0] ?? null,
      score,
    }));

    return { kind: "unresolved", candidates };
  }

  /**
   * Run matching over a full SK import batch.
   * Returns auto-matched results and an array of items needing user resolution.
   */
  matchAll(
    skPeople: SkPerson[],
    confirmedMap: Map<string, { pco_id: string; confidence: string }>,
    allPco: PcoSnapshot[],
  ): {
    autoMatched: Map<string, MatchResult>;
    unresolved: UnresolvedMatch[];
  } {
    const autoMatched = new Map<string, MatchResult>();
    const unresolved: UnresolvedMatch[] = [];

    for (const sk of skPeople) {
      const result = this.match(sk, confirmedMap, allPco);
      if (result.kind === "unresolved") {
        unresolved.push({
          sk_individual_id: sk.sk_individual_id,
          sk_first_name: sk.first_name,
          sk_last_name: sk.last_name,
          sk_birthdate: sk.birthdate,
          candidates: result.candidates,
        });
      } else {
        autoMatched.set(sk.sk_individual_id, result);
      }
    }

    return { autoMatched, unresolved };
  }
}
