#!/usr/bin/env node
/**
 * scripts/seed-code.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Seed the LeetCode starter code (Python3 + Java) into the LCCode sheet tab so
 * the AdsHub code editor opens with the real function stub for every problem.
 *
 * Source: lc_store/.cache.json — the local LeetCode fetch cache, keyed by slug,
 * each entry with codeSnippets:[{langSlug, code}].
 *
 * SAFE / IDEMPOTENT: only appends rows for slugs NOT already in LCCode, so any
 * code you've saved in the app is never overwritten.
 *
 *   node scripts/seed-code.mjs            # dry-run (coverage report)
 *   node scripts/seed-code.mjs --write    # append starter rows to LCCode
 *   node scripts/seed-code.mjs --write --ads-root /path/to/_ADS
 */

import { google }              from 'googleapis'
import { readFile, writeFile } from 'fs/promises'
import { createServer }        from 'http'
import { exec }                from 'child_process'
import { dirname, join }       from 'path'
import { fileURLToPath }       from 'url'
import { homedir }             from 'os'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const DO_WRITE   = process.argv.includes('--write')
const ADS_ROOT   = (() => { const i = process.argv.indexOf('--ads-root'); return i > -1 ? process.argv[i + 1] : join(homedir(), '_ADS') })()
const CACHE      = join(ADS_ROOT, 'lc_store', '.cache.json')
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
const CODE_TAB = 'LCCode'

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
    if (!SCOPES.every(s => (token.scope ?? '').split(/\s+/).includes(s))) return getNewToken(c)
    c.setCredentials(token); c.on('tokens', t => writeFile(TOKEN_PATH, JSON.stringify({ ...token, ...t }))); return c
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
    server.listen(3000, () => { console.log('\nAuthorize:\n  ' + url + '\n'); exec(`open "${url}"`) })
    server.on('error', reject)
  })
}
async function ensureCodeTab(sheets, sheetId) {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties.title' })
  if (!(data.sheets ?? []).some(s => s.properties?.title === CODE_TAB)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: [{ addSheet: { properties: { title: CODE_TAB } } }] } })
    await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `${CODE_TAB}!A1`, valueInputOption: 'RAW',
      requestBody: { values: [['slug', 'python3', 'java', 'py3_modified', 'java_modified', 'pins']] } })
    console.log(`  Created "${CODE_TAB}" tab.`)
  }
}

const CELL = 49000
const trunc = s => (s && s.length > CELL ? s.slice(0, CELL) : (s || ''))

async function main() {
  console.log('\n' + '═'.repeat(60))
  console.log(`  Seed starter code → LCCode  [${DO_WRITE ? 'WRITE' : 'DRY-RUN'}]`)
  console.log('═'.repeat(60))

  const cache = JSON.parse(await readFile(CACHE, 'utf8'))
  const slugs = Object.keys(cache)
  console.log(`\n.cache.json problems: ${slugs.length}`)

  const { sheetId } = await loadEnv()
  const auth = await authorize()
  const sheets = google.sheets({ version: 'v4', auth })
  if (DO_WRITE) await ensureCodeTab(sheets, sheetId)

  // Existing LCCode slugs → never overwrite saved code.
  const existing = new Set()
  try {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${CODE_TAB}!A2:A` })
    for (const r of (data.values ?? [])) if (r[0]) existing.add(r[0].trim())
  } catch { /* tab absent */ }
  console.log(`Existing LCCode rows (kept as-is): ${existing.size}`)

  const rows = []
  let noSnippet = 0
  for (const slug of slugs) {
    if (existing.has(slug)) continue
    const snips = cache[slug]?.codeSnippets ?? []
    const py3  = snips.find(s => s.langSlug === 'python3')?.code ?? ''
    const java = snips.find(s => s.langSlug === 'java')?.code ?? ''
    if (!py3 && !java) { noSnippet++; continue }
    rows.push([slug, trunc(py3), trunc(java), '', '', '{}'])
  }

  console.log(`\nWill add starter code for: ${rows.length} problems`)
  console.log(`Skipped (already in LCCode): ${existing.size}   ·   no py3/java snippet: ${noSnippet}`)
  if (rows[0]) {
    console.log(`\nSample (${rows[0][0]}):`)
    console.log('  python3: ' + JSON.stringify(rows[0][1]).slice(0, 90) + '…')
  }

  if (!DO_WRITE) { console.log('\n[dry-run] Pass --write to commit.\n'); return }

  const BATCH = 500
  for (let i = 0; i < rows.length; i += BATCH) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId, range: `${CODE_TAB}!A:F`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows.slice(i, i + BATCH) },
    })
    process.stdout.write(`\r  Written ${Math.min(i + BATCH, rows.length)}/${rows.length}`)
  }
  console.log(`\n\n✓ Seeded ${rows.length} starter-code rows into ${CODE_TAB}.\n`)
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1) })
