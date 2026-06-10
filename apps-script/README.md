# File-a-card Web App (Google Apps Script)

A `curl`-callable HTTP endpoint that turns a **free-text payload** into a **new
Anki note** in your Google Sheet. It asks Azure OpenAI to pick the **best
existing deck + template**, generate the card fields, and suggest **tags**,
then appends the row in the **exact same format the portal uses** — so a card
filed via curl is indistinguishable from one added through Browse → Add Note.

> **Status: code complete, not yet deployed.** Everything in `apps-script/` is
> finished and unit-tested. What's left is the one-time Google-side setup in
> the [Setup checklist](#setup-checklist) below — you do this in your own
> Google account; it can't be scripted from the repo.

---

## Contents

- [Why this exists (the design constraints)](#why-this-exists-the-design-constraints)
- [Setup checklist](#setup-checklist) ← **start here when you pick this up**
- [How a request flows](#how-a-request-flows)
- [API reference](#api-reference)
- [Calling it with curl](#calling-it-with-curl)
- [Configuration reference](#configuration-reference)
- [How it stays in parity with the portal](#how-it-stays-in-parity-with-the-portal)
- [Troubleshooting](#troubleshooting)
- [Future ideas](#future-ideas)

---

## Why this exists (the design constraints)

The portal (`portal/`) is a **pure static React SPA — there is no backend
server.** Two things happen entirely in the browser:

- **AI calls** → the browser fetches Azure OpenAI directly (`portal/src/lib/llm.ts`).
- **Saving a note** → the browser writes to Google Sheets using **your
  interactive Google sign-in token** (`GAuth.getToken()` →
  `Authorization: Bearer …`), in `ankiRepo.appendAnkiNote`.

A `curl`-callable URL needs a server to host it, and that server **cannot reuse
the browser's Google login.** That forced two decisions:

| Decision | Choice made | Why |
|---|---|---|
| **Where it runs** | **Google Apps Script web app** | The data already lives in a Google Sheet. A script bound to that Sheet by ID runs **as the sheet owner (you)** via `SpreadsheetApp` — no service account, no token juggling, no extra hosting. It gets a `curl`-ready `/exec` URL for free. |
| **Who can call it** | **Restricted to my Google account** (`access: MYSELF`) | The endpoint can write to your sheet and spend your Azure quota, so it shouldn't be open. Trade-off accepted: every curl call must carry an **OAuth bearer token for the owner account** (not just the URL). See [Calling it with curl](#calling-it-with-curl). |

Azure OpenAI keys and the Sheet ID live in **Script Properties** (server-side),
not in the payload — so secrets never travel over the wire.

---

## Setup checklist

Do these in order. ~5–10 minutes, all in your Google account.

- [ ] **1. Create the Apps Script project** (see [options below](#1-create-the-project))
- [ ] **2. Paste `Code.gs` + `appsscript.json`** from this folder
- [ ] **3. Set Script Properties:** `SHEET_ID`, `AZURE_ENDPOINT`, `AZURE_API_KEY` (+ optional `AZURE_DEPLOYMENT`, `AZURE_API_VERSION`)
- [ ] **4. Run `test_` once** to authorize scopes & confirm a row is written
- [ ] **5. Deploy → New deployment → Web app** (Execute as *Me*, Access *Only myself*); copy the `/exec` URL
- [ ] **6. Get an OAuth token** (`gcloud auth print-access-token`) and make a test `curl`
- [ ] **7. (Optional)** save the `/exec` URL somewhere handy; bookmark this README

### 1. Create the project

**Option A — paste in the browser**
1. Go to <https://script.google.com> → **New project**.
2. Replace the default `Code.gs` with this folder's [`Code.gs`](./Code.gs).
3. Project Settings (⚙) → tick **"Show appsscript.json manifest in editor"**,
   then replace the manifest with this folder's [`appsscript.json`](./appsscript.json).

**Option B — push with [clasp](https://github.com/google/clasp)** (keeps the source in this repo)
```bash
npm i -g @google/clasp
clasp login
cd apps-script
clasp create --type standalone --title "pghubtech file-a-card"   # writes .clasp.json
clasp push
```
> `.clasp.json` holds your script id; it's gitignore-worthy if you don't want it committed.

### 2–3. Script Properties

Project Settings (⚙) → **Script Properties** → add:

| Property            | Required | Value                                                       |
| ------------------- | :------: | ----------------------------------------------------------- |
| `SHEET_ID`          | ✅       | your spreadsheet id (same as the portal's `VITE_SHEET_ID`)  |
| `AZURE_ENDPOINT`    | ✅       | `https://<resource>.openai.azure.com`                       |
| `AZURE_API_KEY`     | ✅       | your Azure OpenAI key                                       |
| `AZURE_DEPLOYMENT`  | –        | deployment/model name — default `gpt-4o`                    |
| `AZURE_API_VERSION` | –        | default `2024-12-01-preview`                                |

> The Sheet ID is the long token in the sheet URL:
> `https://docs.google.com/spreadsheets/d/`**`<SHEET_ID>`**`/edit`.

### 4. Authorize & smoke-test

In the editor toolbar, pick the **`test_`** function → **Run**. Approve the
consent screen (it requests Sheets access + external requests). Open
**Execution log** — you should see a JSON result with `"ok": true` and a
`noteId`, and a new row should appear in the matching template tab of your
sheet. (`test_` files a real card titled around "TCP vs UDP" — delete it
afterward if you don't want it.)

### 5. Deploy

**Deploy → New deployment → ⚙ → Web app**
- **Execute as:** *Me*
- **Who has access:** *Only myself*

Copy the **Web app URL** (ends in `/exec`):
`https://script.google.com/macros/s/AKfy…/exec`

> ⚠️ **Re-deploy after every code change.** Editing `Code.gs` does *not* update
> the live URL. Use **Manage deployments → (edit) → Version: New version**, or
> the URL keeps serving the old code. (A *test deployment* / `/dev` URL always
> runs the latest code but is only callable by you in the editor session.)

---

## How a request flows

```
curl  ──POST {text}──>  /exec  (doPost)
                          │
                          ├─ loadTemplates_(ss)      read "Templates" tab → templates + field schemas
                          ├─ loadDeckInfo_(ss, …)     scan each template tab → decks + sample tags
                          ├─ askAi_(text, …)          Azure OpenAI: pick templateId + deck, write fields + tags
                          ├─ resolve template/deck    AI choice → body override → fallback (never invents a deck)
                          ├─ buildRow_(…)             [noteId, deck, anki_mod, ...fieldValues(by order), tags.join(', ')]
                          └─ sheet.appendRow(row)     append to the chosen <templateId> tab
                          │
                       JSON  <── { ok:true, noteId, templateId, deck, tags, fields }
```

The model is given **every template's field schema** and **every existing deck
with its most common sample tags**, and is told to choose exactly one of each
and reuse tags where apt.

---

## API reference

### Request

`POST <web-app-url>` with `Content-Type: application/json`:

```jsonc
{
  "text": "Explain TCP vs UDP for a backend interview, with when to use each.",  // REQUIRED

  // Optional overrides — the model chooses both by default:
  "templateId": "leetcode",   // force this template (must exist)
  "deck": "DSA::Trees"        // force this deck (MAY be a brand-new deck)
}
```

Deck-resolution rules:
- A `deck` **in the body** wins and is allowed to be a brand-new deck.
- An **AI-chosen** deck is canonicalised to an existing deck (case-insensitive);
  if it matches none, it falls back to the most common deck for the chosen
  template — so the AI **never invents** a deck.

### Response (success)

```json
{
  "ok": true,
  "message": "Card added.",
  "noteId": "c-ly8x2k-q9d2f",
  "templateId": "basic",
  "templateName": "Basic",
  "deck": "Networking::Transport",
  "tags": ["networking", "tcp", "udp"],
  "fields": { "Front": "…", "Back": "…" }
}
```

### Response (error)

```json
{ "ok": false, "error": "Azure OpenAI not configured — set AZURE_ENDPOINT and AZURE_API_KEY in Script Properties." }
```

> Apps Script's `doPost` always returns **HTTP 200**, even on failure — so
> **branch on the `ok` field**, not the HTTP status.

### Health check

`GET <web-app-url>` (still needs the bearer token) returns usage JSON:
```json
{ "ok": true, "service": "pghubtech file-a-card", "usage": "POST JSON { \"text\": … }" }
```

---

## Calling it with curl

Because access is **Only myself**, every request needs
`Authorization: Bearer <token>` for **the same Google account** that owns the
script. The `/exec` endpoint 302-redirects to `googleusercontent.com`, so use
`--location-trusted` so curl keeps the auth header across the redirect.

### Get a token

**Easiest — gcloud** (log in as the owner account):
```bash
gcloud auth login                      # use the SAME Google account that owns the script
TOKEN=$(gcloud auth print-access-token)
```

**Fallback — OAuth 2.0 Playground** (<https://developers.google.com/oauthplayground>):
authorize scopes `https://www.googleapis.com/auth/spreadsheets` and
`openid email`, then copy the access token. (Gear ⚙ → "Use your own OAuth
credentials" tied to the same GCP project if the default client is rejected.)

### Make the request

```bash
URL="https://script.google.com/macros/s/AKfy…/exec"

curl -sS --location-trusted -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Explain TCP vs UDP for a backend interview, with when to use each."}'
```

Pin a deck/template:
```bash
curl -sS --location-trusted -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"Two-pointer technique on sorted arrays","templateId":"leetcode","deck":"DSA::TwoPointers"}'
```

> Tokens from `gcloud auth print-access-token` are short-lived (~1 hour);
> re-run it when curl starts returning a login/HTML page instead of JSON.

---

## Configuration reference

All config is read from **Script Properties** via `cfg_()` in `Code.gs`
(mirrors `portal/src/services/config.ts` / `lib/llm.ts`):

| Key | Default | Used by | Mirrors (portal) |
|---|---|---|---|
| `SHEET_ID`          | — (required)            | `sheetId_()` → `SpreadsheetApp.openById` | `Config.sheetId` |
| `AZURE_ENDPOINT`    | — (required)            | `azureChat_()` URL | `Config.azureEndpoint` |
| `AZURE_API_KEY`     | — (required)            | `azureChat_()` `api-key` header | `Config.azureApiKey` |
| `AZURE_DEPLOYMENT`  | `gpt-4o`                | `azureChat_()` URL | `Config.azureDeployment` |
| `AZURE_API_VERSION` | `2024-12-01-preview`    | `azureChat_()` URL | `Config.azureApiVersion` |

Tunables (constants at the top of `Code.gs`):

| Const | Default | Meaning |
|---|---|---|
| `MAX_TOKENS`       | `1500` | `max_completion_tokens` for the completion |
| `SAMPLE_TAGS_MAX`  | `8`    | sample tags shown per deck in the prompt |
| `DECKS_MAX`        | `80`   | max decks listed in the prompt |

---

## How it stays in parity with the portal

So curl-filed cards are byte-identical to Browse/Add cards, `Code.gs` mirrors
these portal sources:

| Concern | `Code.gs` function | Portal source |
|---|---|---|
| Template parsing (`Templates` tab; skip the `tags` field; header-indexed) | `loadTemplates_` | `ankiRepo.ts` → `fetchTemplates` |
| Tags column location (`3 + fields.length`) | `loadDeckInfo_` | `ankiRepo.ts` → `loadAnkiNotes` |
| Row format `[noteId, deck, anki_mod, ...fieldValues(by order), tags.join(', ')]` | `buildRow_` | `ankiRepo.ts` → `appendAnkiNote` |
| `noteId` = `c-<base36 time>-<rand5>` | `newNoteId_` | `AddNoteModal.tsx` `handleSave` |
| Azure chat-completions call | `azureChat_` | `lib/llm.ts` → `LLM.chat` |
| Card prompt (field roles/hints, JSON schema, rules) | `buildSystemPrompt_` | `lib/ankiNoteGen.ts` → `buildSystemPrompt` (extended here to also choose template + deck) |
| Lenient JSON parse incl. truncation repair | `parseLooseJson_` / `repairedCandidates_` | `lib/looseJson.ts` |

> If you change the sheet schema or the portal's row format, update the matching
> function here too.

> ⚠️ **Large-field offload not mirrored.** The portal offloads any field over
> Sheets' 50,000-char cell cap to a Drive file and stores a
> `PGHUB_FIELD_REF::<driveFileId>` pointer in the cell (see root `README.md` →
> *Storage & resilience invariants*, `portal/src/lib/driveFields.ts`). `Code.gs`
> does **not** do this: it writes field text directly, so an AI-generated field
> over 50k chars will fail the `appendRow` with a Sheets cell-size error. In
> practice generated cards are far smaller, but if this becomes an issue, port
> the offload logic (upload to Drive via `DriveApp`, write the pointer) here. It
> also does not *resolve* pointers if it ever reads existing card content.

Sheet schema this relies on (see root `README.md` → *Sheet schema*):
- `Templates` tab: `template_id, template_name, field_key, field_label, field_type, is_front, is_back, field_order, options` (one row per field; a `tags` row is ignored as a field and handled as the trailing column).
- `<template_id>` tab: `anki_note_id, deck, anki_mod, <field…>, tags`.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| curl returns an **HTML login page** instead of JSON | Missing/expired token, or you dropped the auth header across the redirect. Re-run `gcloud auth print-access-token` and ensure `--location-trusted` is present. |
| `401` / `403` / "You do not have permission" | The token's Google account ≠ the script owner, or the deployment isn't *Only myself / Execute as me*. Re-auth as the owner; recheck deployment settings. |
| Scope rejection when minting the token | Use the OAuth Playground fallback with explicit scopes (`spreadsheets`, `openid email`), or add those scopes to your gcloud auth. |
| `{ "ok": false, "error": "Azure OpenAI not configured…" }` | `AZURE_ENDPOINT` / `AZURE_API_KEY` Script Properties are missing or blank. |
| `{ "ok": false, "error": "SHEET_ID not set…" }` | Add the `SHEET_ID` Script Property. |
| `{ "ok": false, "error": "No templates found…" }` | The `Templates` tab is empty or named differently. (Tab name is `Templates` — see `TEMPLATES_TAB`.) |
| Card written but **fields look wrong / empty** | The model returned keys that don't match the chosen template; only declared field keys are kept. Check the template's `field_key`s and the Azure deployment quality. |
| **Old behavior after editing `Code.gs`** | You didn't re-deploy a new version. Manage deployments → edit → Version: *New version*. |
| Edits work in editor but not via the `/exec` URL | You're testing the `/dev` (head) URL vs the deployed `/exec` URL — they can differ until you re-deploy. |

Server-side logs: **Apps Script editor → Executions** shows each `doPost` run,
its arguments, `Logger.log` output, and stack traces.

---

## Future ideas

- **Lower-friction auth:** deploy *Who has access: Anyone* and add a
  shared-secret check inside `doPost` (e.g. compare a `secret` body field to a
  Script Property). Deliberately *not* done — account-restriction was chosen for
  security. Easy to add later if curl-with-token gets annoying.
- **Batch mode:** accept `{ "texts": [ … ] }` and append multiple rows in one
  call (mirror `appendAnkiNotesBulk`).
- **Keep source in-repo via clasp** so `Code.gs` is versioned alongside the
  portal and pushed with `clasp push`.
- **SRS seeding:** also write an initial `SRS_Progress` row for the new note so
  it enters the review queue immediately.
