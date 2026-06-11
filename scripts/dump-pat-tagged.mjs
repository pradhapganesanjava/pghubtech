#!/usr/bin/env node
/**
 * scripts/dump-pat-tagged.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only. Dumps every LCProblems row that carries any pat_* tag to
 * scripts/pat-tagged.json — the input for pat_group:: classification.
 *
 * Each entry: { id, title, difficulty, topics, pat_ds:[...], pat_topic:[...],
 *               pat_group:[...] }  (pat_group lists any groups ALREADY tagged).
 *
 *   node scripts/dump-pat-tagged.mjs            # writes scripts/pat-tagged.json
 */
import { google }              from 'googleapis'
import { readFile, writeFile } from 'fs/promises'
import { dirname, join }       from 'path'
import { fileURLToPath }       from 'url'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const OUT_PATH   = join(__dir, 'pat-tagged.json')
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
const TAB = 'LCProblems'
// A slug · B frontend_id · C title · D difficulty · E topics · F companies · G recent · H tags
const COL_ID = 1, COL_TITLE = 2, COL_DIFF = 3, COL_TOPICS = 4, COL_TAGS = 7

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
  c.setCredentials(JSON.parse(await readFile(TOKEN_PATH, 'utf8')))
  return c
}

async function main() {
  const { sheetId } = await loadEnv()
  const sheets = google.sheets({ version: 'v4', auth: await authorize() })
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!A2:H` })
  const rows = data.values || []

  const out = []
  for (const r of rows) {
    const id   = (r[COL_ID]   || '').trim()
    const tags = (r[COL_TAGS] || '').trim()
    if (!id || !tags) continue
    const pats = tags.split(/[;\n]+/).map(s => s.trim()).filter(s => /^pat_/.test(s))
    if (!pats.length) continue
    out.push({
      id,
      title:      (r[COL_TITLE]  || '').trim(),
      difficulty: (r[COL_DIFF]   || '').trim(),
      topics:     (r[COL_TOPICS] || '').trim(),
      pat_ds:     pats.filter(t => t.startsWith('pat_ds::')),
      pat_topic:  pats.filter(t => t.startsWith('pat_topic::')),
      pat_group:  pats.filter(t => t.startsWith('pat_group::')),
    })
  }
  out.sort((a, b) => Number(a.id) - Number(b.id))
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n')
  console.log(`\n  ✓ Wrote ${OUT_PATH}  (${out.length} pat-tagged problems)\n`)
}
main().catch(e => { console.error(e.message); process.exit(1) })
