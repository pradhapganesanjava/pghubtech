#!/usr/bin/env node
/**
 * scripts/list-unresolved-pat-anchors.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic helper used once before seed-pat-tags.mjs --write: shows every
 * pat_topic::T::M anchor where inferDs() couldn't pick a DS from the LC
 * topics column. Group by (topic, micro) so we can either add overrides to
 * the seeder or accept those anchors keeping only the short form.
 */

import { google }     from 'googleapis'
import { readFile }   from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

const CREDS = JSON.parse(await readFile(join(__dir, 'credentials.json'), 'utf8'))
const cfg   = CREDS.installed ?? CREDS.web
const c     = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
c.setCredentials(JSON.parse(await readFile(join(__dir, '.token.json'), 'utf8')))

const env     = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
const sheetId = env.match(/VITE_SHEET_ID=(.+)/)[1].trim()
const sheets  = google.sheets({ version: 'v4', auth: c })

const { data }  = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'LCProblems!A2:H' })
const sheetRows = data.values || []
const byId      = new Map()
sheetRows.forEach((r, i) => {
  const id = (r[1] || '').trim()
  if (id) byId.set(id, { rowIdx: i, slug: r[0] || '', title: r[2] || '', topics: r[4] || '' })
})

// Same DS-inference logic as seed-pat-tags.mjs — kept in sync by hand for
// now (this script is a one-shot diagnostic; not worth a shared module).
function inferDs(lcTopics) {
  const t = new Set(lcTopics.split(/[;\n]+/).map(s => s.trim()))
  if (t.has('Linked List'))                                  return 'linked-list'
  if (t.has('Binary Search Tree') && !t.has('Data Stream'))   return 'bst'
  if (t.has('Tree') || t.has('Binary Tree') || t.has('N-ary Tree')) return 'tree'
  if (t.has('Graph') || t.has('Graph Theory') || t.has('Topological Sort') || t.has('Shortest Path')) return 'graph'
  if (t.has('Matrix'))                                        return 'matrices'
  if (t.has('Trie')  && t.has('Design')) return 'trie'
  if (t.has('Stack') && t.has('Design')) return 'stack'
  if (t.has('Queue') && t.has('Design')) return 'queue'
  if (t.has('String'))                                        return 'string'
  if (t.has('Array'))                                         return 'array'
  if (t.has('Math') || t.has('Bit Manipulation') || t.has('Dynamic Programming')
      || t.has('Backtracking') || t.has('Bitmask') || t.has('Data Stream')
      || t.has('Recursion') || t.has('Divide and Conquer')
      || t.has('Combinatorics') || t.has('Number Theory') || t.has('Memoization')
      || t.has('Interactive') || t.has('Simulation')) return 'array'
  return null
}

const csv     = await readFile(join(__dir, '../portal/public/patterns-data.csv'), 'utf8')
const csvRows = csv.split('\n').slice(1).filter(l => l.trim()).map(line => {
  const m = line.match(/^(\d+)\s*,\s*(?:"([^"]*)"|([^\n]*))$/)
  return m ? { id: m[1], tag: (m[2] ?? m[3]).trim() } : null
}).filter(Boolean)

const unresolved = []
const missing    = []
for (const { id, tag } of csvRows) {
  if (!tag.startsWith('pat_topic::')) continue
  const row = byId.get(id)
  if (!row) { missing.push({ id, tag }); continue }
  if (inferDs(row.topics)) continue
  unresolved.push({ id, tag, slug: row.slug, title: row.title, topics: row.topics })
}

console.log(`\nUnresolved topic anchors: ${unresolved.length}`)
console.log(`Missing-from-sheet topic anchors: ${missing.length}\n`)

const byTag = new Map()
unresolved.forEach(u => {
  if (!byTag.has(u.tag)) byTag.set(u.tag, [])
  byTag.get(u.tag).push(u)
})

for (const tag of [...byTag.keys()].sort()) {
  const items = byTag.get(tag)
  console.log(`── ${tag}   (${items.length} problem${items.length > 1 ? 's' : ''})`)
  for (const u of items) {
    const topicsShort = u.topics.split(/[;\n]+/).map(s => s.trim()).filter(Boolean).join(', ') || '(none)'
    console.log(`     LC ${u.id.padStart(4)}  ${u.title}`)
    console.log(`           LC topics: ${topicsShort}`)
  }
  console.log()
}

if (missing.length) {
  console.log('── Missing from sheet (no row with this frontend_id):')
  for (const m of missing) console.log(`     LC ${m.id}  →  ${m.tag}`)
  console.log()
}
