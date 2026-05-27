#!/usr/bin/env node
/**
 * scripts/file-card.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * File ONE Anki note into the Google Sheet from a free-text message on the
 * command line. AI formats the passed-in passage into the chosen template's
 * fields ("sections"), picks the best EXISTING deck + template (unless you
 * pin them), suggests tags, then appends the row in the SAME format the portal
 * uses (Browse → Add Note → appendAnkiNote):
 *
 *     [ anki_note_id, deck, anki_mod, ...fieldValues(by order), tags.join(', ') ]
 *
 * This is the LOCAL CLI twin of apps-script/Code.gs (the curl-callable web app).
 * Same logic, but runs on your machine against the sheet using the OAuth token
 * the other scripts already use — no deployment required.
 *
 * PREREQUISITES
 * ─────────────
 * 1. scripts/credentials.json + scripts/.token.json (created by the seed step;
 *    a first run here will also mint a token via the browser if missing).
 * 2. portal/.env.local with:
 *      VITE_SHEET_ID=<spreadsheet id>
 *      VITE_AZURE_ENDPOINT=https://<resource>.openai.azure.com
 *      VITE_AZURE_API_KEY=<azure openai key>
 *      VITE_AZURE_DEPLOYMENT=<deployment>     (optional, default gpt-4o)
 *      VITE_AZURE_API_VERSION=<api version>   (optional, default 2024-12-01-preview)
 *
 * USAGE
 * ─────
 *   cd scripts && npm install                                 # first time only
 *   node scripts/file-card.mjs "Explain TCP vs UDP for a backend interview"
 *   node scripts/file-card.mjs --template leetcode --deck "DSA::Trees" "Two-pointer on sorted arrays"
 *   node scripts/file-card.mjs --dry-run "…"                  # preview, don't write
 *
 * FLAGS
 * ─────
 *   --template <id>   force this template (must exist; else AI picks)
 *   --deck <name>     force this deck (may be brand-new; else AI picks an existing one)
 *   --dry-run         resolve + print the card but DO NOT append a row
 *   -h, --help        show this help
 *
 * The trailing non-flag argument(s) form the message. Quote it.
 *
 * Mirrors: portal/src/adapters/ankiRepo.ts (schema + row format) and
 *          portal/src/lib/{llm.ts,ankiNoteGen.ts,looseJson.ts} (AI call + parse),
 *          via apps-script/Code.gs.
 */

import { google }                      from 'googleapis'
import { readFile, writeFile, unlink } from 'fs/promises'
import { createServer }        from 'http'
import { exec }                from 'child_process'
import { dirname, join }       from 'path'
import { fileURLToPath }       from 'url'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const DRAFT_PATH = join(__dir, '.card-draft.json')

const TEMPLATES_TAB   = 'Templates'
const MAX_TOKENS      = 1500
const SAMPLE_TAGS_MAX = 8   // sample tags shown per deck in the prompt
const DECKS_MAX       = 80  // cap decks listed in the prompt

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

// ─── CLI args ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { template: null, deck: null, dryRun: false, commit: false, discard: false, yes: false, help: false, words: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--template')      out.template = argv[++i] ?? null
    else if (a === '--deck')     out.deck     = argv[++i] ?? null
    else if (a === '--dry-run')  out.dryRun   = true
    else if (a === '--commit')   out.commit   = true
    else if (a === '--discard')  out.discard  = true
    else if (a === '-y' || a === '--yes' || a === '-f' || a === '--force') out.yes = true
    else if (a === '-h' || a === '--help') out.help = true
    else out.words.push(a)
  }
  out.text = out.words.join(' ').trim()
  return out
}

const HELP = `file-card — file one Anki note into the sheet from a text message

Two-step by default: a normal run RESOLVES + prints the card and saves a draft,
but does NOT write it. Review, then run --commit to file the exact previewed card
(no second AI call), or --discard to drop it. Use --force to skip the draft step.

Usage:
  node scripts/file-card.mjs [--template <id>] [--deck <name>] "<message>"   # draft + preview
  node scripts/file-card.mjs --commit                                        # file the saved draft
  node scripts/file-card.mjs --discard                                       # drop the saved draft
  node scripts/file-card.mjs --force [flags] "<message>"                     # one-shot: resolve + file, no confirm

Flags:
  --template <id>     force this template (else AI picks the best existing one)
  --deck <name>       force this deck (may be new; else AI picks an existing one)
  --dry-run           resolve + print only — no draft saved, nothing written
  --commit            file the previously saved draft (no AI call)
  --discard           delete the saved draft
  -f, --force, -y, --yes  resolve and file immediately, skipping the draft/confirm step
  -h, --help          show this help
`

// ─── Load env (sheet id + azure config) ───────────────────────────────────────
async function loadEnv() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  const env  = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  const sheetId = env.VITE_SHEET_ID
  if (!sheetId) throw new Error('Missing VITE_SHEET_ID in portal/.env.local')
  const azure = {
    endpoint:   (env.VITE_AZURE_ENDPOINT   ?? '').replace(/\/$/, ''),
    apiKey:     env.VITE_AZURE_API_KEY      ?? '',
    deployment: env.VITE_AZURE_DEPLOYMENT   ?? 'gpt-4o',
    apiVersion: env.VITE_AZURE_API_VERSION  ?? '2024-12-01-preview',
  }
  if (!azure.endpoint || !azure.apiKey) {
    throw new Error('Missing VITE_AZURE_ENDPOINT / VITE_AZURE_API_KEY in portal/.env.local')
  }
  return { sheetId, azure }
}

// ─── OAuth2 auth (identical flow to the other scripts) ────────────────────────
async function authorize() {
  let credRaw
  try { credRaw = await readFile(CREDS_PATH, 'utf8') } catch {
    throw new Error(
      'Missing scripts/credentials.json\n' +
      'Download from Google Cloud Console → APIs & Services → Credentials\n' +
      '(Create OAuth 2.0 Client ID → Desktop app, enable the Sheets API)'
    )
  }
  const creds = JSON.parse(credRaw)
  const cfg   = creds.installed ?? creds.web
  const oAuth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
  try {
    const token = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
    oAuth2Client.setCredentials(token)
    oAuth2Client.on('tokens', t => writeFile(TOKEN_PATH, JSON.stringify({ ...token, ...t })))
    return oAuth2Client
  } catch {
    return getNewToken(oAuth2Client)
  }
}

function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES })
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (!req.url?.startsWith('/')) return
      const code = new URL(req.url, 'http://localhost:3000').searchParams.get('code')
      if (!code) { res.end('No code received'); return }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h2>&#10003; Authorized! You can close this tab.</h2>')
      server.close()
      try {
        const { tokens } = await oAuth2Client.getToken(code)
        oAuth2Client.setCredentials(tokens)
        await writeFile(TOKEN_PATH, JSON.stringify(tokens))
        oAuth2Client.on('tokens', t => writeFile(TOKEN_PATH, JSON.stringify({ ...tokens, ...t })))
        console.log('  Token saved to scripts/.token.json')
        resolve(oAuth2Client)
      } catch (e) { reject(e) }
    })
    server.listen(3000, () => {
      console.log('\nOpening browser for Google authorization…')
      console.log('If the browser does not open, visit:\n  ' + authUrl + '\n')
      exec(`open "${authUrl}"`)
    })
    server.on('error', reject)
  })
}

// ─── Templates: parse the "Templates" tab (parity with fetchTemplates) ────────
async function loadTemplates(sheetsApi, sheetId) {
  const { data } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range:         `${TEMPLATES_TAB}!A:J`,
  })
  const rows = data.values ?? []
  if (!rows.length) throw new Error(`"${TEMPLATES_TAB}" tab is empty — run anki-seed-templates.mjs first`)

  const header = rows[0]
  const col = k => header.indexOf(k)

  const order = []   // preserve first-seen template order
  const byId  = new Map()
  for (const r of rows.slice(1)) {
    const id = String(r[col('template_id')] ?? '')
    if (!id) continue
    if (!byId.has(id)) {
      byId.set(id, { id, displayName: String(r[col('template_name')] ?? id), fields: [] })
      order.push(id)
    }
    const key = String(r[col('field_key')] ?? '')
    if (!key || key === 'tags') continue   // tags is a trailing column, not a field
    byId.get(id).fields.push({
      key,
      label:   String(r[col('field_label')] ?? key),
      type:    String(r[col('field_type')] ?? 'text'),
      isFront: String(r[col('is_front')]) === 'TRUE',
      isBack:  String(r[col('is_back')])  === 'TRUE',
      order:   parseInt(r[col('field_order')] ?? '0', 10) || 0,
      options: String(r[col('options')] ?? ''),
    })
  }

  return order.map(id => {
    const t = byId.get(id)
    t.fields.sort((a, b) => a.order - b.order)
    return t
  })
}

// ─── Decks + sample tags: scan each template tab once ─────────────────────────
async function loadDeckInfo(sheetsApi, sheetId, templates) {
  const deckMap    = new Map()   // deck -> { count, tagFreq:Map }
  const byTemplate = new Map()   // templateId -> Map(deck -> count)

  for (const t of templates) {
    let values
    try {
      const { data } = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range:         `${t.id}!A:Z`,
      })
      values = data.values ?? []
    } catch { continue }
    if (values.length < 2) continue

    const deckCol = 1                    // col B
    const tagsCol = 3 + t.fields.length  // trailing tags column (0-based)
    const tplDecks = byTemplate.get(t.id) ?? new Map()
    byTemplate.set(t.id, tplDecks)

    for (const r of values.slice(1)) {
      if (!r[0]) continue              // no note id → skip
      const deck = String(r[deckCol] ?? '').trim()
      if (!deck) continue

      const dm = deckMap.get(deck) ?? { count: 0, tagFreq: new Map() }
      dm.count++
      deckMap.set(deck, dm)
      tplDecks.set(deck, (tplDecks.get(deck) ?? 0) + 1)

      String(r[tagsCol] ?? '').split(',').forEach(tag => {
        const tg = tag.trim()
        if (tg) dm.tagFreq.set(tg, (dm.tagFreq.get(tg) ?? 0) + 1)
      })
    }
  }

  const decks = [...deckMap.entries()].map(([deck, info]) => {
    const sampleTags = [...info.tagFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, SAMPLE_TAGS_MAX)
      .map(e => e[0])
    return { deck, count: info.count, sampleTags }
  }).sort((a, b) => b.count - a.count)

  return { decks, byTemplate }
}

function mostCommonDeckForTemplate(deckInfo, templateId) {
  const m = deckInfo.byTemplate.get(templateId)
  if (!m) return ''
  let best = '', bestN = -1
  for (const [d, n] of m) if (n > bestN) { bestN = n; best = d }
  return best
}

// ─── AI call (parity with llm.ts + ankiNoteGen.ts, extended like Code.gs) ─────
function buildSystemPrompt(templates, deckInfo, pinnedTpl, pinnedDeck) {
  const tplBlock = templates.map(t => {
    const lines = t.fields.map(f => {
      const role = f.isFront ? 'FRONT' : f.isBack ? 'BACK' : 'EXTRA'
      const hint =
        (f.type === 'select' && f.options) ? `enum (one of: ${f.options})`
        : (f.type === 'html' || f.isFront || f.isBack) ? 'HTML allowed (<code>,<ul>,<strong>,<br>, …)'
        : 'plain text'
      return `      - "${f.key}" (${f.label}) — role=${role}, ${hint}`
    }).join('\n')
    return `  - templateId "${t.id}" — "${t.displayName}":\n${lines}`
  }).join('\n')

  const deckBlock = deckInfo.decks.slice(0, DECKS_MAX).map(d => {
    const st = d.sampleTags.length ? `  (sample tags: ${d.sampleTags.join(', ')})` : ''
    return `  - "${d.deck}"${st}`
  }).join('\n') || '  (no existing decks yet)'

  const out = [
    'You file ONE spaced-repetition flashcard into an existing Anki-style collection.',
    'The user message below is raw source material. REFORMAT it into the fields of the SINGLE best-fitting template, choosing the SINGLE best-fitting EXISTING deck.',
    'Faithfully restructure the message into the template\'s sections — do not invent facts beyond it, but you may tighten, split into FRONT/BACK, and lightly clean up for clarity.',
    'Output STRICT JSON ONLY — no prose, no markdown fences. First character "{", last character "}".',
    '',
    'Available templates (pick one "templateId"):',
    tplBlock,
    '',
    'Existing decks (pick one "deck", copied EXACTLY as written; reuse the sample tags where apt):',
    deckBlock,
    '',
    'Schema:',
    '{',
    '  "templateId": "<one of the templateIds above>",',
    '  "deck": "<one of the decks above, copied exactly>",',
    '  "tags": ["snake_case_topic", "tech::subtopic"],',
    '  "fields": { "<fieldKey>": "<value>", … }',
    '}',
    '',
    'Rules:',
    '1. Output JSON only. "templateId" MUST be exactly one of the listed ids.',
    '2. "deck" MUST be exactly one of the listed decks (copy the string verbatim, including "::").',
    '3. Every key in "fields" MUST be a field key of the chosen template. Omit/blank ("") fields that do not apply.',
    '4. FRONT field(s) = question/cue; BACK field(s) = answer/explanation; EXTRA = supporting context (fill only if useful).',
    '5. The card must be FULLY self-contained — understandable without the source message.',
    '6. For FRONT/BACK/html fields you may use safe inline HTML (<p>,<ul>,<li>,<strong>,<em>,<code>,<pre>,<br>). No <script>, <style>, or external URLs.',
    '7. For select fields the value MUST be one of its listed options exactly, else "".',
    '8. Tags: lowercase, snake_case, "::" for hierarchy, 1-4 tags; prefer reusing the deck\'s sample tags.',
  ]
  if (pinnedTpl)  out.push(`9. The caller REQUIRES templateId = "${pinnedTpl}". Use it.`)
  if (pinnedDeck) out.push(`10. The caller REQUIRES deck = "${pinnedDeck}". Use it.`)
  return out.join('\n')
}

async function azureChat(azure, messages, maxTokens) {
  const url = `${azure.endpoint}/openai/deployments/${azure.deployment}/chat/completions?api-version=${azure.apiVersion}`
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': azure.apiKey },
    body:    JSON.stringify({ messages, max_completion_tokens: maxTokens }),
  })
  const txt = await res.text()
  if (!res.ok) {
    let msg = txt
    try { msg = JSON.parse(txt).error.message } catch {}
    throw new Error(`Azure OpenAI HTTP ${res.status}: ${msg}`)
  }
  const data = JSON.parse(txt)
  return (data.choices?.[0]?.message?.content ?? '').trim()
}

// ─── Lenient JSON parse — parity with portal/src/lib/looseJson.ts ─────────────
function parseLooseJson(input) {
  const t = String(input ?? '').trim()
  if (!t) return null
  try { return JSON.parse(t) } catch {}
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i)
  if (fence) { try { return JSON.parse(fence[1]) } catch {} }
  const start = t.indexOf('{')
  const end   = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) } catch {}
  }
  if (start >= 0) {
    for (const c of repairedCandidates(t.slice(start))) {
      try { return JSON.parse(c) } catch {}
    }
  }
  return null
}

function repairedCandidates(input) {
  const stack = []
  let inStr = false, esc = false
  const snapshots = []
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (esc) { esc = false; continue }
    if (inStr) {
      if (c === '\\') { esc = true; continue }
      if (c === '"')  { inStr = false; continue }
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') { stack.push('}'); continue }
    if (c === '[') { stack.push(']'); continue }
    if (c === '}' || c === ']') {
      if (stack.pop() !== c) break
      snapshots.push({ end: i + 1, stack: stack.slice() })
      continue
    }
    if (c === ',') snapshots.push({ end: i, stack: stack.slice() })
  }
  const out = []
  if (stack.length === 0 && !inStr) out.push(input)
  const MAX_ATTEMPTS = 300
  let attempts = 0
  for (let j = snapshots.length - 1; j >= 0 && attempts < MAX_ATTEMPTS; j--, attempts++) {
    const snap = snapshots[j]
    let trimmed = input.slice(0, snap.end).replace(/[\s,]+$/, '')
    for (let k = snap.stack.length - 1; k >= 0; k--) trimmed += snap.stack[k]
    out.push(trimmed)
  }
  return out
}

// ─── Resolution / validation helpers ──────────────────────────────────────────
function findTemplateById(templates, id) {
  if (!id) return null
  return templates.find(t => t.id === id) ?? null
}

function resolveDeck(bodyDeck, aiDeck, existingDecks, fallbackDeck) {
  const canon = name => {
    if (!name) return ''
    return existingDecks.find(d => d.toLowerCase() === name.toLowerCase()) ?? ''
  }
  if (bodyDeck) return canon(bodyDeck) || bodyDeck   // explicit deck may be new
  const c = canon(aiDeck)
  if (c) return c
  if (fallbackDeck) return fallbackDeck
  return existingDecks.length ? existingDecks[0] : ''
}

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set(), out = []
  for (const t of raw) {
    if (typeof t !== 'string') continue
    const tg = t.trim()
    if (tg && !seen.has(tg)) { seen.add(tg); out.push(tg) }
  }
  return out
}

// Row format identical to ankiRepo.appendAnkiNote:
//   [noteId, deck, ankiMod, ...fieldValues(sorted by order), tags.join(', ')]
function buildRow(template, noteId, deck, ankiMod, fields, tags) {
  const sorted = [...template.fields].sort((a, b) => a.order - b.order)
  const fieldValues = sorted.map(f => fields[f.key] ?? '')
  return [noteId, deck, ankiMod, ...fieldValues, tags.join(', ')]
}

// noteId format identical to AddNoteModal: c-<base36 time>-<rand5>
function newNoteId() {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

async function appendRow(sheetsApi, sheetId, tabName, row) {
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId:    sheetId,
    range:            `${tabName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: [row] },
  })
}

// ─── Draft store (split: resolve now, write on confirm) ───────────────────────
// Phase 1 stashes the fully-resolved card here; --commit appends it verbatim so
// the filed card is byte-identical to the one previewed (no second AI call).
async function writeDraft(draft) {
  await writeFile(DRAFT_PATH, JSON.stringify(draft, null, 2))
}

async function clearDraft() {
  try { await unlink(DRAFT_PATH) } catch {}
}

async function commitDraft(sheetsApi, sheetId) {
  let draft
  try { draft = JSON.parse(await readFile(DRAFT_PATH, 'utf8')) }
  catch { throw new Error('No draft to commit — run a normal (no-flag) command first to create one.') }
  await appendRow(sheetsApi, sheetId, draft.templateId, draft.row)
  await clearDraft()
  console.log(`✓ Card filed to "${draft.templateId}" tab.  noteId=${draft.noteId}`)
}

function printCard(template, deck, tags, fields) {
  console.log('\n─── Card (proposed) ─────────────────────────────')
  console.log(`  template : ${template.displayName} (${template.id})`)
  console.log(`  deck     : ${deck}`)
  console.log(`  tags     : ${tags.join(', ') || '—'}`)
  for (const f of [...template.fields].sort((a, b) => a.order - b.order)) {
    const val = (fields[f.key] ?? '').replace(/\s+/g, ' ').trim()
    console.log(`  ${f.label.padEnd(10)}: ${val.length > 100 ? val.slice(0, 100) + '…' : (val || '—')}`)
  }
  console.log('─────────────────────────────────────────────────\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return }

  // --discard needs nothing else (no auth, no env).
  if (args.discard) { await clearDraft(); console.log('Draft discarded.'); return }

  // Nothing actionable (no message, not committing) → show usage and stop,
  // BEFORE touching env/auth, so a bare invocation always explains itself
  // instead of erroring on missing config or auth.
  if (!args.commit && !args.text) {
    console.log('No message given — here is how to use it:\n')
    console.log(HELP)
    return
  }

  const { sheetId, azure } = await loadEnv()
  const auth      = await authorize()
  const sheetsApi = google.sheets({ version: 'v4', auth })

  // --commit just files the previously saved draft — no sheet read, no AI call.
  if (args.commit) { await commitDraft(sheetsApi, sheetId); return }

  // ── Phase 1 — resolve the card (read sheet + AI). Nothing is stored yet. ─────
  console.log('Reading templates + decks…')
  const templates = await loadTemplates(sheetsApi, sheetId)
  if (!templates.length) throw new Error(`No templates found in the "${TEMPLATES_TAB}" tab.`)
  const deckInfo = await loadDeckInfo(sheetsApi, sheetId, templates)

  console.log('Asking AI to format the message into card fields…')
  const system = buildSystemPrompt(templates, deckInfo, args.template ?? '', args.deck ?? '')
  const reply  = await azureChat(azure, [
    { role: 'system', content: system },
    { role: 'user',   content: args.text },
  ], MAX_TOKENS)
  const ai = parseLooseJson(reply) ?? {}

  // Resolve template (CLI override → AI choice → first)
  const template =
    findTemplateById(templates, args.template) ||
    findTemplateById(templates, ai.templateId) ||
    templates[0]

  // Resolve deck (never invents one unless you pass --deck)
  const existingDecks = deckInfo.decks.map(d => d.deck)
  const deck = resolveDeck(
    args.deck ? args.deck.trim() : '',
    ai.deck ? String(ai.deck).trim() : '',
    existingDecks,
    mostCommonDeckForTemplate(deckInfo, template.id),
  )
  if (!deck) throw new Error('Could not determine a deck (no existing decks and none supplied via --deck).')

  // Keep only the chosen template's field keys; coerce to strings
  const fields = {}
  for (const f of template.fields) {
    const v = ai.fields ? ai.fields[f.key] : ''
    fields[f.key] = (v == null) ? '' : String(v)
  }
  const tags    = normalizeTags(ai.tags)
  const noteId  = newNoteId()
  const ankiMod = String(Date.now())
  const row     = buildRow(template, noteId, deck, ankiMod, fields, tags)

  printCard(template, deck, tags, fields)

  // ── Phase 2 — decide whether to store ────────────────────────────────────────
  if (args.dryRun) {
    console.log('[dry-run] Nothing saved — no draft, no row written.')
    return
  }
  if (args.yes) {
    await appendRow(sheetsApi, sheetId, template.id, row)
    console.log(`✓ Card filed to "${template.id}" tab.  noteId=${noteId}`)
    return
  }

  // Default: stash the resolved card and wait for confirmation (--commit).
  await writeDraft({ templateId: template.id, templateName: template.displayName, deck, noteId, ankiMod, tags, fields, row })
  console.log('Draft saved — NOT yet filed. Review the card above, then:')
  console.log('  • file it:    node scripts/file-card.mjs --commit')
  console.log('  • discard it: node scripts/file-card.mjs --discard')
}

main().catch(e => { console.error('\n✗ ' + (e?.message ?? e)); process.exitCode = 1 })
