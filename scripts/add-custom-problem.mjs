#!/usr/bin/env node
/**
 * scripts/add-custom-problem.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Append a single custom (non-LeetCode) problem row to the LCProblems sheet,
 * mirroring what the in-portal "Add a problem" modal does.
 *
 * Custom problems live in the 10000+ frontend_id range to avoid colliding
 * with any LeetCode number; their leetcode_url is empty since they don't
 * come from LeetCode. Each problem is a JSON file under scripts/custom-problems/
 * so they're version-controlled and reproducible.
 *
 *   node scripts/add-custom-problem.mjs scripts/custom-problems/foo.json         # dry-run
 *   node scripts/add-custom-problem.mjs scripts/custom-problems/foo.json --write
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
const ARGS       = process.argv.slice(2)
const DO_WRITE   = ARGS.includes('--write')
const JSON_PATH  = ARGS.find(a => !a.startsWith('--'))
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
const TAB = 'LCProblems'

if (!JSON_PATH) {
  console.error('Usage: node scripts/add-custom-problem.mjs <problem.json> [--write]')
  console.error('Example: node scripts/add-custom-problem.mjs scripts/custom-problems/thread-count.json --write')
  process.exit(1)
}

// ── Problem to add (loaded from JSON; see scripts/custom-problems/*.json) ───
// Required fields: slug, frontend_id, title, difficulty.
// Optional fields default to []/'': topics, companies, companies_recent, tags,
// leetcode_url, description_html, notes_drive_id, has_notes.
const raw = JSON.parse(await readFile(JSON_PATH, 'utf8'))
for (const k of ['slug', 'frontend_id', 'title', 'difficulty']) {
  if (!raw[k]) { console.error(`✗ missing required field "${k}" in ${JSON_PATH}`); process.exit(1) }
}
const PROBLEM = {
  slug:             String(raw.slug),
  frontend_id:      String(raw.frontend_id),
  title:            String(raw.title),
  difficulty:       String(raw.difficulty),
  topics:           raw.topics           ?? [],
  companies:        raw.companies        ?? [],
  companies_recent: raw.companies_recent ?? [],
  tags:             raw.tags             ?? [],
  leetcode_url:     raw.leetcode_url     ?? '',
  description_html: raw.description_html ?? '',
  notes_drive_id:   raw.notes_drive_id   ?? '',
  has_notes:        raw.has_notes        ?? '',
}

// ── env + auth (mirrors seed-lists.mjs / ads-to-sheets.mjs) ─────────────────
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

function toRow(p) {
  return [
    p.slug, p.frontend_id, p.title, p.difficulty,
    p.topics.join('; '), p.companies.join('; '), p.companies_recent.join('; '),
    p.tags.join('; '), p.leetcode_url, p.description_html,
    p.notes_drive_id, p.has_notes,
  ]
}

async function main() {
  console.log('\n' + '═'.repeat(60))
  console.log(`  Add custom problem  [${DO_WRITE ? 'WRITE' : 'DRY-RUN'}]`)
  console.log('═'.repeat(60))
  const { sheetId } = await loadEnv()
  const auth = await authorize()
  const sheets = google.sheets({ version: 'v4', auth })

  // Pre-flight: refuse if frontend_id or slug already exists.
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!A2:B` })
  const rows = data.values ?? []
  const slugs = new Set(rows.map(r => (r[0] ?? '').trim()))
  const ids   = new Set(rows.map(r => (r[1] ?? '').trim()))
  if (slugs.has(PROBLEM.slug))         { console.error(`✗ slug "${PROBLEM.slug}" already exists`); process.exit(1) }
  if (ids.has(String(PROBLEM.frontend_id))) { console.error(`✗ id #${PROBLEM.frontend_id} already taken`); process.exit(1) }

  console.log(`\nWill append:\n  #${PROBLEM.frontend_id}  ${PROBLEM.title}  [${PROBLEM.difficulty}]`)
  console.log(`  slug:     ${PROBLEM.slug}`)
  console.log(`  topics:   ${PROBLEM.topics.join(', ')}`)
  console.log(`  companies:${PROBLEM.companies.join(', ')}`)
  console.log(`  tags:     ${PROBLEM.tags.join(', ')}`)

  if (!DO_WRITE) { console.log('\n[dry-run] pass --write to commit.\n'); return }
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId, range: `${TAB}!A:L`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [toRow(PROBLEM)] },
  })
  console.log(`\n✓ Appended #${PROBLEM.frontend_id} ${PROBLEM.title} to ${TAB}.\n`)
}
main().catch(e => { console.error('\n✗', e.message); process.exit(1) })
