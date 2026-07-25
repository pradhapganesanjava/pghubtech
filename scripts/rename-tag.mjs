#!/usr/bin/env node
/**
 * scripts/rename-tag.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Rename an Anki tag across ALL notes in EVERY template tab of the Google Sheet
 * (the "Browse" data source used by the portal). Exact-match on a whole tag —
 * "behave" is renamed to "int-behave", but "behavey" / "int-behave" are left
 * untouched.
 *
 * Dry-run by default: prints every affected note. Pass --commit to write.
 *
 * USAGE
 *   node scripts/rename-tag.mjs behave int-behave              # preview
 *   node scripts/rename-tag.mjs --commit behave int-behave     # write
 *
 * Reuses scripts/credentials.json + scripts/.token.json (same OAuth flow as
 * file-card.mjs). Schema parity with portal/src/adapters/ankiRepo.ts:
 *   row = [ note_id, deck, anki_mod, ...fieldValues, tags(', '-joined) ]
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
const TEMPLATES_TAB = 'Templates'
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

// ─── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { commit: false, words: [] }
  for (const a of argv) {
    if (a === '--commit') out.commit = true
    else if (a === '-h' || a === '--help') out.help = true
    else out.words.push(a)
  }
  ;[out.from, out.to] = out.words
  return out
}

// ─── column index → A1 letter ─────────────────────────────────────────────────
function colToLetter(idx) {
  let s = ''
  for (let n = idx + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  }
  return s
}

// ─── env: sheet id ────────────────────────────────────────────────────────────
async function loadSheetId() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0 && line.slice(0, eq).trim() === 'VITE_SHEET_ID') return line.slice(eq + 1).trim()
  }
  throw new Error('Missing VITE_SHEET_ID in portal/.env.local')
}

// ─── OAuth (identical flow to file-card.mjs) ──────────────────────────────────
async function authorize() {
  const creds = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
  const cfg   = creds.installed ?? creds.web
  const client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
  try {
    const token = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
    client.setCredentials(token)
    client.on('tokens', t => writeFile(TOKEN_PATH, JSON.stringify({ ...token, ...t })))
    return client
  } catch {
    return getNewToken(client)
  }
}
function getNewToken(client) {
  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES })
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const code = new URL(req.url, 'http://localhost:3000').searchParams.get('code')
      if (!code) { res.end('No code received'); return }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h2>&#10003; Authorized! You can close this tab.</h2>')
      server.close()
      try {
        const { tokens } = await client.getToken(code)
        client.setCredentials(tokens)
        await writeFile(TOKEN_PATH, JSON.stringify(tokens))
        resolve(client)
      } catch (e) { reject(e) }
    })
    server.listen(3000, () => {
      console.log('\nOpening browser for Google authorization…\n  ' + authUrl + '\n')
      exec(`open "${authUrl}"`)
    })
    server.on('error', reject)
  })
}

// ─── templates: id + field count (tags col = 3 + fields.length) ───────────────
async function loadTemplates(api, sheetId) {
  const { data } = await api.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TEMPLATES_TAB}!A:J` })
  const rows = data.values ?? []
  if (!rows.length) throw new Error(`"${TEMPLATES_TAB}" tab is empty`)
  const h = rows[0]
  const col = k => h.indexOf(k)
  const order = []
  const count = new Map()
  for (const r of rows.slice(1)) {
    const id = String(r[col('template_id')] ?? '')
    if (!id) continue
    if (!count.has(id)) { count.set(id, 0); order.push(id) }
    const key = String(r[col('field_key')] ?? '')
    if (!key || key === 'tags') continue
    count.set(id, count.get(id) + 1)
  }
  return order.map(id => ({ id, fieldCount: count.get(id) }))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.from || !args.to) {
    console.log('Usage: node scripts/rename-tag.mjs [--commit] <from-tag> <to-tag>')
    process.exit(args.help ? 0 : 1)
  }
  const { from, to } = args
  const sheetId = await loadSheetId()
  const auth    = await authorize()
  const api     = google.sheets({ version: 'v4', auth })
  const templates = await loadTemplates(api, sheetId)

  console.log(`\nRenaming tag "${from}" → "${to}"  (${args.commit ? 'COMMIT' : 'dry-run'})\n`)

  let totalChanged = 0
  for (const t of templates) {
    const tagCol   = 3 + t.fieldCount            // 0-based index of tags column
    const tagLetter = colToLetter(tagCol)
    const lastLetter = colToLetter(tagCol)       // we only read/write the tags col + id col
    // Read note ids (A) and tags (tag col) — two thin columns.
    const { data } = await api.spreadsheets.values.batchGet({
      spreadsheetId: sheetId,
      ranges: [`${t.id}!A2:A`, `${t.id}!${tagLetter}2:${tagLetter}`],
    })
    const ids  = data.valueRanges?.[0]?.values ?? []
    const tags = data.valueRanges?.[1]?.values ?? []
    const n = ids.length
    if (!n) continue

    const newColumn = []        // full tags column, row-aligned, for a single write
    const changedRows = []
    for (let i = 0; i < n; i++) {
      const id  = ids[i]?.[0]
      const raw = tags[i]?.[0] ?? ''
      if (!id) { newColumn.push([raw]); continue }
      const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
      // Match the bare tag AND any hierarchical child ("behave::LP_Base").
      const matches = p => p === from || p.startsWith(from + '::')
      if (!parts.some(matches)) { newColumn.push([raw]); continue }
      const updated = parts.map(p => (matches(p) ? to + p.slice(from.length) : p))
      const joined  = updated.join(', ')
      newColumn.push([joined])
      changedRows.push({ row: i + 2, id, before: raw, after: joined })
    }

    if (!changedRows.length) continue
    totalChanged += changedRows.length
    console.log(`[${t.id}]  ${changedRows.length} note(s):`)
    for (const c of changedRows) console.log(`   row ${c.row}  ${c.id}  "${c.before}" → "${c.after}"`)

    if (args.commit) {
      await api.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${t.id}!${tagLetter}2:${lastLetter}${n + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: newColumn },
      })
      console.log(`   ✓ written`)
    }
    console.log('')
  }

  console.log(`\n${totalChanged} note(s) ${args.commit ? 'updated' : 'would change'}.`)
  if (!args.commit && totalChanged) console.log('Re-run with --commit to write.')
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1) })
