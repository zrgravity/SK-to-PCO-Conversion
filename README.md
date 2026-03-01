# SK → PCO Sync

A Cloudflare Workers application that imports membership data from **Servant Keeper** and synchronises it into **Planning Center Online People**, with a UI for reviewing and approving every change before it is applied.

---

## Features

- **CSV import** — upload a Servant Keeper Groups Keeper export directly in the browser
- **PCO snapshot** — pulls all people (with emails, phones, addresses) from Planning Center
- **Smart matching** — matches SK people to PCO records by `remote_id`, name + birthdate, or email; unresolvable matches are presented for manual review (saved permanently so you're never asked twice)
- **Change review UI** — tabular diff of every proposed change; approve or reject individually or in bulk
- **One-way sync** — only approved changes are written back to PCO; nothing is ever auto-applied
- **Cloudflare Access** — the entire app is protected behind Cloudflare zero-trust auth
- **Single D1 database** — one deployment per church; adjust `wrangler.toml` for a new church

---

## Tech Stack

| | |
|---|---|
| Runtime | Cloudflare Workers + D1 |
| Framework | [Hono](https://hono.dev) |
| UI | HTML + [Alpine.js](https://alpinejs.dev) |
| Auth | Cloudflare Access + PCO Personal Access Token |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` |
| PCO API | `2025-11-10` |

---

## Quick Start

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A Cloudflare account
- A Planning Center developer account with a [Personal Access Token](https://api.planningcenteronline.com/oauth/applications)

### 1 — Clone & Install

```bash
git clone https://github.com/zrgravity/SK-to-PCO-Conversion.git
cd SK-to-PCO-Conversion
npm install
```

### 2 — Create D1 Database

```bash
wrangler d1 create sk-pco-db
```

Copy the `database_id` that is printed and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "sk-pco-db"
database_id = "PASTE_HERE"
```

### 3 — Run Migrations

```bash
# Production
npm run db:migrate:remote

# Local dev
npm run db:migrate:local
```

### 4 — Set Secrets

```bash
wrangler secret put PCO_APP_ID      # PCO personal access token — Application ID
wrangler secret put PCO_APP_SECRET  # PCO personal access token — Secret
wrangler secret put CF_ACCESS_AUD   # Cloudflare Access application audience (AUD) tag
```

> **Local dev:** CF Access auth is automatically bypassed when `CF_ACCESS_AUD` is empty.

### 5 — Deploy

```bash
npm run deploy
```

### 6 — Configure Cloudflare Access

In your Cloudflare dashboard, create an **Access Application** pointing at your Worker subdomain. Add allowed email addresses or connect an identity provider.

---

## Local Development

```bash
npm run dev
# → http://localhost:8787
```

No Access token is required locally. The auth middleware skips JWT verification when `CF_ACCESS_AUD` is not set.

---

## Running Tests

```bash
npm test            # run once
npm run test:watch  # watch mode
```

Tests cover the SK CSV parser, person matching algorithm, and diff computation.

---

## Workflow

```
1. Import CSV  →  2. Sync PCO  →  3. Compute Diff
                                        ↓
                      5. Apply  ←  4. Review & Approve
```

1. **Import CSV** — Export from SK Groups Keeper (File → Save As → CSV). Upload in the UI.
2. **Sync PCO** — Pull all Planning Center people into the local D1 snapshot.
3. **Compute Diff** — Match SK records to PCO records and compute field-level differences.
4. **Review** — Approve or reject each proposed change (individually or bulk).
5. **Apply** — Approved changes are written to Planning Center via the API.

---

## Servant Keeper Export Instructions

1. Open **Membership Manager** → **Groups Keeper**
2. Open the group to export (or create an "All Members" group)
3. Click **Select Fields** — add: Individual ID, Family ID, First Name, Last Name, Middle Name, Preferred Name, Gender, Birth Date, Wedding Date, Member Status, Marital Status, Home Phone, Cell Phone, Work Phone, E-Mail, Email 2, Address, City, State, Zip Code, Baptized, Baptized Date, Include in Directory
4. **Save As** → CSV
5. Upload in the Import step of the UI

> The `Individual ID` column is **required**.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/api/import` | List batches / Upload SK CSV |
| `GET/POST` | `/api/sync` | Snapshot stats / Pull from PCO |
| `GET/POST` | `/api/diff/:batchId` | List changes / Compute diffs |
| `POST` | `/api/review/:id/approve` | Approve a change |
| `POST` | `/api/review/:id/reject` | Reject a change |
| `POST` | `/api/review/batch/:batchId/approve-all` | Bulk approve |
| `POST` | `/api/apply/:batchId` | Apply approved changes to PCO |
| `GET/POST` | `/api/matches` | View / confirm SK↔PCO matches |
| `GET` | `/api/health` | Health check |

---

## Project Notes

See [memory.md](memory.md) for architecture decisions, progress log, and known limitations.

---

## Legacy

The original `SK to PCO conversion.py` script (Python 2, CSV-to-CSV) is retained for reference only. It is no longer the active tool.

---

## License

See [LICENSE.txt](LICENSE.txt).
