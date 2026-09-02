#!/usr/bin/env node
/**
 * scripts/seed-dart-goals.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Upsert a batch of DART goals into the Goals tab of the DART spreadsheet that
 * lives in Drive/PGHubTechDART.
 *
 *   node scripts/seed-dart-goals.mjs              # dry run — prints the diff
 *   node scripts/seed-dart-goals.mjs --write      # apply it
 *
 * Unlike the other sync scripts, DART does NOT live in the main sheet — it has
 * its own spreadsheet in its own Drive folder (see portal/src/adapters/
 * dartRepo.ts). So this needs drive.readonly on top of spreadsheets in order to
 * FIND that file by name; it never creates or modifies anything in Drive
 * itself. Open the portal once (Utils → DART) so the store exists, then run.
 *
 * Upsert by id (column A): a goal already present is overwritten wholesale, one
 * that isn't is appended. Rows not listed here are never touched, so goals
 * added in the portal are safe.
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
const SCOPES     = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
]
const FOLDER = 'PGHubTechDART'
const DOC    = 'DART'
const TAB    = 'Goals'

// Mirrors GOAL_HEADERS in portal/src/adapters/dartRepo.ts — keep in step.
const HEADERS = [
  'id', 'title', 'notes', 'start_date', 'end_date', 'frequency',
  'target_minutes', 'priority', 'active', 'created_at', 'updated_at',
  'target_units', 'unit_label',
]
const LAST_COL = 'M'

const ARGS     = process.argv.slice(2)
const DO_WRITE = ARGS.includes('--write')

const H = (h) => Math.round(h * 60)

// ── The goals ───────────────────────────────────────────────────────────────
// frequency 'total' = the target covers the whole start→end window, not a
// repeating period. targetMinutes 0 means "not chased on hours"; targetUnits 0
// means "not chased on output". Ids are stable so re-running updates in place.
const START = '2026-09-02'
const GOALS = [
  {
    id: 'dg-seed-algo-sprint',
    title: 'Algorithms — 85 problem sprint',
    notes: '85 algorithm problems by Sep 4, estimated 24h. Counts toward the 350 total.',
    startDate: START, endDate: '2026-09-04', frequency: 'total',
    targetMinutes: H(24), targetUnits: 85, unitLabel: 'problems',
    priority: 'must',
  },
  {
    id: 'dg-seed-algo-total',
    title: 'Algorithms — 350 problems',
    notes: 'Total target by Sep 14. Includes the 85 done in the Sep 4 sprint. '
         + 'Tracked on problem count only — time is logged but not chased.',
    startDate: START, endDate: '2026-09-14', frequency: 'total',
    targetMinutes: 0, targetUnits: 350, unitLabel: 'problems',
    priority: 'could',
  },
  {
    id: 'dg-seed-sysdesign',
    title: 'System Design — Hello Interview',
    notes: '24 hours of Hello Interview system design by Sep 10.',
    startDate: START, endDate: '2026-09-10', frequency: 'total',
    targetMinutes: H(24), targetUnits: 0, unitLabel: '',
    priority: 'could',
  },
  {
    id: 'dg-seed-ai-project',
    title: 'AI Project',
    notes: 'Sub-topics: skill · multi-model · eval · guardrail · LLM gateway · MCP.\n'
         + 'Around 20h total estimate by Sep 14.',
    startDate: START, endDate: '2026-09-14', frequency: 'total',
    targetMinutes: H(20), targetUnits: 6, unitLabel: 'sub-topics',
    priority: 'could',
  },
]

// ── Auth (same flow as sync-recall.mjs) ─────────────────────────────────────

async function authorize() {
  const creds = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
  const cfg = creds.installed ?? creds.web
  const c = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
  try {
    const token = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
    const granted = (token.scope ?? '').split(/\s+/)
    // drive.readonly is new for this script, so an older token re-consents.
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
      try {
        const { tokens } = await c.getToken(code)
        c.setCredentials(tokens); await writeFile(TOKEN_PATH, JSON.stringify(tokens)); resolve(c)
      } catch (e) { reject(e) }
    })
    server.listen(3000, () => { console.log('\nAuthorize in browser:\n  ' + url + '\n'); exec(`open "${url}"`) })
    server.on('error', reject)
  })
}

// ── Locate the DART spreadsheet ─────────────────────────────────────────────

async function findDartDoc(auth) {
  const drive = google.drive({ version: 'v3', auth })
  const folders = await drive.files.list({
    q: `name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)', pageSize: 1,
  })
  const folderId = folders.data.files?.[0]?.id
  if (!folderId) {
    throw new Error(
      `Drive folder "${FOLDER}" not found.\n` +
      `  Open the portal once (Utils → DART) — the store is created on first open.`)
  }
  const docs = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet'`
     + ` and name='${DOC}' and trashed=false`,
    fields: 'files(id,name)', pageSize: 1,
  })
  const id = docs.data.files?.[0]?.id
  if (!id) throw new Error(`Spreadsheet "${DOC}" not found inside ${FOLDER}. Open Utils → DART once.`)
  return id
}

const goalToRow = (g, createdAt, updatedAt) => [
  g.id, g.title, g.notes, g.startDate, g.endDate, g.frequency,
  String(g.targetMinutes), g.priority, 'true', createdAt, updatedAt,
  String(g.targetUnits), g.unitLabel,
]
const padRow = (r) => Array.from({ length: HEADERS.length }, (_, i) => r[i] ?? '')
const fmtH   = (m) => m === 0 ? '—' : `${Math.round(m / 60 * 10) / 10}h`

// ── Main ────────────────────────────────────────────────────────────────────

const auth   = await authorize()
const sheets = google.sheets({ version: 'v4', auth })
const docId  = await findDartDoc(auth)
console.log(`DART store: ${docId}`)

const meta = await sheets.spreadsheets.get({ spreadsheetId: docId, fields: 'sheets.properties.title' })
if (!(meta.data.sheets ?? []).some(s => s.properties?.title === TAB)) {
  throw new Error(`No "${TAB}" tab in the DART sheet. Open Utils → DART once to initialise it.`)
}

// A store created before target_units / unit_label (or Log.units) existed keeps
// the old short header row. The portal reads positionally so its data is fine,
// but the sheet stops describing itself — repair it here too, so the headers are
// right whether or not the portal has been reopened since.
const HEADER_FIX = [
  { tab: TAB,   headers: HEADERS,  lastCol: LAST_COL },
  { tab: 'Log', lastCol: 'H',
    headers: ['id','date','kind','ref_id','title','minutes','done_at','units'] },
]
for (const { tab, headers, lastCol } of HEADER_FIX) {
  const got = (await sheets.spreadsheets.values.get({
    spreadsheetId: docId, range: `${tab}!A1:${lastCol}1`,
  })).data.values?.[0] ?? []
  if (headers.every((h, i) => got[i] === h)) continue
  console.log(`header repair: ${tab} — ${got.length} col(s) → ${headers.length}`)
  if (DO_WRITE) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: docId, range: `${tab}!A1:${lastCol}1`,
      valueInputOption: 'RAW', requestBody: { values: [headers] },
    })
  }
}

const cur = (await sheets.spreadsheets.values.get({
  spreadsheetId: docId, range: `${TAB}!A:${LAST_COL}`,
})).data.values ?? []

const rowById = new Map()
cur.forEach((r, i) => { if (i > 0 && r[0]) rowById.set(r[0], { idx: i + 1, row: padRow(r) }) })

const now      = new Date().toISOString()
const updates  = []
const appends  = []

for (const g of GOALS) {
  const existing = rowById.get(g.id)
  const created  = existing ? (existing.row[9] || now) : now
  const next     = padRow(goalToRow(g, created, now))
  const verb     = existing ? 'update' : 'ADD   '
  console.log(
    `\n${verb}  ${g.title}`
    + `\n        ${g.startDate} → ${g.endDate}  (${g.frequency})`
    + `\n        time ${fmtH(g.targetMinutes)}   work ${g.targetUnits || '—'} ${g.unitLabel}`
    + `   [${g.priority}]`)
  if (existing) {
    // Compare ignoring updated_at, so a no-op run reports no change.
    const a = [...existing.row]; const b = [...next]
    a[10] = b[10] = ''
    if (JSON.stringify(a) === JSON.stringify(b)) { console.log('        (unchanged)'); continue }
    updates.push({ range: `${TAB}!A${existing.idx}:${LAST_COL}${existing.idx}`, values: [next] })
  } else {
    appends.push(next)
  }
}

if (!DO_WRITE) {
  console.log(`\nDry run — ${updates.length} update(s), ${appends.length} addition(s).`)
  console.log('Re-run with --write to apply.')
  process.exit(0)
}

if (updates.length) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: docId, requestBody: { valueInputOption: 'RAW', data: updates },
  })
}
if (appends.length) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: docId, range: `${TAB}!A:${LAST_COL}`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: appends },
  })
}
console.log(`\n✓ Wrote ${updates.length} update(s), ${appends.length} addition(s).`)
