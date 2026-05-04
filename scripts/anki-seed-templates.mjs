#!/usr/bin/env node
/**
 * scripts/anki-seed-templates.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1 — Seed the "Templates" sheet with Anki template definitions,
 * then create/update each template's data sheet tab with correct column headers.
 *
 * Analogous to seed-templates.mjs in pg-hub-ads but targeting Google Sheets
 * instead of Firebase Firestore.
 *
 * PREREQUISITES
 * ─────────────
 * 1. Anki desktop must be OPEN with AnkiConnect installed (add-on: 2055492159).
 * 2. scripts/credentials.json — OAuth2 Desktop app client secrets from Google
 *    Cloud Console (APIs & Services → Credentials → Create OAuth client ID →
 *    Desktop app).  Enable Sheets API + Drive API for the project.
 * 3. portal/.env.local must contain:
 *      VITE_GOOGLE_SHEET_ID=<your-sheet-id>
 *    The sheet must exist; the user must be its owner.
 *
 * USAGE
 * ─────
 *   cd scripts && npm install         # first time only
 *   node scripts/anki-seed-templates.mjs
 *
 * On first run a browser opens for Google OAuth2 authorization.
 * The token is stored in scripts/.token.json for subsequent runs.
 */

import { google }               from 'googleapis'
import { readFile, writeFile }  from 'fs/promises'
import { createServer }         from 'http'
import { exec }                 from 'child_process'
import { dirname, join }        from 'path'
import { fileURLToPath }        from 'url'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const ANKI       = 'http://127.0.0.1:8765'

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
]

// ─── AnkiConnect ─────────────────────────────────────────────────────────────
async function anki(action, params = {}) {
  const res = await fetch(ANKI, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action, version: 6, params }),
  })
  if (!res.ok) throw new Error(`AnkiConnect HTTP ${res.status}`)
  const { result, error } = await res.json()
  if (error) throw new Error(`AnkiConnect[${action}]: ${error}`)
  return result
}

// ─── Load env from portal/.env.local ─────────────────────────────────────────
async function loadEnv() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  const env  = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  const sheetId = env.VITE_SHEET_ID
  if (!sheetId) throw new Error('Missing VITE_SHEET_ID in portal/.env.local')
  return { sheetId }
}

// ─── OAuth2 auth ──────────────────────────────────────────────────────────────
async function authorize() {
  let credRaw
  try { credRaw = await readFile(CREDS_PATH, 'utf8') } catch {
    throw new Error(
      'Missing scripts/credentials.json\n' +
      'Download it from Google Cloud Console → APIs & Services → Credentials\n' +
      '(Create OAuth 2.0 Client ID → Desktop app, then enable Sheets + Drive APIs)'
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

// ─── Sheets helpers ───────────────────────────────────────────────────────────
async function getSheetTabs(sheetsApi, sheetId) {
  const { data } = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties.title' })
  return (data.sheets ?? []).map(s => s.properties.title)
}

async function ensureTab(sheetsApi, sheetId, title) {
  const tabs = await getSheetTabs(sheetsApi, sheetId)
  if (tabs.includes(title)) return false
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody:   { requests: [{ addSheet: { properties: { title } } }] },
  })
  console.log(`  Created sheet tab: "${title}"`)
  return true
}

async function clearAndWriteSheet(sheetsApi, sheetId, tabName, rows) {
  // Clear all data rows (keep nothing)
  await sheetsApi.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range:         `${tabName}!A:ZZ`,
  })
  if (!rows.length) return
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId:     sheetId,
    range:             `${tabName}!A1`,
    valueInputOption:  'RAW',
    requestBody:       { values: rows },
  })
}

async function ensureHeaders(sheetsApi, sheetId, tabName, headers) {
  const { data } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range:         `${tabName}!A1:1`,
  })
  const existing = (data.values ?? [])[0] ?? []
  if (JSON.stringify(existing) === JSON.stringify(headers)) return  // already correct
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId:     sheetId,
    range:             `${tabName}!A1`,
    valueInputOption:  'RAW',
    requestBody:       { values: [headers] },
  })
  console.log(`  Updated headers in "${tabName}"`)
}

// ─── Field-type helpers (same logic as anki-full-sync.mjs in pg-hub-ads) ─────
const HTML_TAG_RE = /<[a-zA-Z][^>]*>/

function guessTypeFromName(name) {
  const k = name.toLowerCase()
  if (k === 'id' || k === 'lc_num' || k === 'num')               return 'number'
  if (k.startsWith('tag') || k === 'tags')                        return 'tags'
  if (k === 'difficult' || k === 'difficulty' || k === 'lc_diff') return 'select'
  return null
}

function guessTypeFromValues(values) {
  return values.some(v => HTML_TAG_RE.test(v)) ? 'html' : 'text'
}

function extractTemplateFields(tmplHtml) {
  return new Set(
    [...(tmplHtml ?? '').matchAll(/\{\{([^#/!][^}]*?)\}\}/g)]
      .map(m => m[1].trim().replace(/^[^:]+:/, ''))
      .filter(f => !['FrontSide', 'Tags', 'Deck', 'Subdeck', 'CardFlag', 'Card'].includes(f))
  )
}

const MODEL_RENAMES = {
  'pg-leetcode-template': {
    id:         'lc_num',
    difficult:  'lc_diff',
    difficulty: 'lc_diff',
    ref:        'lc_title',
    link_base:  'lc_url',
    tag_leet:   'tags',
  },
}

const MODEL_EXTRA_FIELDS = {
  'pg-leetcode-template': [
    { key: 'lc_slug', label: 'LC Slug', type: 'text', isFront: false, isBack: false, required: false },
  ],
}

function toLabel(name) {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/^Lc /i, 'LC ')
}

function modelNameToTemplateId(modelName) {
  const known = {
    'pg-leetcode-template':         'pg-leetcode-template',
    'pg-solstool-template':         'pg-solstool-template',
    'ads-pattern':                  'ads-pattern',
    'pg-notes':                     'pg-notes',
    'Basic':                        'basic',
    'Basic (and reversed card)':    'basic-reversed',
    'Cloze':                        'basic-cloze',
  }
  return known[modelName] ?? modelName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

async function buildTemplate(modelName, sampleNotes = []) {
  const fieldNames   = await anki('modelFieldNames', { modelName })
  const cardTemplates = await anki('modelTemplates', { modelName })
  const firstCard    = Object.values(cardTemplates)[0] ?? {}
  const frontFields  = extractTemplateFields(firstCard.Front ?? '')
  const backFields   = extractTemplateFields(firstCard.Back  ?? '')

  const samples = {}
  for (const note of sampleNotes.slice(0, 5)) {
    for (const [k, v] of Object.entries(note.fields ?? {})) {
      if (!samples[k]) samples[k] = []
      if (v.value) samples[k].push(v.value)
    }
  }

  const renames  = MODEL_RENAMES[modelName] ?? {}
  const usedKeys = new Set()

  const fields = fieldNames.map((ankiName, idx) => {
    const fbKey = renames[ankiName] ?? ankiName
    if (usedKeys.has(fbKey)) return null
    usedKeys.add(fbKey)

    const guessed = guessTypeFromName(ankiName)
    const type    = guessed ?? guessTypeFromValues(samples[ankiName] ?? [])

    const isFront = frontFields.has(ankiName)
    const isBack  = backFields.has(ankiName) && !isFront
      ? true
      : !frontFields.has(ankiName) && !backFields.has(ankiName)
        ? false
        : backFields.has(ankiName)

    return {
      key: fbKey,
      label: toLabel(ankiName),
      type,
      order: idx,
      isFront,
      isBack,
      required: false,
      options: type === 'select' ? 'Easy,Medium,Hard' : '',
    }
  }).filter(Boolean)

  for (const extra of MODEL_EXTRA_FIELDS[modelName] ?? []) {
    if (!fields.some(f => f.key === extra.key)) {
      fields.push({ ...extra, order: fields.length, required: false, options: '' })
    }
  }

  if (!fields.some(f => f.type === 'tags')) {
    fields.push({ key: 'tags', label: 'Tags', type: 'tags', order: fields.length, isFront: false, isBack: false, required: false, options: '' })
  }

  return { id: modelNameToTemplateId(modelName), displayName: modelName, fields }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(60))
  console.log('  PG Hub Tech — Seed Templates from Anki → Google Sheets')
  console.log('═'.repeat(60))

  // AnkiConnect check
  try {
    const v = await anki('version')
    console.log(`\nAnkiConnect v${v}: OK`)
  } catch (e) {
    console.error(`\n✗ Cannot reach AnkiConnect: ${e.message}`)
    if (e.cause) console.error(`  cause: ${e.cause}`)
    console.error('  1. Anki desktop is OPEN')
    console.error('  2. AnkiConnect add-on is installed (code: 2055492159)')
    process.exit(1)
  }

  const { sheetId } = await loadEnv()
  console.log(`Google Sheet ID: ${sheetId}`)

  const auth     = await authorize()
  const sheetsApi = google.sheets({ version: 'v4', auth })

  // ── Discover models + sample notes ────────────────────────────────────────
  console.log('\n── Discovering Anki models ─────────────────────────────────')
  const modelNames = await anki('modelNames')
  console.log(`  Found ${modelNames.length} model(s)`)

  const CHUNK   = 50
  const allNoteIds = await anki('findNotes', { query: 'deck:*' })
  const allNotes   = []
  for (let i = 0; i < allNoteIds.length; i += CHUNK) {
    const infos = await anki('notesInfo', { notes: allNoteIds.slice(i, i + CHUNK) })
    allNotes.push(...infos)
    process.stdout.write(`\r  Fetching notes: ${Math.min(i + CHUNK, allNoteIds.length)}/${allNoteIds.length}`)
  }
  console.log()

  const notesByModel = new Map()
  for (const note of allNotes) {
    if (!notesByModel.has(note.modelName)) notesByModel.set(note.modelName, [])
    notesByModel.get(note.modelName).push(note)
  }

  // ── Build templates ────────────────────────────────────────────────────────
  console.log('\n── Building template definitions ───────────────────────────')
  const templates = []
  for (const modelName of modelNames) {
    const samples = notesByModel.get(modelName) ?? []
    if (!samples.length) {
      console.log(`  [skip] ${modelName} — no notes`)
      continue
    }
    const tmpl = await buildTemplate(modelName, samples)
    templates.push(tmpl)
    console.log(`  ${tmpl.id.padEnd(32)} ${tmpl.fields.length} fields  (${samples.length} notes)`)
  }

  // ── Ensure "Templates" tab exists ─────────────────────────────────────────
  console.log('\n── Writing to Google Sheets ────────────────────────────────')
  await ensureTab(sheetsApi, sheetId, 'Templates')

  // Build rows for Templates sheet: one row per field per template
  const TMPL_HEADERS = [
    'template_id', 'template_name', 'field_order', 'field_key',
    'field_label', 'field_type', 'is_front', 'is_back', 'required', 'options',
  ]
  const tmplRows = [TMPL_HEADERS]
  for (const tmpl of templates) {
    for (const f of tmpl.fields) {
      tmplRows.push([
        tmpl.id,
        tmpl.displayName,
        String(f.order),
        f.key,
        f.label,
        f.type,
        f.isFront  ? 'TRUE' : 'FALSE',
        f.isBack   ? 'TRUE' : 'FALSE',
        f.required ? 'TRUE' : 'FALSE',
        f.options ?? '',
      ])
    }
  }

  await clearAndWriteSheet(sheetsApi, sheetId, 'Templates', tmplRows)
  console.log(`  Templates sheet: ${tmplRows.length - 1} field rows written`)

  // ── Create per-template data sheets ───────────────────────────────────────
  console.log('\n── Creating per-template data sheets ───────────────────────')
  const SYS_COLS = ['anki_note_id', 'deck', 'anki_mod']
  for (const tmpl of templates) {
    await ensureTab(sheetsApi, sheetId, tmpl.id)
    const headers = [...SYS_COLS, ...tmpl.fields.map(f => f.key)]
    await ensureHeaders(sheetsApi, sheetId, tmpl.id, headers)
    console.log(`  "${tmpl.id}": ${headers.length} columns`)
  }

  console.log('\n' + '═'.repeat(60))
  console.log(`  Done. ${templates.length} template(s) seeded.`)
  console.log('  Next: node scripts/anki-to-sheets.mjs --deck <name> --write')
  console.log('═'.repeat(60) + '\n')
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1) })
