#!/usr/bin/env node
/**
 * scripts/build-patterns-csv.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Production CSV generator. Reads the LCProblems sheet, finds every row whose
 * `tags` column has any `pat_*` tag, and emits portal/public/patterns-data.csv
 * with one (anchor_id, tag) row per pat-tag occurrence.
 *
 * Use this once the seeder (scripts/seed-pat-tags.mjs) has pushed pat tags
 * into the sheet. From that point on, the workflow is:
 *
 *   1. Tag problems in the sheet's `tags` column (manually or via seeder).
 *      Use: pat_ds::<dsId>::core::<microId>            (DS-core)
 *           pat_ds::<dsId>::<topicId>::<microId>       (Topic-under-DS)
 *
 *   2. Re-run:    node scripts/build-patterns-csv.mjs --write
 *
 *   3. patterns.html picks up the new CSV on its next load.
 *
 *   node scripts/build-patterns-csv.mjs           # dry-run, stats only
 *   node scripts/build-patterns-csv.mjs --write   # writes patterns-data.csv
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
const CSV_PATH   = join(__dir, '../portal/public/patterns-data.csv')
const DO_WRITE   = process.argv.includes('--write')
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
const TAB    = 'LCProblems'
// Columns (header row): A slug · B frontend_id · C title · D difficulty
//                       E topics · F companies · G companies_recent · H tags …
const COL_ID   = 1   // B
const COL_TAGS = 7   // H

// ── env + auth (matches the convention used by sibling scripts) ──────────
async function loadEnv() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  const env = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
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

function csvCell(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

async function main() {
  const { sheetId } = await loadEnv()
  const auth   = await authorize()
  const sheets = google.sheets({ version: 'v4', auth })

  // Pull only the columns we need (B for frontend_id, H for tags).
  // Range A2:H avoids fetching descriptions / notes blobs we don't care about.
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId, range: `${TAB}!A2:H`,
  })
  const rows = data.values || []
  console.log(`\n  Read ${rows.length} LCProblems rows.`)

  const out = []   // { anchor_id, tag }
  let rowsWithPat = 0
  for (const r of rows) {
    const id   = (r[COL_ID]   || '').trim()
    const tags = (r[COL_TAGS] || '').trim()
    if (!id || !tags) continue
    // Tags column is "; "-separated. Filter for the pat_ prefix.
    const pats = tags.split(/[;\n]+/).map(s => s.trim()).filter(s => /^pat_/.test(s))
    if (!pats.length) continue
    rowsWithPat++
    for (const tag of pats) out.push({ anchor_id: id, tag })
  }

  console.log(`  → ${rowsWithPat} rows carry pat_* tags`)
  console.log(`  → ${out.length} (anchor, tag) entries\n`)

  if (!out.length) {
    console.log('  No pat_* tags in sheet — run scripts/seed-pat-tags.mjs first.\n')
    if (!DO_WRITE) return
  }

  if (!DO_WRITE) {
    console.log(`  [dry-run] would write ${CSV_PATH}`)
    console.log(`  Pass --write to commit.\n`)
    return
  }

  const header = 'anchor_id,tag\n'
  const body   = out.map(r => csvCell(r.anchor_id) + ',' + csvCell(r.tag)).join('\n')
  await writeFile(CSV_PATH, header + body + '\n')
  console.log(`  ✓ Wrote ${CSV_PATH}  (${out.length} rows)\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
