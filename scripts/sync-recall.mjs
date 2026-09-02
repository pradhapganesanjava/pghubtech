#!/usr/bin/env node
/**
 * scripts/sync-recall.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Push portal/public/recall.json into the sheet's "Recall" tab.
 *
 *   node scripts/sync-recall.mjs                      # dry run — prints the diff
 *   node scripts/sync-recall.mjs --write              # apply it
 *   node scripts/sync-recall.mjs --only a,b --write   # just those ids
 *
 * The Recall twin of sync-point2rem.mjs, and for the same reason: recall.json
 * is only a SEED, copied into the tab once when it's first created. After that
 * the sheet is the source of truth, so a seed edit — a retag, a fixed typo — is
 * invisible to a portal that already has the tab. This upserts by id (column A).
 *
 * Upsert only: rows whose id isn't in the JSON are left alone, so nothing here
 * can delete a card written in the portal. Rows that ARE in the JSON get
 * overwritten wholesale — run the dry run first, it names every changed field.
 */
import { google }              from 'googleapis'
import { readFile, writeFile } from 'fs/promises'
import { createServer }        from 'http'
import { exec }                from 'child_process'
import { dirname, join }       from 'path'
import { fileURLToPath }       from 'url'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const SEED_PATH  = join(__dir, '../portal/public/recall.json')
const SCOPES     = ['https://www.googleapis.com/auth/spreadsheets']
const TAB        = 'Recall'

// Mirrors HEADERS in portal/src/adapters/recallRepo.ts — keep in step.
const HEADERS = ['id', 'question', 'hint', 'answer', 'kind', 'tags', 'problems', 'points', 'links', 'format', 'updated_at']
const FIELDS  = ['id', 'question', 'hint', 'answer', 'kind', 'tags', 'problems', 'points', 'links', 'format', 'updated']
const LAST_COL = 'K'
const KINDS = ['trick', 'confusion', 'concept']

const ARGS     = process.argv.slice(2)
const DO_WRITE = ARGS.includes('--write')
const flag = (name) => { const i = ARGS.indexOf(name); return i >= 0 ? ARGS[i + 1] : null }
const ONLY = (flag('--only') ?? '').split(',').map(s => s.trim()).filter(Boolean)

async function loadEnv() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  const env = {}
  for (const line of text.split('\n')) { const eq = line.indexOf('='); if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim() }
  if (!env.VITE_SHEET_ID) throw new Error('Missing VITE_SHEET_ID in portal/.env.local')
  return { sheetId: env.VITE_SHEET_ID }
}

async function authorize() {
  const creds = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
  const cfg = creds.installed ?? creds.web
  const c = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
  try {
    const token = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
    const granted = (token.scope ?? '').split(/\s+/)
    if (!SCOPES.every(s => granted.includes(s))) return getNewToken(c)
    c.setCredentials(token)
    c.on('tokens', t => writeFile(TOKEN_PATH, JSON.stringify({ ...token, ...t })))
    return c
  } catch { return getNewToken(c) }
}

function getNewToken(c) {
  const url = c.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES })
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const code = new URL(req.url, 'http://localhost:3000').searchParams.get('code')
      if (!code) { res.end('No code'); return }
      res.end('<h2>✓ Authorized — close this tab.</h2>'); server.close()
      try { const { tokens } = await c.getToken(code); c.setCredentials(tokens); await writeFile(TOKEN_PATH, JSON.stringify(tokens)); resolve(c) } catch (e) { reject(e) }
    })
    server.listen(3000, () => { console.log('\nAuthorize in browser:\n  ' + url + '\n'); exec(`open "${url}"`) })
    server.on('error', reject)
  })
}

// ── Row encoding — must match recallRepo's itemToRow / rowToItem ────────────

const asStrings   = (v) => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []
const slugify     = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
const linksToCell = (links) => links.map(l => l.label ? `${l.label} | ${l.url}` : l.url).join('\n')

function normalize(raw, idx) {
  const question = String(raw.question ?? '').trim()
  const answer   = String(raw.answer ?? '')
  if (!question && !answer) return null
  const links = []
  for (const l of (Array.isArray(raw.links) ? raw.links : [])) {
    if (typeof l === 'string') { links.push({ url: l }); continue }
    const url = String(l?.url ?? '').trim()
    if (!url) continue
    const label = String(l?.label ?? '').trim()
    links.push(label ? { label, url } : { url })
  }
  const kind = String(raw.kind ?? '').toLowerCase()
  return {
    id:       String(raw.id ?? '').trim() || slugify(question) || `recall-${idx + 1}`,
    question: question || `Card ${idx + 1}`,
    hint:     String(raw.hint ?? '').trim(),
    answer,
    kind:     KINDS.includes(kind) ? kind : 'trick',
    tags:     asStrings(raw.tags),
    problems: asStrings(raw.problems),
    points:   asStrings(raw.points),
    links,
    format:   String(raw.format ?? '').toLowerCase() === 'html' ? 'html' : 'md',
    updated:  String(raw.updated ?? '').trim(),
  }
}

const itemToRow = (i) => [
  i.id, i.question, i.hint, i.answer, i.kind, i.tags.join('; '),
  i.problems.join('; '), i.points.join('; '), linksToCell(i.links),
  i.format, i.updated,
]

// Google's values.get trims trailing empty cells, so pad before comparing.
const padRow = (r) => Array.from({ length: HEADERS.length }, (_, i) => r[i] ?? '')

// ── Main ────────────────────────────────────────────────────────────────────

const { sheetId } = await loadEnv()
const sheets = google.sheets({ version: 'v4', auth: await authorize() })

const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties.title' })
const tabs = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
if (!tabs.includes(TAB)) {
  console.error(`No "${TAB}" tab in this sheet. Open AdsHub's Quiz / Recall page once — the portal creates it and seeds it from recall.json.`)
  process.exit(1)
}

const seed = JSON.parse(await readFile(SEED_PATH, 'utf8'))
let items = (Array.isArray(seed.items) ? seed.items : []).map(normalize).filter(Boolean)
if (ONLY.length) {
  const want = new Set(ONLY)
  const missing = ONLY.filter(id => !items.some(i => i.id === id))
  if (missing.length) { console.error(`--only ids not in the JSON: ${missing.join(', ')}`); process.exit(1) }
  items = items.filter(i => want.has(i.id))
}

const cur = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!A2:${LAST_COL}` })).data.values ?? []
const rowNumById = new Map()
cur.forEach((r, i) => { if (r[0] && !rowNumById.has(r[0])) rowNumById.set(r[0], i + 2) })  // +1 header, +1 for 1-based

const updates = []
const appends = []
for (const item of items) {
  const values = itemToRow(item)
  const rowNum = rowNumById.get(item.id)
  if (!rowNum) { appends.push({ id: item.id, values }); continue }
  const before = padRow(cur[rowNum - 2] ?? [])
  const changed = FIELDS.filter((_, i) => before[i] !== values[i])
  if (changed.length) updates.push({ rowNum, values, id: item.id, changed, before })
}

console.log(`${TAB}: ${cur.filter(r => r[0]).length} rows in the sheet, ${items.length} cards in the JSON`)
for (const u of updates) {
  console.log(`  ~ ${u.id}  (row ${u.rowNum})  fields: ${u.changed.join(', ')}`)
  for (const f of u.changed) {
    const i = FIELDS.indexOf(f)
    if (f === 'answer' || f === 'question') { console.log(`      ${f}: ${u.before[i].length} → ${u.values[i].length} chars`); continue }
    console.log(`      ${f}: ${JSON.stringify(u.before[i])} → ${JSON.stringify(u.values[i])}`)
  }
}
for (const a of appends) console.log(`  + ${a.id}  (new row)`)
if (!updates.length && !appends.length) { console.log('  nothing to do — sheet already matches the JSON'); process.exit(0) }

if (!DO_WRITE) { console.log('\nDry run. Re-run with --write to apply.'); process.exit(0) }

for (const u of updates) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId, range: `${TAB}!A${u.rowNum}:${LAST_COL}${u.rowNum}`,
    valueInputOption: 'RAW', requestBody: { values: [u.values] },
  })
}
if (appends.length) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId, range: `${TAB}!A1`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: appends.map(a => a.values) },
  })
}
console.log(`\n✓ ${updates.length} updated, ${appends.length} added. Hit ↻ on the Quiz / Recall page to reload.`)
