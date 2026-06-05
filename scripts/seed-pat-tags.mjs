#!/usr/bin/env node
/**
 * scripts/seed-pat-tags.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot migration: take the (anchor, tag) pairs from
 * portal/public/patterns-data.csv (produced by extract-patterns-anchors.mjs)
 * and write the tags into the LCProblems sheet's `tags` column. Idempotent
 * — only appends tags not already present on a row.
 *
 *   node scripts/seed-pat-tags.mjs            # dry-run, reports what would change
 *   node scripts/seed-pat-tags.mjs --write    # actually patches the sheet
 *
 * After running with --write, you can flip the data flow:
 *   • build-patterns-csv.mjs reads the sheet → emits patterns-data.csv
 *   • patterns.html keeps fetching patterns-data.csv (same path)
 *   • adding a NEW pat_* tag in the sheet + re-running build-patterns-csv
 *     propagates to the UI on next load — no patterns.html edit needed.
 *
 * Topic-micro anchors come out of the extractor as `pat_topic::T::M`
 * (DS unknown). This script ENRICHES them: for each such pair, look up the
 * row's LC `topics` column to infer the DS, and write the richer 4-segment
 * form `pat_ds::<inferredDs>::T::M` alongside. The shorter form is kept too
 * — the patterns.html parser accepts both.
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
const COL_SLUG    = 0    // A
const COL_ID      = 1    // B  frontend_id
const COL_TOPICS  = 4    // E  LC topic list, "; "-separated
const COL_TAGS    = 7    // H

// Map an LC `topics` cell (e.g. "Array; Hash Table; Two Pointers") into the
// best-fit DS-id from our schema. Most specific shape wins. Returns null if
// we genuinely can't tell.
function inferDs(lcTopics) {
  const t = new Set(lcTopics.split(/[;\n]+/).map(s => s.trim()))
  // Data Stream problems are stream-of-values by INPUT (array-shape), no
  // matter what BST / Tree / Stack / Queue / Heap tags also appear (those
  // are SOLUTION hints, not input shape). e.g. LC 703 Kth Largest in
  // Stream, LC 901 Online Stock Span, LC 295 Find Median from Stream.
  const isStream = t.has('Data Stream')
  if (t.has('Linked List'))                                  return 'linked-list'
  if (t.has('Binary Search Tree') && !isStream)               return 'bst'
  if ((t.has('Tree') || t.has('Binary Tree') || t.has('N-ary Tree')) && !isStream) return 'tree'
  // LC uses "Graph Theory" in the topics list, NOT "Graph" — accept both.
  // Also catches the topo-sort and shortest-path families.
  if (t.has('Graph') || t.has('Graph Theory') || t.has('Topological Sort') || t.has('Shortest Path')) return 'graph'
  if (t.has('Matrix'))                                        return 'matrices'
  // Trie / Stack / Queue: only when the problem is explicitly a DESIGN
  // problem ("implement / design X") AND not a stream problem. LC tags
  // Trie/Stack/Queue on any problem whose solution uses one — those are
  // TOOL uses, not input shape, and they'd otherwise pollute the DS
  // pages with micros that belong under Array/String/Matrices.
  if (t.has('Trie')  && t.has('Design') && !isStream) return 'trie'
  if (t.has('Stack') && t.has('Design') && !isStream) return 'stack'
  if (t.has('Queue') && t.has('Design') && !isStream) return 'queue'
  if (t.has('String'))                                        return 'string'
  if (t.has('Array'))                                         return 'array'
  // Fallback for the scalar-leaning families: number / single-int /
  // stream problems whose LC topics are ONLY techniques. Most reduce to
  // an array (or a single int treated as a 1-elem sequence) — bucket
  // them under DS=array so they get a DS-specific embed somewhere
  // instead of orphan pat_topic::T::M tags.
  if (t.has('Math') || t.has('Bit Manipulation') || t.has('Dynamic Programming')
      || t.has('Backtracking') || t.has('Bitmask') || t.has('Data Stream')
      || t.has('Recursion') || t.has('Divide and Conquer')
      || t.has('Combinatorics') || t.has('Number Theory') || t.has('Memoization')
      || t.has('Interactive') || t.has('Simulation')) return 'array'
  return null
}

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

async function main() {
  // 1. Parse the CSV produced by extract-patterns-anchors.mjs.
  let csvText
  try { csvText = await readFile(CSV_PATH, 'utf8') }
  catch { console.error(`\n  CSV not found at ${CSV_PATH}. Run:\n    node scripts/extract-patterns-anchors.mjs --write\n  first.\n`); process.exit(1) }
  const csvRows = csvText.split('\n').slice(1).filter(l => l.trim()).map(line => {
    const m = line.match(/^(\d+)\s*,\s*(?:"([^"]*)"|([^\n]*))$/)
    return m ? { id: m[1], tag: (m[2] ?? m[3]).trim() } : null
  }).filter(Boolean)
  console.log(`\n  Loaded ${csvRows.length} (anchor, tag) entries from patterns-data.csv`)

  // 2. Read the sheet's current rows so we can (a) infer DS for topic
  //    anchors and (b) only write back tags that are actually missing.
  const { sheetId } = await loadEnv()
  const auth        = await authorize()
  const sheets      = google.sheets({ version: 'v4', auth })
  const { data }    = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId, range: `${TAB}!A2:H`,
  })
  const sheetRows = data.values || []
  console.log(`  Sheet has ${sheetRows.length} LCProblems rows.`)

  // Index by frontend_id for O(1) lookup. Row index here is 0-based into
  // sheetRows; the absolute sheet row is rowIdx + 2 (header + 1).
  const byId = new Map()
  sheetRows.forEach((r, i) => {
    const id = (r[COL_ID] || '').trim()
    if (id) byId.set(id, { rowIdx: i, topics: r[COL_TOPICS] || '', tags: r[COL_TAGS] || '' })
  })

  // 3. Walk each CSV entry. For pat_topic::T::M, derive the richer
  //    pat_ds::<DS>::T::M form using the row's LC topics. Collect every
  //    new tag we'd add per row.
  const toAdd  = new Map()          // rowIdx → Set<tagToAdd>
  const missing = []                // ids that aren't in the sheet
  let inferred = 0, inferenceMisses = 0

  for (const { id, tag } of csvRows) {
    const row = byId.get(id)
    if (!row) { missing.push(id); continue }
    const existing = new Set(row.tags.split(/[;\n]+/).map(s => s.trim()).filter(Boolean))
    const toAddForRow = toAdd.get(row.rowIdx) || new Set()

    // Always queue the original form.
    if (!existing.has(tag)) toAddForRow.add(tag)

    // If this is a topic-anchor without DS info, enrich.
    if (tag.startsWith('pat_topic::')) {
      const [, topicId, microId] = tag.split('::')
      const ds = inferDs(row.topics)
      if (ds) {
        const rich = `pat_ds::${ds}::${topicId}::${microId}`
        if (!existing.has(rich)) toAddForRow.add(rich)
        inferred++
      } else {
        inferenceMisses++
      }
    }

    if (toAddForRow.size) toAdd.set(row.rowIdx, toAddForRow)
  }

  // 4. Summary
  let totalNew = 0
  toAdd.forEach(s => totalNew += s.size)
  console.log(`\n  DS inferred for ${inferred} topic anchors (${inferenceMisses} unresolved).`)
  console.log(`  ${toAdd.size} sheet rows would change; ${totalNew} new tag occurrences in total.`)
  if (missing.length) console.log(`  ${missing.length} CSV anchor IDs not found in sheet (e.g. ${missing.slice(0, 5).join(', ')}…)`)

  if (!DO_WRITE) {
    console.log(`\n  [dry-run] no sheet writes performed.  Pass --write to apply.\n`)
    // Show a sample of pending changes so it's obvious what would happen.
    const sample = [...toAdd.entries()].slice(0, 3)
    for (const [rowIdx, tagsToAdd] of sample) {
      const row = sheetRows[rowIdx]
      console.log(`    row ${rowIdx + 2} (id ${row[COL_ID]}): +${[...tagsToAdd].join(' · +')}`)
    }
    return
  }

  // 5. Write back. One batchUpdate so we don't hit per-request rate limits.
  const requests = [...toAdd.entries()].map(([rowIdx, tagsToAdd]) => {
    const row = sheetRows[rowIdx]
    const current = (row[COL_TAGS] || '').split(/[;\n]+/).map(s => s.trim()).filter(Boolean)
    const merged  = [...current, ...tagsToAdd].join('; ')
    return {
      range: `${TAB}!H${rowIdx + 2}`,
      values: [[merged]],
    }
  })
  if (!requests.length) { console.log('\n  Nothing to write.\n'); return }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: 'RAW', data: requests },
  })
  console.log(`\n  ✓ Patched ${requests.length} rows  (${totalNew} new tag occurrences).\n`)
  console.log(`  Next: node scripts/build-patterns-csv.mjs --write   # regen CSV from the sheet\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
