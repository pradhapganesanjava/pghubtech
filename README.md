# PG Hub Tech

A personal **Anki-style flashcard study app** that uses **Google Sheets as its database** — no backend, no DB server. Sign in with Google, point it at a Sheet you own, and the app reads/writes flashcards, templates, and SRS (spaced-repetition) progress directly via the Sheets REST API. Deployed as a static site to GitHub Pages.

**Live app:** https://pradhapganesanjava.github.io/pghubtech/

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (React SPA, served by Vite / GitHub Pages)          │
│                                                              │
│  Views ──> Adapters ──> Google Sheets REST API               │
│            (sheetsRepo, ankiRepo, srsRepo)                   │
│              │                                               │
│  Auth: Google Identity Services (GIS) token flow             │
│  Cache: localStorage / sessionStorage                        │
└──────────────────────────────────────────────────────────────┘
                       │
              Google Sheet (user-owned)
              ├── Items                (generic notes; legacy)
              ├── Settings             (key/value: theme, etc.)
              ├── Templates            (Anki template definitions)
              ├── <TemplateId> tabs    (one per template — the cards)
              └── SRS_Progress         (per-card review state)

┌──────────────────────────────────────────────────────────────┐
│  scripts/  (one-shot Node migration tools, not runtime)      │
│  anki-seed-templates.mjs  →  seed Templates tab from Anki    │
│  anki-to-sheets.mjs       →  copy notes + media from Anki    │
│       │                                                      │
│       └─ AnkiConnect (Anki desktop, port 8765)               │
│       └─ googleapis (Sheets + Drive, OAuth desktop flow)     │
└──────────────────────────────────────────────────────────────┘
```

### Top-level layout

| Folder    | What it is                                                     |
|-----------|----------------------------------------------------------------|
| `portal/` | React 19 + TypeScript + Vite SPA (the actual app)              |
| `scripts/`| Node.js scripts to seed the Sheet from a local Anki install    |
| `apps-script/` | Google Apps Script web app: a `curl`-callable endpoint that files a new card from free text (AI picks deck/template/tags). See `apps-script/README.md` |
| `docs/`   | Static HTML / Markdown reference docs                          |
| `.github/workflows/deploy.yml` | Builds `portal/` and deploys to GitHub Pages |

---

## Layers inside `portal/src/`

| Layer        | Files | Responsibility |
|--------------|-------|----------------|
| **Entry**    | `main.tsx`, `App.tsx` | Auth state machine: `loading → unauthenticated → needs-sheet → authenticated`; theme; routing between 3 views |
| **Auth lib** | `lib/gauth.ts` | Wraps Google Identity Services token flow; `signIn`, `signOut`, `restoreSession`, `listSheets`, `createSheet`. Tokens in `sessionStorage` |
| **Config**   | `services/config.ts` | localStorage-backed: `googleClientId`, `sheetId`, `theme`, `allowedEmails` |
| **Adapters** (data layer) | `adapters/sheetsRepo.ts` | Generic Items + Settings tabs; `ensureHeaders`, CRUD, `checkAccess` |
|              | `adapters/ankiRepo.ts`   | `Templates` tab + per-template tabs; loads/saves templates and notes |
|              | `adapters/srsRepo.ts`    | `SRS_Progress` tab + localStorage cache; SM-2-style `computeNextSRS`, `isDue`, `previewIntervals` |
| **Views**    | `views/HomeView.tsx`    | Review queue: pulls due cards, flips front/back, rates Again/Hard/Good/Easy |
|              | `views/BrowseView.tsx`  | Browse all notes, filter by tag/deck, see schedule, edit |
|              | `views/SettingsView.tsx`| General (clientId/sheet/theme) + Templates editor |
| **Components** | `TopBar`, `SheetSetupModal`, `TagDeckTree`, `AnkiCard`, `NoteDetailPanel`, `Toast` | UI building blocks |
| **Utils**    | `utils/cardHelpers.ts` | Render card HTML for front/back from template fields |

---

## Runtime flow

1. `App.tsx` mounts → `GAuth.restoreSession()` checks `sessionStorage` for a non-expired token.
2. If no session → **Login screen** → `GAuth.signIn()` opens the GIS popup, requests scopes (`spreadsheets`, `drive.file`, `drive.readonly`, `userinfo.*`).
3. Optional email whitelist (`VITE_ALLOWED_EMAILS`) is enforced.
4. If no Sheet ID configured → **`SheetSetupModal`**: list existing sheets via Drive, paste a Sheet ID, or create a new one.
5. `ensureHeaders()` ensures `Items` and `Settings` tabs exist with the right header rows.
6. App lands on **HomeView**:
   - `loadAnkiTemplates()` → reads `Templates` tab.
   - `loadAllNotes(templates)` → reads each `<templateId>` tab.
   - `loadSRSMap()` → reads `SRS_Progress`, merges with localStorage cache (last-write-wins by `lastReviewed` timestamp).
   - Builds a queue of due cards, you rate them, `setSRSRecord()` writes localStorage immediately and fires a background Sheets write.

---

## Required dependencies

**Runtime (portal):** React 19, react-dom, Vite 8, TypeScript ~6, ESLint 9 — all in `portal/package.json`. No HTTP client; uses `fetch`. Google APIs are reached via raw REST and the GIS script tag in `index.html`.

**Scripts:** `googleapis` (Node Google client). Also requires the **AnkiConnect** add-on (id `2055492159`) running inside the Anki desktop app on `localhost:8765`.

**External services:**
- A Google Cloud project with Sheets API, Drive API, and People API enabled
- A configured OAuth consent screen
- A **Web** OAuth Client ID for the portal
- A **Desktop** OAuth Client ID for the scripts (only if importing from Anki)

---

## Initial setup

### 1. Google Cloud (one-time)

Follow `docs/google-oauth-client-id-setup.md`:

- Create project, enable Sheets / Drive / People APIs
- Configure OAuth consent screen with these scopes:
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/drive.file`
  - `https://www.googleapis.com/auth/drive.readonly`
  - `https://www.googleapis.com/auth/userinfo.email`
  - `https://www.googleapis.com/auth/userinfo.profile`
- Create a **Web** OAuth Client ID with authorized JS origins:
  - `http://localhost:5173`
  - your GitHub Pages URL (e.g. `https://<user>.github.io`)
- (Optional, scripts only) Create a separate **Desktop** OAuth Client → download as `scripts/credentials.json`

### 2. Local config

```bash
cd portal
cp .env.example .env.local
```

Edit `portal/.env.local`:

```bash
VITE_GOOGLE_CLIENT_ID=<your-web-client-id>.apps.googleusercontent.com
VITE_SHEET_ID=                # optional; you can pick one in the UI
VITE_ALLOWED_EMAILS=          # optional whitelist (comma-separated)
```

> Note: `services/config.ts` has a `DEFAULT_CLIENT_ID` constant (the original author's). For your own deploy, override it via `VITE_GOOGLE_CLIENT_ID`.

### 3. Install + run

```bash
# from repo root
npm install         # delegates to portal/
npm run dev         # runs Vite dev server in portal/
# → http://localhost:5173/pghubtech/
```

The base path `/pghubtech/` is set in `portal/vite.config.ts` for GitHub Pages compatibility.

On first sign-in, the `SheetSetupModal` will let you create a new Sheet, and `ensureHeaders` lazily creates the tabs as you use features.

### 4. (Optional) Seed from Anki

Only if you want to import existing Anki decks:

```bash
cd scripts
npm install
# Make sure Anki desktop is running with AnkiConnect installed
# Make sure scripts/credentials.json (Desktop OAuth) is in place

# Phase 1: seed Templates tab + create per-template sheet tabs
node anki-seed-templates.mjs

# Phase 2: import notes (dry-run by default; add --write to commit)
node anki-to-sheets.mjs --deck "Your Deck" --write --upload-images
```

First run opens a browser for OAuth; the token is stored in `scripts/.token.json`.

Available flags for `anki-to-sheets.mjs`:

| Flag | Effect |
|------|--------|
| `--deck <name>`        | Anki deck name (required; quote names with spaces) |
| `--write`              | Commit rows to Sheets (default is dry-run) |
| `--upload-images`      | Mirror Anki media to Google Drive and rewrite `<img src>` URLs |
| `--update-images`      | Also rewrite local image srcs in already-migrated rows |
| `--drive-folder <name>`| Drive folder for images (default `PGHubTechImages`) |

Re-runs are idempotent — `anki_note_id` is the dedup key.

---

## Sheet schema

The app creates these tabs lazily as needed:

| Tab | Columns |
|---|---|
| `Items` | `id, title, content, tags, category, created_at, notes, status` |
| `Settings` | `key, value` |
| `Templates` | `template_id, template_name, field_key, field_label, field_type, is_front, is_back, field_order, options, …` (one row per field) |
| `<template_id>` (one per template) | `note_id, deck, anki_mod, <field1>, <field2>, …, tags` |
| `SRS_Progress` | `note_id, template_id, deck, state, interval_days, ease, reps, lapses, last_reviewed, next_due` |

---

## High-level functionality

- **Auth & access control** — Google sign-in, session restore, optional email whitelist, sheet-access verification
- **Sheet onboarding** — list existing sheets, pick by ID, or create a new one; auto-bootstrap headers/tabs
- **Anki-style review (HomeView)** — due-card queue, front/back flip, 4-rating SRS (Again/Hard/Good/Easy), "study all" mode, filter by tag/deck
- **Browse (BrowseView)** — table of all notes, schedule status, edit in side panel
- **Settings (SettingsView)** — change client ID/sheet, theme picker (6 themes), edit Anki templates (fields, types, front/back flags)
- **Offline-leaning SRS** — writes hit localStorage first, Sheets in background, merge-on-load with last-write-wins
- **Drive image hosting** — scripts mirror Anki media to a Drive folder so card HTML can render images
- **CI/CD** — push to `main` → GitHub Action builds portal with secrets and deploys to Pages

---

## File-a-card API (Apps Script)

Because the portal is a static SPA (no backend) that writes to Sheets using the
browser's Google login, there's no server to host an HTTP endpoint and no way
for an external caller to reuse that login. To add a `curl`-callable "file a
card from text" API, `apps-script/` contains a **Google Apps Script web app**
bound to the same Sheet:

- **POST free text** → it reads your templates + decks + sample tags, asks Azure
  OpenAI to pick the **best existing deck + template** and generate the card +
  tags, then appends the row in the **same format as Browse → Add Note**
  (`ankiRepo.appendAnkiNote`).
- Runs **as the sheet owner** (no service account); deployed **Execute as me /
  access: only myself**, so callers pass an **OAuth bearer token** for the owner
  account.
- Config (Sheet ID, Azure endpoint/key) lives in **Script Properties**.

```bash
TOKEN=$(gcloud auth print-access-token)   # same Google account that owns the script
curl -sS --location-trusted -X POST "$WEB_APP_URL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"Explain TCP vs UDP for a backend interview."}'
```

Full setup checklist, API reference, and troubleshooting: **`apps-script/README.md`**.

---

## Deployment

`.github/workflows/deploy.yml` builds and deploys on every push to `main`.

Required GitHub repo secrets (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|--------|---------|
| `GOOGLE_CLIENT_ID`  | Injected as `VITE_GOOGLE_CLIENT_ID` at build time |
| `ALLOWED_EMAILS`    | Injected as `VITE_ALLOWED_EMAILS` at build time |

The deployed site lives at `https://<user>.github.io/pghubtech/` — for this repo: **https://pradhapganesanjava.github.io/pghubtech/**.

> The base path `/pghubtech/` (set in `portal/vite.config.ts`) must match the GitHub repo name. If you fork under a different name, update `base` accordingly. The same origin must also be listed in your Google Cloud OAuth Client's "Authorized JavaScript origins", or sign-in will fail with `origin_mismatch`.

---

## Useful npm scripts

From the repo root:

```bash
npm install     # installs portal deps
npm run dev     # vite dev server
npm run build   # production build → portal/dist
```

Inside `portal/`:

```bash
npm run typecheck   # tsc -b
npm run lint        # eslint .
npm run preview     # serve the built dist locally
```
