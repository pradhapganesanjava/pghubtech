#!/usr/bin/env node
/**
 * scripts/anki-to-sheets.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 — Migrate Anki notes for a specific deck into Google Sheets.
 * Each note is appended as a row to its template's sheet tab.
 * Images are optionally uploaded to Google Drive and URLs embedded in HTML.
 *
 * Re-runs are IDEMPOTENT: anki_note_id is used as the dedup key.
 * Notes already present in the sheet are skipped.
 *
 * PREREQUISITES
 * ─────────────
 * 1. Run anki-seed-templates.mjs first (creates sheet tabs + headers).
 * 2. Anki desktop must be OPEN with AnkiConnect installed.
 * 3. scripts/credentials.json + scripts/.token.json (from seed step).
 * 4. portal/.env.local with VITE_GOOGLE_SHEET_ID=...
 *
 * USAGE
 * ─────
 *   node scripts/anki-to-sheets.mjs --deck pg-leetcode              # dry-run
 *   node scripts/anki-to-sheets.mjs --deck pg-leetcode --write
 *   node scripts/anki-to-sheets.mjs --deck pg-leetcode --write --upload-images
 *   node scripts/anki-to-sheets.mjs --deck "AI::Concepts" --write --upload-images --update-images
 *
 * FLAGS
 * ─────
 *   --deck <name>          Anki deck name (required; use quotes for spaces)
 *   --write                Commit rows to Google Sheets (default: dry-run)
 *   --upload-images        Upload Anki media to Google Drive and rewrite src URLs
 *   --update-images        Also rewrite local image srcs in already-migrated rows
 *   --drive-folder <name>  Drive folder name for images (default: PGHubTechImages)
 */

import { google }               from 'googleapis'
import { readFile, writeFile }  from 'fs/promises'
import { createServer }         from 'http'
import { exec }                 from 'child_process'
import { dirname, join }        from 'path'
import { fileURLToPath }        from 'url'
import { Readable }             from 'stream'

const __dir        = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH   = join(__dir, 'credentials.json')
const TOKEN_PATH   = join(__dir, '.token.json')
const ANKI         = 'http://127.0.0.1:8765'

const DO_WRITE      = process.argv.includes('--write')
const UPLOAD_IMGS   = process.argv.includes('--upload-images')
const UPDATE_IMGS   = process.argv.includes('--update-images')  // rewrite local srcs in already-migrated rows
const DECK_ARG      = (() => { const i = process.argv.indexOf('--deck'); return i > -1 ? process.argv[i + 1] : null })()
const FOLDER_ARG    = (() => { const i = process.argv.indexOf('--drive-folder'); return i > -1 ? process.argv[i + 1] : 'PGHubTechImages' })()

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

// ─── Load env ─────────────────────────────────────────────────────────────────
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
      'Download from Google Cloud Console → APIs & Services → Credentials\n' +
      '(Create OAuth 2.0 Client ID → Desktop app, enable Sheets + Drive APIs)'
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

// ─── Google Drive image upload ────────────────────────────────────────────────
const _driveCache = new Map()   // filename → public URL

async function getOrCreateFolder(driveApi, name) {
  // Check if folder already exists
  const { data } = await driveApi.files.list({
    q:      `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
  })
  if (data.files?.length) {
    console.log(`  Drive folder "${name}": ${data.files[0].id} (existing)`)
    return data.files[0].id
  }
  const { data: created } = await driveApi.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields:      'id',
  })
  console.log(`  Drive folder "${name}": ${created.id} (created)`)
  return created.id
}

async function uploadToDrive(driveApi, folderId, filename, base64Data) {
  if (_driveCache.has(filename)) return _driveCache.get(filename)

  // Check if file already uploaded (idempotent)
  const { data: existing } = await driveApi.files.list({
    q:      `name='${filename}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
  })
  let fileId
  if (existing.files?.length) {
    fileId = existing.files[0].id
  } else {
    const ext    = (filename.split('.').pop() ?? 'png').toLowerCase()
    const mime   = { jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] ?? 'image/png'
    const buffer = Buffer.from(base64Data, 'base64')
    const { data: uploaded } = await driveApi.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media:       { mimeType: mime, body: Readable.from([buffer]) },
      fields:      'id',
    })
    fileId = uploaded.id
  }

  // Private — served via authenticated Drive API URL
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
  _driveCache.set(filename, url)
  return url
}

async function processHtml(html, driveCtx) {
  if (!html || !driveCtx) return html
  let out = html
  for (const [match, src] of [...html.matchAll(/src="([^"]+)"/g)]) {
    if (src.startsWith('http') || src.startsWith('data:')) continue
    try {
      const b64 = await anki('retrieveMediaFile', { filename: src })
      if (!b64) continue
      const url = await uploadToDrive(driveCtx.driveApi, driveCtx.folderId, src, b64)
      out = out.replace(match, `src="${url}"`)
      process.stdout.write('.')
    } catch (e) {
      console.warn(`\n  [!] Image "${src}": ${e.message}`)
    }
  }
  return out
}

// ─── Column-letter helper ─────────────────────────────────────────────────────
function colToLetter(n) {
  let s = ''
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) }
  return s
}

// ─── Field-type helpers ───────────────────────────────────────────────────────
const HTML_TAG_RE = /<[a-zA-Z][^>]*>/

function guessTypeFromName(name) {
  const k = name.toLowerCase()
  if (k === 'id' || k === 'lc_num' || k === 'num')               return 'number'
  if (k.startsWith('tag') || k === 'tags')                        return 'tags'
  if (k === 'difficult' || k === 'difficulty' || k === 'lc_diff') return 'select'
  return null
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

function normDiff(d) {
  if (!d) return ''
  const s = d.trim().toLowerCase()
  if (s === 'easy')   return 'Easy'
  if (s === 'medium') return 'Medium'
  if (s === 'hard')   return 'Hard'
  return d.trim()
}

function parseRef(ref) {
  if (!ref) return {}
  const m = ref.replace(/<[^>]+>/g, '').trim().match(/:([a-z0-9-]+):([A-Za-z]+)$/)
  if (!m) return {}
  const rest  = ref.slice(0, ref.length - m[0].length)
  const colon = rest.indexOf(':')
  return {
    ref_title: colon > -1 ? rest.slice(colon + 1).trim() : rest.trim(),
    ref_slug:  m[1],
    ref_diff:  m[2],
  }
}

// ─── Read template columns from Templates sheet ───────────────────────────────
async function readTemplatesSheet(sheetsApi, sheetId) {
  const { data } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range:         'Templates!A:J',
  })
  const rows = data.values ?? []
  if (!rows.length) throw new Error('"Templates" sheet is empty — run anki-seed-templates.mjs first')

  const header = rows[0]
  const idIdx  = header.indexOf('template_id')
  const keyIdx = header.indexOf('field_key')
  const ordIdx = header.indexOf('field_order')

  const map = new Map()   // template_id → sorted field keys
  for (const row of rows.slice(1)) {
    const tid = row[idIdx]
    const key = row[keyIdx]
    const ord = parseInt(row[ordIdx] ?? '0', 10)
    if (!tid || !key) continue
    if (!map.has(tid)) map.set(tid, [])
    map.get(tid).push({ key, order: ord })
  }

  const result = {}
  for (const [tid, fields] of map) {
    result[tid] = fields.sort((a, b) => a.order - b.order).map(f => f.key)
  }
  return result
}

// ─── Read existing note IDs from a sheet tab ──────────────────────────────────
async function readExistingIds(sheetsApi, sheetId, tabName) {
  try {
    const { data } = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range:         `${tabName}!A2:A`,
    })
    return new Set((data.values ?? []).map(r => r[0]).filter(Boolean))
  } catch {
    return new Set()
  }
}

// ─── Convert an Anki note to a sheet row ──────────────────────────────────────
async function noteToRow(note, deckName, fieldKeys, driveCtx) {
  const renames = MODEL_RENAMES[note.modelName] ?? {}

  let parsedRef = null
  if (note.modelName === 'pg-leetcode-template') {
    parsedRef = parseRef(note.fields['ref']?.value ?? '')
  }

  const sections = {}

  for (const [ankiKey, info] of Object.entries(note.fields)) {
    const raw   = info.value?.trim() ?? ''
    if (!raw) continue
    const fbKey = renames[ankiKey] ?? ankiKey

    const typeHint = guessTypeFromName(ankiKey)

    if (fbKey === 'lc_num') {
      const n = parseInt(raw.replace(/<[^>]+>/g, '').replace(/^#/, '').trim(), 10)
      if (!isNaN(n)) sections.lc_num = n
    } else if (fbKey === 'lc_title') {
      sections.lc_title = parsedRef?.ref_title || raw.replace(/<[^>]+>/g, '').trim()
      if (parsedRef?.ref_slug && !sections.lc_slug) sections.lc_slug = parsedRef.ref_slug
    } else if (fbKey === 'lc_diff') {
      const plain = raw.replace(/<[^>]+>/g, '').trim()
      sections.lc_diff = normDiff(plain) || normDiff(parsedRef?.ref_diff ?? '')
    } else if (typeHint === 'number') {
      const n = parseInt(raw.replace(/<[^>]+>/g, '').trim(), 10)
      if (!isNaN(n)) sections[fbKey] = n
    } else if (typeHint === 'select') {
      sections[fbKey] = normDiff(raw.replace(/<[^>]+>/g, '').trim())
    } else if (typeHint === 'tags') {
      sections[fbKey] = raw.replace(/<[^>]+>/g, '').split(/[\s,]+/).map(t => t.trim()).filter(Boolean)
    } else if (HTML_TAG_RE.test(raw)) {
      sections[fbKey] = await processHtml(raw, driveCtx)
    } else {
      sections[fbKey] = raw.replace(/<[^>]+>/g, '').trim()
    }
  }

  // Merge Anki note-level tags
  if (note.tags?.length) {
    const existing = Array.isArray(sections.tags) ? sections.tags : []
    sections.tags  = [...new Set([...existing, ...note.tags])]
  }

  // Build row: [anki_note_id, deck, anki_mod, ...field values]
  const SYS = [String(note.noteId), deckName, String(note.mod ?? '')]
  const DATA = fieldKeys.map(key => {
    const val = sections[key]
    if (val === undefined || val === null) return ''
    if (Array.isArray(val)) return val.join(', ')
    return String(val)
  })

  return [...SYS, ...DATA]
}

// ─── Batch append rows to a sheet ─────────────────────────────────────────────
async function appendRows(sheetsApi, sheetId, tabName, rows) {
  if (!rows.length) return
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId:   sheetId,
    range:           `${tabName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:     { values: rows },
  })
}

// ─── Update existing rows: rewrite local image srcs → Drive URLs ──────────────
function needsImageUpload(val) {
  if (!val || typeof val !== 'string') return false
  if (!/<img/i.test(val)) return false
  return /src="(?!https?:|data:)[^"]+"/i.test(val)
}

async function updateExistingImages(sheetsApi, sheetId, templateId, fieldKeys, driveCtx) {
  const colCount = 3 + fieldKeys.length
  const lastCol  = colToLetter(colCount)

  const { data } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range:         `${templateId}!A1:${lastCol}`,
  })
  const rows = data.values ?? []
  if (rows.length < 2) return 0

  let updated = 0
  for (let i = 1; i < rows.length; i++) {
    const row = [...rows[i]]
    let changed = false
    for (let j = 3; j < row.length; j++) {
      const val = row[j] ?? ''
      if (!needsImageUpload(val)) continue
      const resolved = await processHtml(val, driveCtx)
      if (resolved !== val) { row[j] = resolved; changed = true }
    }
    if (!changed) continue

    const rowNum = i + 1
    if (DO_WRITE) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId:   sheetId,
        range:           `${templateId}!A${rowNum}:${lastCol}${rowNum}`,
        valueInputOption: 'RAW',
        requestBody:     { values: [row] },
      })
    }
    updated++
    process.stdout.write(`\r  ${DO_WRITE ? 'Updated' : 'Would update'} ${updated} row(s)`)
  }
  return updated
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!DECK_ARG) {
    console.error('Usage: node scripts/anki-to-sheets.mjs --deck <deckName> [--write] [--upload-images]')
    process.exit(1)
  }

  const mode = DO_WRITE
    ? `WRITE${UPLOAD_IMGS ? ' + upload-images' : ''}${UPDATE_IMGS ? ' + update-images' : ''}`
    : `DRY-RUN${UPDATE_IMGS ? ' + update-images' : ''}`
  console.log('\n' + '═'.repeat(60))
  console.log(`  PG Hub Tech — Anki → Sheets  [${mode}]`)
  console.log(`  Deck: "${DECK_ARG}"`)
  console.log('═'.repeat(60))

  // AnkiConnect check
  try {
    const v = await anki('version')
    console.log(`\nAnkiConnect v${v}: OK`)
  } catch {
    console.error('\n✗ Cannot reach AnkiConnect. Ensure Anki is open.')
    process.exit(1)
  }

  const { sheetId } = await loadEnv()
  console.log(`Google Sheet ID: ${sheetId}`)

  const auth      = await authorize()
  const sheetsApi = google.sheets({ version: 'v4', auth })
  const driveApi  = google.drive({ version: 'v3', auth })

  // ── Read template field definitions from Templates sheet ───────────────────
  console.log('\n── Reading Templates sheet ──────────────────────────────────')
  const templateFields = await readTemplatesSheet(sheetsApi, sheetId)
  console.log(`  Loaded ${Object.keys(templateFields).length} template(s):`)
  for (const [tid, keys] of Object.entries(templateFields)) {
    console.log(`    ${tid}: [${keys.join(', ')}]`)
  }

  // ── Get notes for this deck ────────────────────────────────────────────────
  console.log(`\n── Fetching notes for deck "${DECK_ARG}" ────────────────`)
  const noteIds = await anki('findNotes', { query: `deck:"${DECK_ARG}"` })
  console.log(`  Found ${noteIds.length} note(s)`)
  if (!noteIds.length) {
    console.log('  Nothing to do.')
    process.exit(0)
  }

  const CHUNK    = 50
  const allNotes = []
  for (let i = 0; i < noteIds.length; i += CHUNK) {
    const infos = await anki('notesInfo', { notes: noteIds.slice(i, i + CHUNK) })
    allNotes.push(...infos)
    process.stdout.write(`\r  Fetched ${Math.min(i + CHUNK, noteIds.length)}/${noteIds.length}`)
  }
  console.log()

  // Group by model (template)
  const notesByModel = new Map()
  for (const note of allNotes) {
    if (!notesByModel.has(note.modelName)) notesByModel.set(note.modelName, [])
    notesByModel.get(note.modelName).push(note)
  }
  console.log('  Notes by model:')
  for (const [m, notes] of notesByModel) {
    console.log(`    ${m.padEnd(32)} ${notes.length}`)
  }

  // ── Set up Drive folder (if uploading images) ─────────────────────────────
  let driveCtx = null
  if (UPLOAD_IMGS) {
    console.log(`\n── Setting up Drive folder "${FOLDER_ARG}" ───────────────────`)
    const folderId = await getOrCreateFolder(driveApi, FOLDER_ARG)
    driveCtx = { driveApi, folderId }
  }

  // ── Process notes per model ────────────────────────────────────────────────
  let totalNew = 0, totalSkipped = 0, totalFailed = 0

  for (const [modelName, notes] of notesByModel) {
    const templateId = (() => {
      const known = {
        'pg-leetcode-template': 'pg-leetcode-template',
        'pg-solstool-template': 'pg-solstool-template',
        'ads-pattern': 'ads-pattern',
        'pg-notes': 'pg-notes',
        'Basic': 'basic',
        'Basic (and reversed card)': 'basic-reversed',
        'Cloze': 'basic-cloze',
      }
      return known[modelName] ?? modelName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    })()

    const fieldKeys = templateFields[templateId]
    if (!fieldKeys) {
      console.warn(`\n  [!] No template fields found for "${templateId}" — run anki-seed-templates.mjs first`)
      totalFailed += notes.length
      continue
    }

    console.log(`\n── Model "${modelName}" → sheet "${templateId}" ──────────────`)

    // Load existing IDs to skip duplicates
    const existingIds = await readExistingIds(sheetsApi, sheetId, templateId)
    console.log(`  Existing rows: ${existingIds.size}`)

    const newNotes = notes.filter(n => !existingIds.has(String(n.noteId)))
    console.log(`  New notes:     ${newNotes.length}  (${notes.length - newNotes.length} already in sheet)`)
    totalSkipped += notes.length - newNotes.length

    if (!newNotes.length) continue

    // Build rows
    console.log('  Converting notes…')
    const newRows = []
    let failed = 0
    for (let i = 0; i < newNotes.length; i++) {
      try {
        const row = await noteToRow(newNotes[i], DECK_ARG, fieldKeys, driveCtx)
        newRows.push(row)
      } catch (e) {
        console.warn(`\n  [!] note ${newNotes[i].noteId}: ${e.message}`)
        failed++
      }
      if ((i + 1) % 10 === 0 || i === newNotes.length - 1) {
        process.stdout.write(`\r  ${i + 1}/${newNotes.length} converted`)
      }
    }
    console.log()
    totalFailed += failed

    // Preview first row
    if (newRows.length) {
      const headers = ['anki_note_id', 'deck', 'anki_mod', ...fieldKeys]
      console.log('\n  Preview (first row):')
      for (let i = 0; i < Math.min(headers.length, newRows[0].length); i++) {
        const val = newRows[0][i]
        const preview = val.length > 80 ? val.slice(0, 77) + '…' : val
        if (val) console.log(`    ${headers[i].padEnd(16)} ${preview}`)
      }
    }

    if (!DO_WRITE) {
      console.log(`\n  [dry-run] ${newRows.length} rows would be written to "${templateId}"`)
      totalNew += newRows.length
      continue
    }

    // Append in batches of 200
    const BATCH = 200
    for (let i = 0; i < newRows.length; i += BATCH) {
      await appendRows(sheetsApi, sheetId, templateId, newRows.slice(i, i + BATCH))
      process.stdout.write(`\r  Written ${Math.min(i + BATCH, newRows.length)}/${newRows.length}`)
    }
    console.log()
    totalNew += newRows.length
    console.log(`  ✓ ${newRows.length} rows written to "${templateId}"`)
  }

  // ── Update existing rows with Drive image URLs (--update-images) ──────────
  if (UPDATE_IMGS && driveCtx) {
    console.log('\n── Updating existing rows with Drive image URLs ─────────────')
    for (const [modelName, ] of notesByModel) {
      const templateId = (() => {
        const known = {
          'pg-leetcode-template': 'pg-leetcode-template',
          'pg-solstool-template': 'pg-solstool-template',
          'ads-pattern': 'ads-pattern',
          'pg-notes': 'pg-notes',
          'Basic': 'basic',
          'Basic (and reversed card)': 'basic-reversed',
          'Cloze': 'basic-cloze',
        }
        return known[modelName] ?? modelName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      })()
      const fieldKeys = templateFields[templateId]
      if (!fieldKeys) continue
      console.log(`\n  "${templateId}"…`)
      const count = await updateExistingImages(sheetsApi, sheetId, templateId, fieldKeys, driveCtx)
      console.log(`\n  ✓ ${count} row(s) ${DO_WRITE ? 'updated' : 'would update'}`)
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60))
  if (DO_WRITE) {
    console.log(`  Done.  Written: ${totalNew}  Skipped: ${totalSkipped}  Failed: ${totalFailed}`)
  } else {
    console.log(`  Dry-run.  Would write: ${totalNew}  Skipped: ${totalSkipped}  Failed: ${totalFailed}`)
    console.log('  Pass --write to commit.')
  }
  console.log('═'.repeat(60) + '\n')
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1) })
