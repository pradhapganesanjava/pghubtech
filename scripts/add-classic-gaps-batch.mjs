#!/usr/bin/env node
/**
 * scripts/add-classic-gaps-batch.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Add classic interview problems that have NO LeetCode number (GfG-only)
 * as custom AdsHub problems (#10066–#10068):
 *
 *   10066  Top View of Binary Tree
 *   10067  Left View of Binary Tree  (removed — see note below)
 *   10068  Next Smaller Element
 *
 * These kept surfacing as "matched a pattern but has no LCProblems row",
 * which made them unaddable to MyLists. Unlike the prachub batch (which used
 * `_ds::`/`_prob::` tags), these carry real `pat_ds::`/`pat_topic::` tags so
 * they slot into the existing pattern tree alongside their LC siblings.
 *
 *   node scripts/add-classic-gaps-batch.mjs           # dry-run
 *   node scripts/add-classic-gaps-batch.mjs --write
 *
 * Idempotent: skips any (slug or frontend_id) already in LCProblems.
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
const DO_WRITE   = process.argv.includes('--write')
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
const TAB = 'LCProblems'

const GFG = 'https://www.geeksforgeeks.org'

const PROBLEMS = [
  // NOTE: #10066's description was later rewritten in-sheet with the full GfG
  // statement + examples + a closest-LC chip — see
  // scripts/custom-problems/top-view-of-binary-tree.json (applied via
  // `add-problem-note.mjs custom-top-view-of-binary-tree --desc-json`).
  { id: 10066, slug: 'top-view-of-binary-tree',
    title: 'Top View of Binary Tree',
    difficulty: 'Medium', topics: ['Tree', 'Breadth-First Search', 'Hash Table', 'Binary Tree'],
    tags: ['pat_ds::tree::bfs::bfs-position-tracked', 'pat_topic::bfs::bfs-position-tracked'],
    url: `${GFG}/problems/top-view-of-binary-tree/1`,
    summary: 'Print nodes visible when the tree is viewed from directly above, left to right. BFS carrying a horizontal-distance (column) per node; keep the FIRST node seen per column. Same skeleton as LC 314 / 987 (bfs-position-tracked) — those collect every node per column, this keeps only the first. Bottom View is the identical scan keeping the LAST per column. Must be BFS: a DFS can reach a shallower node later and overwrite a correct entry unless you also track depth.' },

  // #10067 Left View of Binary Tree was added here and later REMOVED (sheet row
  // + Freshworks list + pat tags): it is an exact mirror of LC 199 (Right Side
  // View) — same level-order BFS, index 0 of each level instead of the last —
  // so it earned nothing over just solving 199. Don't re-add it.

  // NOTE: #10068's description was later rewritten in-sheet with the full GfG
  // statement + examples — see scripts/custom-problems/next-smaller-element.json
  // (applied via `add-problem-note.mjs custom-next-smaller-element --desc-json`).
  { id: 10068, slug: 'next-smaller-element',
    title: 'Next Smaller Element',
    difficulty: 'Medium', topics: ['Array', 'Stack', 'Monotonic Stack'],
    tags: ['pat_ds::array::stack-topic::monotonic-stack', 'pat_topic::stack-topic::monotonic-stack'],
    url: `${GFG}/next-smaller-element/`,
    summary: 'For each element, the first element to its RIGHT that is smaller; -1 if none. Monotonic INCREASING stack: for each cur, pop while stack-top > cur and set nextSmaller[popped] = cur; anything left on the stack at the end gets -1. O(n) time / O(n) space — each index pushed and popped at most once. Exact mirror of LC 496 (flip the pop comparison); Previous Smaller Element is the same scan run right-to-left. LC 84 uses both directions at once to get histogram spans.' },
]

// ── env + auth ─────────────────────────────────────────────────────────────
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

function buildDescription(p) {
  return `<div>
  <p><em>Classic interview problem with no LeetCode number — original source: <a href="${p.url}">${p.url}</a></em></p>
  <p>${p.summary}</p>
</div>`
}

function toRow(p) {
  return [
    `custom-${p.slug}`,            // slug
    String(p.id),                  // frontend_id
    p.title,                       // title
    p.difficulty,                  // difficulty
    p.topics.join('; '),           // topics
    'Freshworks',                  // companies
    '',                            // companies_recent
    p.tags.join('; '),             // tags
    p.url,                         // leetcode_url (repurposed: GfG URL)
    buildDescription(p),           // description_html
    '',                            // notes_drive_id
    '',                            // has_notes
  ]
}

async function main() {
  console.log('\n' + '═'.repeat(60))
  console.log(`  Add classic no-LC-number problems  [${DO_WRITE ? 'WRITE' : 'DRY-RUN'}]`)
  console.log('═'.repeat(60))
  const { sheetId } = await loadEnv()
  const auth = await authorize()
  const sheets = google.sheets({ version: 'v4', auth })

  // Pre-flight: dedupe against existing rows (by slug OR frontend_id).
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!A2:B` })
  const existing = data.values ?? []
  const slugs = new Set(existing.map(r => (r[0] ?? '').trim()))
  const ids   = new Set(existing.map(r => (r[1] ?? '').trim()))

  const fresh = [], skipped = []
  for (const p of PROBLEMS) {
    const slug = `custom-${p.slug}`
    if (slugs.has(slug))       { skipped.push(`${p.id} (slug exists)`); continue }
    if (ids.has(String(p.id))) { skipped.push(`${p.id} (id taken)`); continue }
    fresh.push(p)
  }

  console.log(`\nTotal in batch:  ${PROBLEMS.length}`)
  console.log(`Already present: ${skipped.length}${skipped.length ? '\n  ' + skipped.join('\n  ') : ''}`)
  console.log(`To append:       ${fresh.length}`)
  for (const p of fresh) console.log(`  #${p.id}  [${p.difficulty}]  ${p.title}`)

  if (!DO_WRITE) { console.log('\n[dry-run] pass --write to commit.\n'); return }
  if (!fresh.length) { console.log('\n✓ Nothing to add.\n'); return }

  const rows = fresh.map(toRow)
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId, range: `${TAB}!A:L`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  })
  console.log(`\n✓ Appended ${fresh.length} rows to ${TAB}.\n`)
}
main().catch(e => { console.error('\n✗', e.message); process.exit(1) })
