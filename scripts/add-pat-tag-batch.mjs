#!/usr/bin/env node
/**
 * scripts/add-pat-tag-batch.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Apply a hand-curated batch of (LC id → pat tags) to the LCProblems sheet.
 * Idempotent: only appends tags not already on the row. Use for incrementally
 * classifying problems Claude has hand-picked the DS / topic / micro for.
 *
 *   node scripts/add-pat-tag-batch.mjs            # dry-run
 *   node scripts/add-pat-tag-batch.mjs --write    # actually patches
 *
 * Edit the BATCH constant below to add more problems. After --write, follow
 * with build-patterns-csv to refresh the CSV and propagate to the UI.
 *
 * Tag format reminder:
 *   pat_ds::<ds>::core::<microId>            (DS-core micro)
 *   pat_ds::<ds>::<topicId>::<microId>       (Topic embedded under DS)
 *   pat_topic::<topicId>::<microId>          (short form — DS not yet inferred)
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
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
const TAB    = 'LCProblems'
const COL_ID   = 1   // B
const COL_TAGS = 7   // H

// ─── Batch — edit this to queue new classifications ──────────────────────
// Each entry: LC frontend_id → array of pat tags (most-specific form
// preferred; the short pat_topic::T::M form is also accepted).
//
// First batch (Phase 3 starter): high-traffic Top-100-Liked problems that
// weren't previously anchored. Each tag uses the 4-segment form so the
// derived maps in patterns.html pick them up directly.
const BATCH = {
  // 17 Letter Combinations of a Phone Number — string × backtracking
  17:  ['pat_ds::string::backtrack::permutation'],
  // 22 Generate Parentheses — string × backtracking (build with constraints)
  22:  ['pat_ds::string::backtrack::partition-on-string'],
  // 55 Jump Game — array × greedy (running max reach)
  55:  ['pat_ds::array::greedy::running-extreme'],
  // 101 Symmetric Tree — tree × DFS (mirror-recurse)
  101: ['pat_ds::tree::dfs::dfs-template'],
  // 114 Flatten Binary Tree to Linked List — tree × DFS pre-order
  114: ['pat_ds::tree::dfs::dfs-tree-orders'],
  // 128 Longest Consecutive Sequence — array × hash (seen-set, expand chains)
  128: ['pat_ds::array::hash::seen-set'],
  // 138 Copy List with Random Pointer — linked-list × hash (node→clone map)
  138: ['pat_ds::linked-list::hash::seen-set'],
  // 148 Sort List — linked-list × sorting (merge sort on lists)
  148: ['pat_ds::linked-list::sorting::merge-sort-counting'],
  // 238 Product of Array Except Self — array × prefix-sum family (prefix×suffix product)
  238: ['pat_ds::array::prefix-sum::ps-1d'],
  // 581 Shortest Unsorted Continuous Subarray — array × monotonic stack (or sort)
  581: ['pat_ds::array::stack-topic::monotonic-stack'],
  // 617 Merge Two Binary Trees — tree × DFS (parallel recurse)
  617: ['pat_ds::tree::dfs::dfs-template'],
  // 763 Partition Labels — string × greedy (last-occurrence sweep)
  763: ['pat_ds::string::greedy::sort-and-sweep'],
  // 994 Rotting Oranges — matrices × BFS (multi-source)
  994: ['pat_ds::matrices::bfs::bfs-multi-source'],
  // 215 Kth Largest Element — array × heap top-K (already partially anchored)
  // skip — already in CSV
  // 53 Maximum Subarray — already core under array kadane
  // 56 Merge Intervals — already in greedy::sort-and-sweep
  // 200 Number of Islands — already DFS template, also add grid-flood
  200: ['pat_ds::matrices::dfs::dfs-grid-flood'],
  // 1143 Longest Common Subsequence — string × DP 2D
  1143:['pat_ds::string::dp::dp-2-strings'],
  // 309 Best Time Buy Sell with Cooldown — array × DP state-machine (already anchored, dup-safe)
  309: ['pat_ds::array::dp::state-machine-dp'],
  // 416 Partition Equal Subset Sum — array × 0/1 knapsack (already anchored)
  416: ['pat_ds::array::dp::knapsack-01'],
  // 287 Find the Duplicate Number — array × index-as-hash AND two-ptr fast-slow
  287: ['pat_ds::array::two-pointers::tp-fast-slow'],
  // 11 Container With Most Water — array × converging two pointers (already anchored, dup-safe)
  11:  ['pat_ds::array::two-pointers::tp-converging'],
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
  const { sheetId } = await loadEnv()
  const auth        = await authorize()
  const sheets      = google.sheets({ version: 'v4', auth })
  const { data }    = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId, range: `${TAB}!A2:H`,
  })
  const rows = data.values || []
  console.log(`\n  Read ${rows.length} LCProblems rows.`)
  console.log(`  Batch has ${Object.keys(BATCH).length} LC ids queued.\n`)

  const byId = new Map()
  rows.forEach((r, i) => {
    const id = (r[COL_ID] || '').trim()
    if (id) byId.set(id, { rowIdx: i, tags: r[COL_TAGS] || '' })
  })

  const requests = []
  const missing  = []
  let totalAdd   = 0

  for (const [lcId, newTags] of Object.entries(BATCH)) {
    const row = byId.get(String(lcId))
    if (!row) { missing.push(lcId); continue }
    const existing = new Set(row.tags.split(/[;\n]+/).map(s => s.trim()).filter(Boolean))
    const toAdd = newTags.filter(t => !existing.has(t))
    if (!toAdd.length) {
      console.log(`    LC ${lcId.padStart(4)}  (all tags already present)`)
      continue
    }
    const merged = [...existing, ...toAdd].join('; ')
    requests.push({ range: `${TAB}!H${row.rowIdx + 2}`, values: [[merged]] })
    totalAdd += toAdd.length
    console.log(`    LC ${lcId.padStart(4)}  +${toAdd.join('  +')}`)
  }

  if (missing.length) console.log(`\n  Missing from sheet: ${missing.join(', ')}`)
  console.log(`\n  ${requests.length} rows would change; ${totalAdd} new tag occurrences.\n`)

  if (!DO_WRITE) { console.log('  [dry-run] no sheet writes performed.  Pass --write to apply.\n'); return }
  if (!requests.length) { console.log('  Nothing to write.\n'); return }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: 'RAW', data: requests },
  })
  console.log(`  ✓ Patched ${requests.length} rows.\n`)
  console.log(`  Next: node scripts/build-patterns-csv.mjs --write\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
