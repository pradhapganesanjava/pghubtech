#!/usr/bin/env node
/**
 * scripts/dump-mylist.mjs — READ ONLY
 * Dumps the membership of a MyList (default "MyList") joined against LCProblems,
 * showing for each problem: frontend_id, title, difficulty, topics, and any
 * existing pat_* tags. Used to scope the pattern-classification pass.
 *
 *   node scripts/dump-mylist.mjs                 # list named "MyList"
 *   node scripts/dump-mylist.mjs "Blind 75"      # a different list
 */
import { google }   from 'googleapis'
import { readFile }  from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
const WANT_LIST = (process.argv[2] || 'MyList').trim()

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
  const token = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
  c.setCredentials(token)
  return c
}

async function main() {
  const { sheetId } = await loadEnv()
  const auth = await authorize()
  const sheets = google.sheets({ version: 'v4', auth })

  // Lists tab: A list_name, B slug
  const lists = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'LCLists!A2:B' })).data.values || []
  const allNames = [...new Set(lists.map(r => (r[0] || '').trim()).filter(Boolean))]
  const slugs = new Set(lists.filter(r => (r[0] || '').trim() === WANT_LIST).map(r => (r[1] || '').trim()).filter(Boolean))
  console.error(`Lists found: ${allNames.join(' | ')}`)
  console.error(`"${WANT_LIST}" has ${slugs.size} members\n`)

  // Problems tab: A slug, B id, C title, D diff, E topics, H tags
  const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'LCProblems!A2:H' })).data.values || []
  const out = []
  for (const r of rows) {
    const slug = (r[0] || '').trim()
    if (!slugs.has(slug)) continue
    const pats = (r[7] || '').split(/[;\n]+/).map(s => s.trim()).filter(s => /^pat_/.test(s))
    out.push({ id: r[1] || '', title: r[2] || '', diff: r[3] || '', topics: r[4] || '', pats })
  }
  out.sort((a, b) => Number(a.id) - Number(b.id))
  console.log(JSON.stringify({ list: WANT_LIST, count: out.length, problems: out }, null, 2))
}
main().catch(e => { console.error(e.message); process.exit(1) })
