#!/usr/bin/env node
/**
 * scripts/correct-pat-tags.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Apply per-(LC-id) tag corrections discovered during audit. For each
 * correction, DROP specific tags and ADD others. Idempotent — drops that
 * aren't present are no-ops; adds that are already present are skipped.
 *
 *   node scripts/correct-pat-tags.mjs            # dry-run
 *   node scripts/correct-pat-tags.mjs --write    # actually patches the sheet
 *
 * Each CORRECTION entry has the audit-source as a comment so we can trace
 * why it was made.
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
// Optional id allowlist:  --only 139,322,343   (or --only=139,322).
// Restricts the run to those corrections — lets a single themed subset
// (e.g. the DP re-homing) be applied without touching unrelated rows.
const ONLY = (() => {
  const inline = process.argv.find(a => a.startsWith('--only='))
  if (inline) return new Set(inline.slice(7).split(',').map(s => s.trim()).filter(Boolean))
  const i = process.argv.indexOf('--only')
  if (i >= 0 && process.argv[i + 1]) return new Set(process.argv[i + 1].split(',').map(s => s.trim()).filter(Boolean))
  return null
})()
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
const TAB    = 'LCProblems'
const COL_ID   = 1
const COL_TAGS = 7

// ─── Corrections — derived from audit passes ────────────────────────────
const CORRECTIONS = [
  // Audit pass 1 — drop suboptimal tags where a better tag also exists.
  { id: 287, drop: ['pat_topic::hash::seen-set', 'pat_ds::array::hash::seen-set'],
    why: 'Floyd cycle (tp-fast-slow) is O(1) — seen-set is O(n) suboptimal.' },
  { id: 141, drop: ['pat_topic::hash::seen-set', 'pat_ds::linked-list::hash::seen-set'],
    why: 'Floyd cycle (tp-fast-slow / floyd-cycle) is O(1) — seen-set is O(n) suboptimal.' },
  { id: 167, drop: ['pat_topic::two-pointers::tp-converging', 'pat_ds::array::two-pointers::tp-converging'],
    why: 'tp-k-sum is the more specific optimal tag for Two Sum II Sorted; converging is residual.' },

  // Audit pass 2 — relocate to the new sub-micros added this turn.
  { id: 1192, drop: ['pat_topic::dfs::dfs-template', 'pat_ds::graph::dfs::dfs-template'],
    add:  ['pat_ds::graph::core::tarjan-bridges'],
    why: 'Tarjan bridge-finding — own sub-micro now exists.' },
  { id: 1568, add: ['pat_ds::graph::core::tarjan-bridges'],
    why: 'Min Days to Disconnect Island — articulation/bridge variant on grid.' },

  { id: 489, drop: ['pat_topic::dfs::dfs-template', 'pat_ds::graph::dfs::dfs-template'],
    add:  ['pat_ds::graph::dfs::dfs-motion-undo'],
    why: 'Robot Room Cleaner — DFS with physical motion + move-back, own sub-micro.' },

  { id: 1284, drop: ['pat_ds::matrices::bfs::bfs-shortest-unweighted'],
    add:  ['pat_ds::matrices::bfs::bfs-encoded-state'],
    why: 'Min Flips Convert Binary Matrix — encode matrix as int state; bfs-encoded-state fits.' },
  { id: 752, add: ['pat_ds::array::bfs::bfs-encoded-state'],
    why: 'Open the Lock — 4-digit string state encoding; ALSO fits encoded-state.' },
  { id: 773, add: ['pat_ds::matrices::bfs::bfs-encoded-state'],
    why: 'Sliding Puzzle — board as string; canonical encoded-state.' },

  { id: 1293, drop: ['pat_ds::matrices::bfs::bfs-shortest-unweighted'],
    add:  ['pat_ds::matrices::bfs::bfs-state-augmented'],
    why: 'Shortest Path with Obstacles Elim — (r,c,k) state-augmented BFS.' },
  { id: 864, add: ['pat_ds::matrices::bfs::bfs-state-augmented'],
    why: 'Shortest Path to Get All Keys — (r,c,keysBitmask) state-augmented.' },
  { id: 1102, add: ['pat_ds::matrices::bfs::bfs-state-augmented'],
    why: 'Path With Maximum Minimum Value — alternative formulation, bfs over (r,c,minSoFar).' },

  // Re-home stragglers out of dp-1d-linear after the rolling-state-fixed-window split.
  { id: 139, drop: ['pat_topic::dp::dp-1d-linear', 'pat_ds::string::dp::dp-1d-linear'],
    add:  ['pat_topic::dp::dp-lis', 'pat_ds::string::dp::dp-lis'],
    why: 'Word Break — dp[i]=∃j<i dp[j]∧s[j..i]∈dict scans ALL prior states (OR-segmentation), not a constant lookback → dp-lis skeleton.' },
  { id: 322, drop: ['pat_topic::dp::dp-1d-linear', 'pat_ds::array::dp::dp-1d-linear'],
    why: 'Coin Change — ranges over a choice set of coins; already carries knapsack-unbounded, so dp-1d-linear is redundant.' },
  { id: 343, drop: ['pat_topic::dp::dp-1d-linear', 'pat_ds::array::dp::dp-1d-linear'],
    add:  ['pat_topic::dp::knapsack-unbounded', 'pat_ds::array::dp::knapsack-unbounded'],
    why: 'Integer Break — partition n into REUSABLE summands maximizing product; unbounded-knapsack skeleton (max-product objective).' },
  { id: 837, drop: ['pat_topic::dp::dp-1d-linear', 'pat_ds::array::dp::dp-1d-linear'],
    add:  ['pat_topic::dp::rolling-state-variable-window', 'pat_ds::array::dp::rolling-state-variable-window'],
    why: 'New 21 Game — contiguous W-wide window sum kept O(1) via running sum; W is a parameter (new micro rolling-state-variable-window).' },
  { id: 403, drop: ['pat_topic::dp::dp-1d-linear', 'pat_ds::array::dp::dp-1d-linear'],
    add:  ['pat_topic::dp::augmented-state-reachability', 'pat_ds::array::dp::augmented-state-reachability'],
    why: 'Frog Jump — (stone, speed) augmented-state reachability; each node holds a SET of states (new micro augmented-state-reachability).' },
  { id: 1335, drop: ['pat_topic::dp::interval-dp', 'pat_ds::array::dp::interval-dp'],
    add:  ['pat_topic::dp::dp-linear-partition', 'pat_ds::array::dp::dp-linear-partition'],
    why: 'Min Difficulty of a Job Schedule — partition jobs into d CONTIGUOUS days minimizing sum of daily maxes = linear k-segment partition DP, not [i,j] interval DP.' },
  { id: 1106, drop: ['pat_topic::stack-topic::decode-string', 'pat_ds::string::stack-topic::decode-string'],
    add:  ['pat_topic::stack-topic::expression-eval', 'pat_ds::string::stack-topic::expression-eval'],
    why: 'Parsing A Boolean Expression — operator-precedence + parens evaluation (Basic Calculator family), not nested-count decode-string.' },
  { id: 890, drop: ['pat_topic::hash::freq-counter', 'pat_ds::string::hash::freq-counter'],
    add:  ['pat_ds::string::hash::bijection-map'],
    why: 'Find and Replace Pattern — word matches pattern iff a consistent two-way char<->char map exists (bijection, like 205/290), not frequency counting. Catalog already anchors it under bijection-map.' },
  { id: 1751, drop: ['pat_topic::dp::knapsack-01', 'pat_ds::array::dp::knapsack-01'],
    add:  ['pat_topic::dp::weighted-interval-schedule', 'pat_ds::array::dp::weighted-interval-schedule'],
    why: 'Max Events Attended II — pick <=K non-overlapping weighted intervals to max value; weighted interval scheduling (sort+binary-search predecessor), not classic 0/1 knapsack.' },
]

// ── env + auth ──────────────────────────────────────────────────────────
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

  const byId = new Map()
  rows.forEach((r, i) => {
    const id = (r[COL_ID] || '').trim()
    if (id) byId.set(id, { rowIdx: i, tags: r[COL_TAGS] || '' })
  })

  console.log(`\n  Read ${rows.length} LCProblems rows.`)
  console.log(`  ${CORRECTIONS.length} corrections queued.\n`)

  const writeRequests = []
  let totalDropped = 0, totalAdded = 0, rowsTouched = 0

  for (const corr of CORRECTIONS) {
    if (ONLY && !ONLY.has(String(corr.id))) continue
    const row = byId.get(String(corr.id))
    if (!row) { console.log(`    LC ${corr.id} not in sheet — skipping`); continue }

    const existing = new Set(row.tags.split(/[;\n]+/).map(s => s.trim()).filter(Boolean))
    const droppedHere = (corr.drop || []).filter(t => existing.has(t))
    const addedHere   = (corr.add  || []).filter(t => !existing.has(t))

    if (!droppedHere.length && !addedHere.length) {
      console.log(`    LC ${String(corr.id).padStart(4)}  (no change needed)`)
      continue
    }

    droppedHere.forEach(t => existing.delete(t))
    addedHere  .forEach(t => existing.add(t))

    rowsTouched++
    totalDropped += droppedHere.length
    totalAdded   += addedHere.length

    console.log(`    LC ${String(corr.id).padStart(4)}  ${corr.why}`)
    droppedHere.forEach(t => console.log(`             − ${t}`))
    addedHere  .forEach(t => console.log(`             + ${t}`))

    writeRequests.push({
      range: `${TAB}!H${row.rowIdx + 2}`,
      values: [[ [...existing].join('; ') ]],
    })
  }

  console.log(`\n  ${rowsTouched} rows would change; ${totalDropped} tags dropped, ${totalAdded} tags added.\n`)

  if (!DO_WRITE) { console.log('  [dry-run] no sheet writes performed.  Pass --write to apply.\n'); return }
  if (!writeRequests.length) { console.log('  Nothing to write.\n'); return }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: 'RAW', data: writeRequests },
  })
  console.log(`  ✓ Patched ${writeRequests.length} rows.\n`)
  console.log(`  Next: node scripts/build-patterns-csv.mjs --write\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
