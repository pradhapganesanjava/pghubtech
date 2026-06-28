#!/usr/bin/env node
/**
 * scripts/migrate-topics-to-groups.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Move a set of TOPICS into the Group-By axis. For every LCProblems row, in the
 * tags column (H):
 *   - drop    pat_topic::<t>::<m>           (t in TOPICS)
 *   - convert pat_ds::<ds>::<t>::<m>  ->  pat_ds::<ds>::core::<m>   (keep the DS)
 *   - add     pat_group::<t>  and  pat_group::<t>::<m>
 *
 *   node scripts/migrate-topics-to-groups.mjs            # dry-run
 *   node scripts/migrate-topics-to-groups.mjs --write
 */
import { google }       from 'googleapis'
import { readFile, writeFile } from 'fs/promises'
import { createServer } from 'http'
import { exec }         from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
const TAB = 'LCProblems'
const COL_ID = 1, COL_TAGS = 7
const DO_WRITE = process.argv.includes('--write')
const TOPICS = new Set(['shortest-path', 'longest-path', 'interactive', 'design', 'simulation'])

async function loadEnv() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  const env = {}
  for (const l of text.split('\n')) { const e = l.indexOf('='); if (e > 0) env[l.slice(0, e).trim()] = l.slice(e + 1).trim() }
  return { sheetId: env.VITE_SHEET_ID }
}
async function authorize() {
  const creds = JSON.parse(await readFile(CREDS_PATH, 'utf8')); const cfg = creds.installed ?? creds.web
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
      const code = new URL(req.url, 'http://localhost:3000').searchParams.get('code'); if (!code) { res.end('No code'); return }
      res.end('<h2>✓ Authorized — close this tab.</h2>'); server.close()
      try { const { tokens } = await c.getToken(code); c.setCredentials(tokens); await writeFile(TOKEN_PATH, JSON.stringify(tokens)); resolve(c) } catch (e) { reject(e) }
    })
    server.listen(3000, () => { console.log('\nAuthorize in browser:\n  ' + url + '\n'); exec(`open "${url}"`) })
    server.on('error', reject)
  })
}

function migrateTags(raw) {
  const tags = raw.split(/[;\n]+/).map(s => s.trim()).filter(Boolean)
  const out = new Set(); const groups = new Set(); let changed = false
  for (const tag of tags) {
    const p = tag.split('::')
    if (p[0] === 'pat_topic' && p.length === 3 && TOPICS.has(p[1])) {
      groups.add(`pat_group::${p[1]}`); groups.add(`pat_group::${p[1]}::${p[2]}`); changed = true
    } else if (p[0] === 'pat_ds' && p.length === 4 && TOPICS.has(p[2])) {
      out.add(`pat_ds::${p[1]}::core::${p[3]}`)
      groups.add(`pat_group::${p[2]}`); groups.add(`pat_group::${p[2]}::${p[3]}`); changed = true
    } else {
      out.add(tag)
    }
  }
  for (const g of groups) out.add(g)
  return { changed, tags: [...out] }
}

async function main() {
  const { sheetId } = await loadEnv()
  const sheets = google.sheets({ version: 'v4', auth: await authorize() })
  const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!A2:H` })).data.values || []
  const reqs = []
  rows.forEach((r, i) => {
    const id = (r[COL_ID] || '').trim(); const raw = r[COL_TAGS] || ''
    if (!id) return
    const { changed, tags } = migrateTags(raw)
    if (!changed) return
    reqs.push({ id, rowNum: i + 2, value: tags.join('; ') })
  })
  console.log(`\n  ${reqs.length} rows to migrate.`)
  for (const r of reqs) console.log(`    LC ${String(r.id).padStart(5)}`)
  if (!DO_WRITE) { console.log('\n  [dry-run] pass --write to apply.\n'); return }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId, requestBody: {
      valueInputOption: 'RAW',
      data: reqs.map(r => ({ range: `${TAB}!H${r.rowNum}`, values: [[r.value]] })),
    },
  })
  console.log(`\n  ✓ Migrated ${reqs.length} rows.\n`)
}
main().catch(e => { console.error(e.message); process.exit(1) })
