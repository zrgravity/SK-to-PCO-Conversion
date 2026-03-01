# SK → PCO Project Memory

> Updated: 2026-03-01  
> Branch: `feat/cloudflare-workers-rebuild`

---

## Project Purpose

Sync membership data from **Servant Keeper** (SK) to **Planning Center Online** (PCO).
Data flows one-way: SK → PCO. Every change requires manual user approval before being applied.

---

## Architecture

```
Browser UI (public/index.html)
        │  Alpine.js SPA served as Cloudflare static asset
        │
Cloudflare Worker (src/index.ts)  ←── protected by Cloudflare Access
        │  Hono framework, TypeScript
        │
Cloudflare D1 (SQLite)  ←── single database, single deployment per church
        │
PCO API (api.planningcenteronline.com/people/v2)  ←── Personal Access Token
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| Framework | Hono v4 |
| Database | Cloudflare D1 (SQLite) |
| Auth | Cloudflare Access (zero-trust, JWT header) |
| PCO Auth | Personal Access Token (Basic auth: `app_id:app_secret`) |
| UI | Vanilla HTML + Alpine.js (CDN) |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` |
| PCO API version | `2025-11-10` |

---

## User Workflow (5 steps)

1. **Import CSV** — Upload SK Groups Keeper CSV export → stored in `sk_people` table  
2. **Sync PCO** — Pull all people from PCO API → stored in `pco_people` snapshot  
3. **Compute Diff** — Match SK records to PCO people, compute field/contact differences → stored as `pending_changes`  
4. **Review & Approve** — Table of all changes; user approves/rejects each one individually or in bulk  
5. **Apply** — Approved changes are written to PCO via the API

---

## Person Matching Strategy

Priority order when matching SK records to PCO people:

1. **Confirmed match** in `person_matches` table (from previous runs — never re-asked)  
2. **PCO `remote_id`** field equals SK Individual ID (numeric)  
3. **Name + birthdate** exact match (score ≥ 80, uniquely top)  
4. **Name + email** fuzzy matching  
5. **Unresolved** — user presented with ranked candidates to resolve manually  

Confirmed matches are stored forever so they only need to be resolved once.

---

## Key Fields Synced

| SK Field | PCO Field |
|----------|-----------|
| Individual ID | `remote_id` (stored as integer) |
| First/Last/Middle Name | `first_name`, `last_name`, `middle_name` |
| Preferred Name | `nickname` |
| Gender | `gender` |
| Birth Date | `birthdate` |
| Wedding Date | `anniversary` |
| Member Status | `membership` |
| E-Mail | Email (Home) |
| Email 2 | Email (Work) |
| Home Phone | Phone (Home) |
| Cell Phone | Phone (Mobile) |
| Work Phone | Phone (Work) |
| Address/City/State/Zip | Address (Home) |

---

## Database Tables

- `import_batches` — one row per CSV upload  
- `sk_people` — normalised SK records per batch  
- `pco_people` — PCO people snapshot  
- `pco_emails`, `pco_phone_numbers`, `pco_addresses` — PCO contact details  
- `pco_households` — PCO household snapshot  
- `person_matches` — confirmed SK ↔ PCO mappings  
- `pending_changes` — computed diffs (status: pending → approved/rejected → applied/failed)

---

## File Structure

```
src/
  index.ts                 Worker entry, Hono app, CF Access middleware
  types.ts                 Shared types (Env, DB row types)
  sk/
    types.ts               SK CSV column types + SkPerson interface
    parser.ts              CSV tokeniser, date/phone/gender normalisation
  pco/
    types.ts               PCO API resource types
    client.ts              PcoClient — typed API wrapper
  matching/
    matcher.ts             PersonMatcher, scoring algorithm
  diff/
    differ.ts              Field, email, phone, address diff computation
  db/
    schema.sql             D1 DDL (run once)
    queries.ts             All D1 query helpers
  routes/
    import.ts              GET/POST /api/import
    sync.ts                GET/POST /api/sync
    diff.ts                GET/POST /api/diff/:batchId
    review.ts              POST /api/review/:id/{approve,reject,reset}
    apply.ts               POST /api/apply/:batchId
    matches.ts             GET/POST/DELETE /api/matches
public/
  index.html               Single-page UI (Alpine.js)
test/
  fixtures/
    sample_sk.csv          Sample 4-person SK export
  sk/parser.test.ts
  matching/matcher.test.ts
  diff/differ.test.ts
```

---

## Setup Steps (first-time deployment)

```bash
# 1. Install dependencies
npm install

# 2. Create D1 database
wrangler d1 create sk-pco-db
# → copy the database_id into wrangler.toml

# 3. Run migrations
npm run db:migrate:remote

# 4. Set secrets
wrangler secret put PCO_APP_ID      # from PCO developer account
wrangler secret put PCO_APP_SECRET
wrangler secret put CF_ACCESS_AUD  # from Cloudflare Access app settings

# 5. Deploy
npm run deploy

# 6. Configure Cloudflare Access
#    Create an Access Application pointing at the Worker subdomain.
#    Add allowed emails / IdP as required.
```

## Local Development

```bash
# Run migrations on local D1
npm run db:migrate:local

# Start dev server (local D1, no Access auth required)
npm run dev
# → http://localhost:8787

# Run tests
npm test
```

---

## Progress Log

| Date | Change |
|------|--------|
| 2026-03-01 | Initial scaffold — branch `feat/cloudflare-workers-rebuild` created |
| 2026-03-01 | SK CSV parser, PCO client, matcher, differ, all routes, UI, tests |

---

## Known Limitations / Future Work

- Household creation/matching is scaffolded but not fully implemented (change_type `household` is a no-op in apply)
- Marital status is tracked in SK but PCO uses a relationship; not auto-applied yet
- Photos/avatars not synced
- Large organisation syncs can time out (Cloudflare Worker 30 s CPU limit) — consider splitting into batches via D1 queue
- No pagination in the UI change table (all changes loaded at once)
