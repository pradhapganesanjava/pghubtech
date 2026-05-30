#!/usr/bin/env node
/**
 * scripts/seed-lists.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Seed curated MyLists (Blind 75, LeetCode 75, Top Interview 150) into the
 * LCLists sheet tab. Each problem is specified by its LeetCode NUMBER; the
 * script resolves number → real slug from the LCProblems tab (ground truth),
 * so a typo'd number that doesn't exist is reported rather than silently wrong.
 *
 * Idempotent: existing (list, slug) memberships are skipped.
 *
 *   node scripts/seed-lists.mjs            # dry-run (prints coverage)
 *   node scripts/seed-lists.mjs --write    # commit to LCLists
 *   node scripts/seed-lists.mjs --write --only "Blind 75"
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
const ONLY       = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1] : null })()
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']

const TAB_PROBLEMS = 'LCProblems'
const TAB_LISTS    = 'LCLists'

// ── Curated lists, by LeetCode problem number ────────────────────────────────
const LISTS = {
  'Blind 75': [
    1,121,217,238,53,152,153,33,15,11,
    371,191,338,268,190,
    70,322,300,1143,139,39,198,213,91,62,55,
    133,207,417,200,128,269,261,323,
    57,56,435,252,253,
    206,141,21,23,19,143,
    73,54,48,79,
    3,424,76,242,49,20,125,5,647,271,
    104,100,226,124,102,297,572,105,98,230,235,208,211,212,
    347,295,
  ],
  'LeetCode 75': [
    1768,1071,1431,605,345,151,238,334,443,
    283,392,11,1679,
    643,1456,1004,1493,
    1732,724,2215,1207,1657,2352,
    2390,735,394,
    933,649,
    2095,328,206,2130,
    104,872,1448,437,1372,236,199,1161,
    700,450,
    841,547,1466,399,1926,994,
    215,2336,2542,2462,
    374,2300,162,875,
    17,216,
    1137,746,198,790,
    62,1143,714,72,
    338,136,1318,
    208,1268,
    435,452,
    739,901,
  ],
  // Snowflake-focused interview prep (curated 2026-05-29 from observed
  // Snowflake screens + LC discuss posts). Topics: intervals, greedy,
  // graphs/topo sort, DP, arrays/math/bit, strings, trees, 2D prefix sums.
  'Snowflake': [
    56, 57, 435, 1851,                  // Intervals
    729, 1353, 1751,                    //   + My Calendar I, Max Events I/II
    330, 1235, 621, 2439,               // Greedy
    55,                                 //   + Jump Game
    207, 210, 261, 323,                 // Graphs & Topo
    785, 1494,                          //   + Is Graph Bipartite, Parallel Courses II
    1143, 1639, 2002,                   // DP
    5, 95, 139,                         //   + Longest Palindromic Substring, Unique BSTs II, Word Break
    1643,                               // Arrays/Math/Bit (2439 above)
    136, 2449,                          //   + Single Number, Min Ops to Make Arrays Similar
    3, 2062,                            // Strings
    271, 917, 2303,                     //   + Encode/Decode Strings, Reverse Only Letters, Taxes
    94,                                 // Trees
    572, 872, 2096,                     //   + Subtree of Another Tree, Leaf-Similar Trees, Step-By-Step Directions
    236, 559, 1110, 1644, 1650,         //   + LCA Binary Tree, Max Depth N-ary, Delete Nodes Forest, LCA II, LCA III
    304,                                // Matrix (2D prefix sums)
    146, 155, 295, 588, 981,            // Design: LRU Cache, Min Stack, Median Stream, In-Memory FS, Time-Based KV Store
    23,                                 // Heap: Merge k Sorted Lists
    410, 875, 1011, 1898, 2141, 2517,   // Binary search on answer (Job Execution pattern; 2141 is closest analog)
    542, 2858,                          // Multi-source BFS / tree propagation (Thread Count pattern)
    589,                                // N-ary Pre-order Traversal (Active Order traversal pattern)
    821, 849, 1769,                     // 1D nearest-of-type two-pass scan (Eat Cake pattern)
    802, 851, 1462, 1857, 2192,         // DAG topo-sort + per-node propagation (Privilege Resolution pattern; 2192 is direct match)
    126, 127, 433, 752,                 // BFS shortest path in implicit graph (Wiki Bot pattern; 127 is direct match)
    10000, 10001, 10002, 10003, 10004, 10005,  // Custom: Job Execution, Thread Count, Active Order, Eat Cake, Privilege Resolution, Wiki Bot
    // ── Prachub Snowflake batch (added 2026-05-29) ──
    1091, 340, 20, 794, 224, 470, 545, 622, 2694, 1242,  // LC analogs from Group A (premium ones may be missing)
    10006, 10007, 10008, 10009, 10010,  // Tree-delete-height, valid tic-tac-toe ext, coin overpay, max one query
    10011, 10012, 10013, 10014, 10015,  // Doc predicate, retake schedule, sched+tree path, subtree-sum map, trie serde
    10016, 10017, 10018, 10019, 10020,  // 2D nearest, 4 OA, expr eval, total time courses, hier paths
    10021, 10022, 10023, 10024, 10025,  // Recipe subseq, error detect, txn KV, rate limiter, layered services
    10026, 10027, 10028, 10029,         // DFS+topo, 3Sum scale, cost-sensitive cls, RNG derivations
    10030, 10031, 10032, 10033, 10034,  // Cron sched, disk KV, REST abstraction, ACL service, dedup object store
    10035, 10036, 10037, 10038, 10039, 10040,  // Quota, distributed tree count, DAG cache, multi-core sched, resilient auth, distributed e2e
  ],
  'Top Interview 150': [
    88,27,26,80,169,189,121,122,55,45,274,380,238,134,135,42,13,12,58,14,151,6,28,68,
    125,392,167,11,15,
    209,3,30,76,
    36,54,48,73,289,
    383,205,290,242,49,1,202,219,128,
    228,56,57,452,
    20,71,155,150,224,
    141,2,21,138,92,25,19,82,61,86,146,
    104,100,226,101,105,106,117,114,112,129,124,173,222,236,
    199,637,102,103,
    530,230,98,
    200,130,133,399,207,210,
    909,433,127,
    208,211,212,
    17,77,46,39,52,22,79,
    108,148,427,23,
    53,918,
    35,74,162,33,34,153,4,
    215,502,373,295,
    67,190,191,136,137,201,
    9,66,172,69,50,149,
    70,198,139,322,300,
    120,64,63,5,97,72,123,188,221,
  ],
}

// ── env + auth (mirrors ads-to-sheets.mjs) ───────────────────────────────────
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

async function ensureListsTab(sheets, sheetId) {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties.title' })
  const titles = (data.sheets ?? []).map(s => s.properties?.title)
  if (!titles.includes(TAB_LISTS)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: [{ addSheet: { properties: { title: TAB_LISTS } } }] } })
    await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `${TAB_LISTS}!A1`, valueInputOption: 'RAW', requestBody: { values: [['list_name', 'slug', 'added_at']] } })
    console.log(`  Created "${TAB_LISTS}" tab.`)
  }
}

async function main() {
  console.log('\n' + '═'.repeat(60))
  console.log(`  Seed curated MyLists  [${DO_WRITE ? 'WRITE' : 'DRY-RUN'}]`)
  console.log('═'.repeat(60))
  const { sheetId } = await loadEnv()
  const auth = await authorize()
  const sheets = google.sheets({ version: 'v4', auth })

  // frontendId → slug from LCProblems (col B = frontend_id, col A = slug).
  const { data: pdata } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB_PROBLEMS}!A2:B` })
  const byNum = new Map()
  for (const r of (pdata.values ?? [])) { const slug = (r[0] ?? '').trim(); const num = parseInt(r[1] ?? '', 10); if (slug && !isNaN(num)) byNum.set(num, slug) }
  console.log(`\nLCProblems rows: ${byNum.size}`)
  if (byNum.size === 0) { console.error('✗ LCProblems empty — run ads-to-sheets.mjs first.'); process.exit(1) }

  if (DO_WRITE) await ensureListsTab(sheets, sheetId)

  // Existing memberships to dedupe.
  const existing = new Set()
  try {
    const { data: ldata } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB_LISTS}!A2:B` })
    for (const r of (ldata.values ?? [])) existing.add(`${(r[0] ?? '').trim()}||${(r[1] ?? '').trim()}`)
  } catch { /* tab not created yet */ }

  const now = new Date().toISOString()
  const rows = []
  for (const [name, nums] of Object.entries(LISTS)) {
    if (ONLY && name !== ONLY) continue
    const missing = []
    let matched = 0, added = 0, dup = 0
    for (const num of nums) {
      const slug = byNum.get(num)
      if (!slug) { missing.push(num); continue }
      matched++
      if (existing.has(`${name}||${slug}`)) { dup++; continue }
      rows.push([name, slug, now]); added++
    }
    console.log(`\n── ${name} ──  requested ${nums.length} · matched ${matched} · new ${added} · already ${dup}`)
    if (missing.length) console.log(`   not in archive (premium/unknown #): ${missing.join(', ')}`)
  }

  if (!DO_WRITE) { console.log(`\n[dry-run] would add ${rows.length} memberships. Pass --write to commit.\n`); return }
  if (rows.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId, range: `${TAB_LISTS}!A:C`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows },
    })
  }
  console.log(`\n✓ Added ${rows.length} memberships to ${TAB_LISTS}.\n`)
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1) })
