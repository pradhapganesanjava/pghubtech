#!/usr/bin/env node
/**
 * scripts/apply-pat-json.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Apply a JSON map of { "<frontend_id>": ["pat tag", ...] } to the LCProblems
 * sheet's tags column (H). Idempotent: only appends tags not already present.
 * Same write path as add-pat-tag-batch.mjs, but the batch is external JSON so we
 * don't bloat that curated file.
 *
 *   node scripts/apply-pat-json.mjs scripts/snowflake-pat.json           # dry-run
 *   node scripts/apply-pat-json.mjs scripts/snowflake-pat.json --write   # apply
 *
 * After --write:  node scripts/build-patterns-csv.mjs --write
 */
import { google }   from 'googleapis'
import { readFile }  from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
const TAB = 'LCProblems'
const COL_ID = 1, COL_TAGS = 7
const DO_WRITE = process.argv.includes('--write')
const JSON_PATH = process.argv.find(a => a.endsWith('.json')) || join(__dir, 'snowflake-pat.json')

async function loadEnv() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  const env = {}
  for (const line of text.split('\n')) { const eq = line.indexOf('='); if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim() }
  return { sheetId: env.VITE_SHEET_ID }
}
async function authorize() {
  const creds = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
  const cfg = creds.installed ?? creds.web
  const c = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
  c.setCredentials(JSON.parse(await readFile(TOKEN_PATH, 'utf8')))
  return c
}

async function main() {
  const BATCH = JSON.parse(await readFile(JSON_PATH, 'utf8'))
  const { sheetId } = await loadEnv()
  const sheets = google.sheets({ version: 'v4', auth: await authorize() })
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!A2:H` })
  const rows = data.values || []
  console.log(`\n  Read ${rows.length} LCProblems rows.  Batch has ${Object.keys(BATCH).length} ids.\n`)

  const byId = new Map()
  rows.forEach((r, i) => { const id = (r[COL_ID] || '').trim(); if (id) byId.set(id, { rowIdx: i, tags: r[COL_TAGS] || '' }) })

  const requests = [], missing = []
  let totalAdd = 0
  for (const [lcId, newTags] of Object.entries(BATCH)) {
    const row = byId.get(String(lcId))
    if (!row) { missing.push(lcId); continue }
    const existing = new Set(row.tags.split(/[;\n]+/).map(s => s.trim()).filter(Boolean))
    const toAdd = newTags.filter(t => !existing.has(t))
    if (!toAdd.length) { console.log(`    LC ${String(lcId).padStart(5)}  (present)`); continue }
    const merged = [...existing, ...toAdd].join('; ')
    requests.push({ range: `${TAB}!H${row.rowIdx + 2}`, values: [[merged]] })
    totalAdd += toAdd.length
    console.log(`    LC ${String(lcId).padStart(5)}  +${toAdd.join('  +')}`)
  }
  if (missing.length) console.log(`\n  Missing from sheet: ${missing.join(', ')}`)
  console.log(`\n  ${requests.length} rows would change; ${totalAdd} new tag occurrences.\n`)
  if (!DO_WRITE) { console.log('  [dry-run] pass --write to apply.\n'); return }
  if (!requests.length) { console.log('  Nothing to write.\n'); return }
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: sheetId, requestBody: { valueInputOption: 'RAW', data: requests } })
  console.log(`  ✓ Patched ${requests.length} rows.\n  Next: node scripts/build-patterns-csv.mjs --write\n`)
}
main().catch(e => { console.error(e.message); process.exit(1) })
