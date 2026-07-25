#!/usr/bin/env node
/**
 * scripts/import-behave-csv.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Bulk-import interview-prep rows from a CSV into the Anki sheet as "basic"
 * (Front/Back) notes:
 *   Front = Question
 *   Back  = the remaining columns (Area, Primary Focus, Expected Answer,
 *           Sample Answer) rendered as labelled HTML sections
 *   Deck  = Behavioral
 *   Tags  = int-behave
 *
 * Dry-run by default (prints the first few cards). Pass --commit to append.
 *
 * USAGE
 *   node scripts/import-behave-csv.mjs <file.csv>
 *   node scripts/import-behave-csv.mjs --commit <file.csv>
 *
 * Row format + noteId scheme are identical to file-card.mjs / ankiRepo.ts:
 *   [ noteId, deck, ankiMod, Front, Back, tags ]
 */

import { google }              from 'googleapis'
import { readFile, writeFile } from 'fs/promises'
import { dirname, join }       from 'path'
import { fileURLToPath }       from 'url'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')

const TEMPLATE = 'basic'
const DECK     = 'Behavioral'
const TAGS     = ['int-behave']

// ─── minimal RFC-4180 CSV parser (quotes, escaped quotes, embedded newlines) ──
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)   // strip BOM
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function buildBack(rec) {
  const section = (label, val) =>
    val && val.trim()
      ? `<p><b>${label}:</b> ${esc(val).replace(/\n/g, '<br>')}</p>`
      : ''
  return [
    section('Area',            rec['Area']),
    section('Primary Focus',   rec['Primary Focus (what is being tested)']),
    section('Expected Answer', rec['Expected Answer (what a strong answer must contain)']),
    '<hr>',
    section('Sample Answer',   rec['Sample Answer']),
  ].filter(Boolean).join('\n')
}

const newNoteId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

async function loadSheetId() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0 && line.slice(0, eq).trim() === 'VITE_SHEET_ID') return line.slice(eq + 1).trim()
  }
  throw new Error('Missing VITE_SHEET_ID in portal/.env.local')
}

async function authorize() {
  const creds  = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
  const cfg    = creds.installed ?? creds.web
  const client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
  const token  = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
  client.setCredentials(token)
  client.on('tokens', t => writeFile(TOKEN_PATH, JSON.stringify({ ...token, ...t })))
  return client
}

async function main() {
  const argv   = process.argv.slice(2)
  const commit = argv.includes('--commit')
  const file   = argv.find(a => !a.startsWith('--'))
  if (!file) { console.log('Usage: node scripts/import-behave-csv.mjs [--commit] <file.csv>'); process.exit(1) }

  const rows = parseCsv(await readFile(file, 'utf8')).filter(r => r.some(c => c.trim()))
  const header = rows[0]
  const records = rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
  const usable = records.filter(rec => (rec['Question'] ?? '').trim())

  console.log(`\nParsed ${records.length} data row(s); ${usable.length} with a Question.`)
  console.log(`Template=${TEMPLATE}  Deck=${DECK}  Tags=[${TAGS.join(', ')}]  (${commit ? 'COMMIT' : 'dry-run'})\n`)

  const sheetRows = usable.map(rec => {
    const front = esc(rec['Question']).replace(/\n/g, '<br>')
    const back  = buildBack(rec)
    return [newNoteId(), DECK, String(Date.now()), front, back, TAGS.join(', ')]
  })

  // Preview first 2 cards.
  for (const r of sheetRows.slice(0, 2)) {
    console.log('── FRONT:', r[3])
    console.log('   BACK :', r[4].replace(/\n/g, '\n           '))
    console.log('')
  }
  if (sheetRows.length > 2) console.log(`… and ${sheetRows.length - 2} more.\n`)

  if (!commit) {
    console.log(`Dry-run only. Re-run with --commit to append ${sheetRows.length} note(s) to the "${TEMPLATE}" tab.`)
    return
  }

  const sheetId = await loadSheetId()
  const api     = google.sheets({ version: 'v4', auth: await authorize() })
  await api.spreadsheets.values.append({
    spreadsheetId:    sheetId,
    range:            `${TEMPLATE}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: sheetRows },
  })
  console.log(`✓ Appended ${sheetRows.length} note(s) to the "${TEMPLATE}" tab.`)
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1) })
