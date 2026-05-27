#!/usr/bin/env node
/**
 * scripts/ads-to-sheets.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Migrate the local `_ADS` LeetCode knowledge hub (lc_store/) into pghubtech.
 *
 * For each problem it writes ONE row to the "LCProblems" sheet tab:
 *   slug, frontend_id, title, difficulty, topics, companies, companies_recent,
 *   tags(::), leetcode_url, description_html, notes_drive_id, has_notes
 *
 *   • Metadata + the recency-bucketed companies come from lc_store/problems.csv
 *   • The formatted description fragment + the custom `::` tags are extracted
 *     from each lc_store/problems/<slug>.html (its <div class="content"> and its
 *     <script id="lc-data"> JSON) — so lineage is derived straight from lc_store.
 *   • Hand-authored Anki notes (lc_store/problems/notes/<slug>.html) are made
 *     self-contained — every <img> (local notes_media file OR external URL) is
 *     mirrored to Drive and the src rewritten — then uploaded to Drive; the file
 *     id lands in notes_drive_id. The portal renders them with the same
 *     resolveDriveImagesInHtml() flow as Anki cards.
 *
 * Re-runs are IDEMPOTENT and RESUMABLE: rows upsert on `slug`, and a local
 * scripts/.ads-manifest.json remembers already-uploaded notes + media so a
 * second run does not re-upload them.
 *
 * PREREQUISITES
 * ─────────────
 *   • scripts/credentials.json + scripts/.token.json (shared with anki-to-sheets)
 *   • portal/.env.local with VITE_SHEET_ID=...
 *   • a local _ADS checkout (default ~/_ADS, override with --ads-root)
 *
 * USAGE
 * ─────
 *   node scripts/ads-to-sheets.mjs --limit 5                 # dry-run, 5 problems
 *   node scripts/ads-to-sheets.mjs --limit 5 --write         # commit 5
 *   node scripts/ads-to-sheets.mjs --write                   # full migration
 *   node scripts/ads-to-sheets.mjs --write --skip-notes      # metadata only (fast)
 *
 * FLAGS
 * ─────
 *   --write              Commit to Sheets + upload to Drive (default: dry-run)
 *   --limit <n>          Only process the first n problems (testing)
 *   --skip-notes         Don't upload note HTML / images (metadata + desc only)
 *   --ads-root <path>    Path to the _ADS checkout (default: ~/_ADS)
 */

import { google }                       from 'googleapis'
import { readFile, writeFile, access }  from 'fs/promises'
import { createServer }                 from 'http'
import { exec }                         from 'child_process'
import { dirname, join, basename }      from 'path'
import { fileURLToPath }                from 'url'
import { homedir }                      from 'os'
import { Readable }                     from 'stream'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const MANIFEST   = join(__dir, '.ads-manifest.json')

const DO_WRITE   = process.argv.includes('--write')
const SKIP_NOTES = process.argv.includes('--skip-notes')
const LIMIT      = (() => { const i = process.argv.indexOf('--limit');    return i > -1 ? parseInt(process.argv[i + 1], 10) : 0 })()
const ADS_ROOT   = (() => { const i = process.argv.indexOf('--ads-root'); return i > -1 ? process.argv[i + 1] : join(homedir(), '_ADS') })()

const LC_STORE    = join(ADS_ROOT, 'lc_store')
const PROBLEMS_CSV = join(LC_STORE, 'problems.csv')
const PROBLEMS_DIR = join(LC_STORE, 'problems')
const NOTES_DIR    = join(PROBLEMS_DIR, 'notes')
const MEDIA_DIR    = join(PROBLEMS_DIR, 'notes_media')

const TAB         = 'LCProblems'
const NOTES_FOLDER = 'PGHubTechAdsNotes'
const MEDIA_FOLDER = 'PGHubTechAdsMedia'
const CELL_LIMIT   = 49000

const HEADERS = [
  'slug', 'frontend_id', 'title', 'difficulty', 'topics', 'companies',
  'companies_recent', 'tags', 'leetcode_url', 'description_html',
  'notes_drive_id', 'has_notes',
]

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
]

const DRIVE_URL_PREFIX = 'https://www.googleapis.com/drive/v3/files/'

// ─── env ───────────────────────────────────────────────────────────────────
async function loadEnv() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  const env  = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  if (!env.VITE_SHEET_ID) throw new Error('Missing VITE_SHEET_ID in portal/.env.local')
  return { sheetId: env.VITE_SHEET_ID }
}

// ─── OAuth2 (same flow as anki-to-sheets.mjs) ────────────────────────────────
async function authorize() {
  let credRaw
  try { credRaw = await readFile(CREDS_PATH, 'utf8') } catch {
    throw new Error('Missing scripts/credentials.json (Desktop OAuth client, Sheets + Drive enabled)')
  }
  const cfg = (JSON.parse(credRaw).installed ?? JSON.parse(credRaw).web)
  const oAuth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
  try {
    const token = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
    // The token shares .token.json with file-card.mjs, which mints it with the
    // Sheets scope only. Uploading notes/images needs drive.file too — a scope a
    // refresh can't widen — so re-authorize when the saved token is too narrow.
    const granted = (token.scope ?? '').split(/\s+/)
    if (!SCOPES.every(s => granted.includes(s))) {
      console.log('  Saved token is missing the Drive scope — re-authorizing (Sheets + Drive)…')
      return getNewToken(oAuth2Client)
    }
    oAuth2Client.setCredentials(token)
    oAuth2Client.on('tokens', t => writeFile(TOKEN_PATH, JSON.stringify({ ...token, ...t })))
    return oAuth2Client
  } catch {
    return getNewToken(oAuth2Client)
  }
}

function getNewToken(oAuth2Client) {
  // prompt:'consent' guarantees a refresh_token even when the app is already
  // authorized (Google otherwise omits it on a silent re-grant).
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES })
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
        resolve(oAuth2Client)
      } catch (e) { reject(e) }
    })
    server.listen(3000, () => {
      console.log('\nOpening browser for Google authorization…\n  ' + authUrl + '\n')
      exec(`open "${authUrl}"`)
    })
    server.on('error', reject)
  })
}

// ─── manifest (resume state) ─────────────────────────────────────────────────
async function loadManifest() {
  try { return JSON.parse(await readFile(MANIFEST, 'utf8')) }
  catch { return { media: {}, notes: {} } }
}
let _manifestDirty = false
async function saveManifest(m) {
  if (!_manifestDirty) return
  await writeFile(MANIFEST, JSON.stringify(m, null, 2))
  _manifestDirty = false
}

// ─── minimal RFC-4180 CSV parser ─────────────────────────────────────────────
function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
    } else if (c === '\r') {
      // swallow; \n handles the row break
    } else {
      field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

// ─── HTML extraction helpers ─────────────────────────────────────────────────
// Extract the inner HTML of the first <div class="content"> …balanced… </div>.
function extractDescriptionHtml(html) {
  const open = html.search(/<div\s+class="content"\s*>/i)
  if (open < 0) return ''
  const innerStart = html.indexOf('>', open) + 1
  let depth = 1, i = innerStart
  const re = /<\/?div\b[^>]*>/gi
  re.lastIndex = innerStart
  let m
  while ((m = re.exec(html))) {
    if (m[0].startsWith('</')) { depth--; if (depth === 0) { i = m.index; break } }
    else depth++
  }
  return html.slice(innerStart, i).trim()
}

// Pull the custom `::` tags out of the embedded <script id="lc-data"> JSON.
function extractTags(html) {
  const m = html.match(/<script id="lc-data"[^>]*>([\s\S]*?)<\/script>/i)
  if (!m) return []
  try {
    const data = JSON.parse(m[1])
    return Array.isArray(data.tags) ? data.tags.filter(Boolean) : []
  } catch { return [] }
}

// ─── Drive helpers ───────────────────────────────────────────────────────────
async function getOrCreateFolder(driveApi, name) {
  const { data } = await driveApi.files.list({
    q:      `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  })
  if (data.files?.length) return data.files[0].id
  const { data: created } = await driveApi.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id',
  })
  return created.id
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', html: 'text/html',
}
function mimeForName(name) {
  return MIME_BY_EXT[(name.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream'
}

// Upload (or update existing same-named file in folder). Returns the file id.
async function uploadOrUpdate(driveApi, folderId, name, buffer, mime) {
  const { data: existing } = await driveApi.files.list({
    q:      `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
  })
  const media = { mimeType: mime, body: Readable.from([buffer]) }
  if (existing.files?.length) {
    const id = existing.files[0].id
    await driveApi.files.update({ fileId: id, media })
    return id
  }
  const { data } = await driveApi.files.create({
    requestBody: { name, parents: [folderId] }, media, fields: 'id',
  })
  return data.id
}

// Rewrite every <img src> in a note: mirror the image to Drive, swap to the
// authenticated Drive media URL. Handles local notes_media files + external URLs.
async function rewriteNoteImages(html, driveApi, mediaFolderId, manifest) {
  let out = html
  for (const [match, src] of [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)]) {
    // data: is already inline; blob: is a dead ephemeral capture URL (gone the
    // moment the authoring tab closed); Drive URLs are already mirrored.
    if (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith(DRIVE_URL_PREFIX)) continue
    const isExternal = /^https?:\/\//i.test(src)
    const key = isExternal ? src : `local:${basename(src)}`
    let url = manifest.media[key]
    if (!url) {
      try {
        let buffer, name
        if (isExternal) {
          const r = await fetch(src)
          if (!r.ok) { console.warn(`\n  [!] external img ${r.status}: ${src}`); continue }
          buffer = Buffer.from(await r.arrayBuffer())
          name   = (basename(new URL(src).pathname) || `img_${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, '_')
        } else {
          name   = basename(src)
          buffer = await readFile(join(MEDIA_DIR, name))
        }
        const id = await uploadOrUpdate(driveApi, mediaFolderId, name, buffer, mimeForName(name))
        url = `${DRIVE_URL_PREFIX}${id}?alt=media`
        manifest.media[key] = url
        _manifestDirty = true
        process.stdout.write('.')
      } catch (e) {
        console.warn(`\n  [!] img "${src}": ${e.message}`)
        continue
      }
    }
    out = out.replaceAll(`src="${src}"`, `src="${url}"`)
  }
  return out
}

// ─── ensure the LCProblems tab exists with the header row ────────────────────
async function ensureTab(sheetsApi, sheetId) {
  const { data } = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties.title' })
  const titles = (data.sheets ?? []).map(s => s.properties?.title)
  if (!titles.includes(TAB)) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    })
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: sheetId, range: `${TAB}!A1`,
      valueInputOption: 'RAW', requestBody: { values: [HEADERS] },
    })
    console.log(`  Created "${TAB}" tab with header row.`)
  }
}

// Read existing rows → Map slug → { rowNum, row }.
async function readExisting(sheetsApi, sheetId) {
  const map = new Map()
  try {
    const lastCol = String.fromCharCode(64 + HEADERS.length) // L for 12 cols
    const { data } = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: sheetId, range: `${TAB}!A2:${lastCol}`,
    })
    ;(data.values ?? []).forEach((row, i) => {
      if (row[0]) map.set(row[0], { rowNum: i + 2, row })
    })
  } catch { /* tab empty */ }
  return map
}

const J = (s) => (s ?? '').split('|').filter(Boolean).join('; ')
function truncate(v) {
  return typeof v === 'string' && v.length > CELL_LIMIT ? v.slice(0, CELL_LIMIT) + '\n[…truncated]' : v
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const mode = DO_WRITE ? `WRITE${SKIP_NOTES ? ' (skip-notes)' : ''}` : 'DRY-RUN'
  console.log('\n' + '═'.repeat(64))
  console.log(`  _ADS → pghubtech LCProblems  [${mode}]`)
  console.log(`  _ADS root: ${ADS_ROOT}`)
  if (LIMIT) console.log(`  limit:     ${LIMIT}`)
  console.log('═'.repeat(64))

  try { await access(PROBLEMS_CSV) } catch {
    console.error(`\n✗ Not found: ${PROBLEMS_CSV}\n  Pass --ads-root <path> if your _ADS checkout is elsewhere.`)
    process.exit(1)
  }

  const { sheetId } = await loadEnv()
  console.log(`\nGoogle Sheet: ${sheetId}`)

  const auth      = await authorize()
  const sheetsApi = google.sheets({ version: 'v4', auth })
  const driveApi  = google.drive({ version: 'v3', auth })
  const manifest  = await loadManifest()

  // ── Parse problems.csv ──────────────────────────────────────────────────
  console.log('\n── Parsing problems.csv ─────────────────────────────────────')
  const rows   = parseCsv(await readFile(PROBLEMS_CSV, 'utf8'))
  const header = rows[0]
  const col    = Object.fromEntries(header.map((h, i) => [h, i]))
  let records  = rows.slice(1).filter(r => r[col.slug])
  console.log(`  ${records.length} problems`)
  if (LIMIT) records = records.slice(0, LIMIT)

  if (DO_WRITE) await ensureTab(sheetsApi, sheetId)
  const existing = DO_WRITE ? await readExisting(sheetsApi, sheetId) : new Map()
  console.log(`  Existing rows in sheet: ${existing.size}`)

  let mediaFolderId = null, notesFolderId = null
  if (DO_WRITE && !SKIP_NOTES) {
    mediaFolderId = await getOrCreateFolder(driveApi, MEDIA_FOLDER)
    notesFolderId = await getOrCreateFolder(driveApi, NOTES_FOLDER)
  }

  // ── Build rows ──────────────────────────────────────────────────────────
  console.log('\n── Building rows ────────────────────────────────────────────')
  const toAppend = []   // [row]
  const toUpdate = []   // { rowNum, row }
  let firstRow = null   // for dry-run preview
  let withNotes = 0, withTags = 0

  for (let i = 0; i < records.length; i++) {
    const r    = records[i]
    const slug = r[col.slug]

    let descHtml = '', tags = []
    try {
      const phtml = await readFile(join(PROBLEMS_DIR, `${slug}.html`), 'utf8')
      descHtml = extractDescriptionHtml(phtml)
      tags     = extractTags(phtml)
    } catch { /* no detail page — fall back to csv description */ }
    if (!descHtml && r[col.description]) descHtml = `<p>${r[col.description]}</p>`
    if (tags.length) withTags++

    // Notes (upload only when committing, not skipping, and not already done)
    let notesDriveId = existing.get(slug)?.row?.[HEADERS.indexOf('notes_drive_id')] ?? ''
    let hasNotesFile = false
    try { await access(join(NOTES_DIR, `${slug}.html`)); hasNotesFile = true } catch { /* none */ }
    if (hasNotesFile) withNotes++

    if (hasNotesFile && DO_WRITE && !SKIP_NOTES) {
      if (manifest.notes[slug]) {
        notesDriveId = manifest.notes[slug]
      } else {
        try {
          const noteHtml = await readFile(join(NOTES_DIR, `${slug}.html`), 'utf8')
          const rewritten = await rewriteNoteImages(noteHtml, driveApi, mediaFolderId, manifest)
          notesDriveId = await uploadOrUpdate(driveApi, notesFolderId, `${slug}.html`, Buffer.from(rewritten), 'text/html')
          manifest.notes[slug] = notesDriveId
          _manifestDirty = true
        } catch (e) {
          console.warn(`\n  [!] note "${slug}": ${e.message}`)
        }
      }
    }

    const row = [
      slug,
      r[col.frontend_id] ?? '',
      r[col.title] ?? '',
      r[col.difficulty] ?? '',
      J(r[col.topics]),
      J(r[col.companies]),
      J(r[col.companies_0_6mo]),
      tags.join('; '),
      r[col.leetcode_url] ?? '',
      descHtml,
      notesDriveId,
      hasNotesFile ? '1' : '',
    ].map(truncate)
    if (!firstRow) firstRow = row

    if (DO_WRITE) {
      const ex = existing.get(slug)
      if (!ex) toAppend.push(row)
      else if (JSON.stringify(ex.row) !== JSON.stringify(row.map(c => c ?? ''))) toUpdate.push({ rowNum: ex.rowNum, row })
    }

    if ((i + 1) % 25 === 0 || i === records.length - 1) {
      process.stdout.write(`\r  ${i + 1}/${records.length} processed`)
      await saveManifest(manifest)
    }
  }
  console.log(`\n  Problems with notes: ${withNotes}   with custom :: tags: ${withTags}`)
  await saveManifest(manifest)

  // ── Preview ───────────────────────────────────────────────────────────────
  const sample = (toAppend[0] ?? toUpdate[0]?.row ?? firstRow)
  if (sample) {
    console.log('\n  Preview (first row):')
    HEADERS.forEach((h, i) => {
      const v = String(sample[i] ?? '')
      if (v) console.log(`    ${h.padEnd(17)} ${v.length > 80 ? v.slice(0, 77) + '…' : v}`)
    })
  }

  if (!DO_WRITE) {
    console.log(`\n  [dry-run] ${records.length} problems parsed. Pass --write to commit.`)
    console.log('═'.repeat(64) + '\n')
    return
  }

  // ── Append new rows in batches ──────────────────────────────────────────
  const BATCH = 200
  for (let i = 0; i < toAppend.length; i += BATCH) {
    await appendWithBackoff(sheetsApi, sheetId, toAppend.slice(i, i + BATCH))
    process.stdout.write(`\r  Appended ${Math.min(i + BATCH, toAppend.length)}/${toAppend.length}`)
  }
  if (toAppend.length) console.log()

  // ── Update changed rows (e.g. notes_drive_id filled on a later run) ───────
  const lastCol = String.fromCharCode(64 + HEADERS.length)
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const chunk = toUpdate.slice(i, i + BATCH)
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: chunk.map(u => ({ range: `${TAB}!A${u.rowNum}:${lastCol}${u.rowNum}`, values: [u.row] })),
      },
    })
    process.stdout.write(`\r  Updated ${Math.min(i + BATCH, toUpdate.length)}/${toUpdate.length}`)
  }
  if (toUpdate.length) console.log()

  console.log('\n' + '═'.repeat(64))
  console.log(`  Done.  Appended: ${toAppend.length}  Updated: ${toUpdate.length}  Unchanged: ${records.length - toAppend.length - toUpdate.length}`)
  console.log('═'.repeat(64) + '\n')
}

async function appendWithBackoff(sheetsApi, sheetId, values) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId: sheetId, range: `${TAB}!A1`,
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      })
      return
    } catch (e) {
      if (attempt < 3 && (e.message?.includes('Quota exceeded') || e.code === 429)) {
        const wait = attempt * 65000
        process.stdout.write(`\n  [quota] waiting ${wait / 1000}s…`)
        await new Promise(r => setTimeout(r, wait))
      } else throw e
    }
  }
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1) })
