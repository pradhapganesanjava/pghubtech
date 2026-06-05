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
  // ── Batch 1 (already applied, kept idempotent) ───────────────────────
  17:  ['pat_ds::string::backtrack::permutation'],                  // Letter Combinations Phone
  22:  ['pat_ds::string::backtrack::partition-on-string'],          // Generate Parentheses
  55:  ['pat_ds::array::greedy::running-extreme'],                   // Jump Game
  101: ['pat_ds::tree::dfs::dfs-template'],                          // Symmetric Tree
  114: ['pat_ds::tree::dfs::dfs-tree-orders'],                       // Flatten BT to LL
  128: ['pat_ds::array::hash::seen-set'],                            // Longest Consecutive
  138: ['pat_ds::linked-list::hash::seen-set'],                      // Copy List Random Ptr
  148: ['pat_ds::linked-list::sorting::merge-sort-counting'],        // Sort List
  238: ['pat_ds::array::prefix-sum::ps-1d'],                         // Product Except Self
  581: ['pat_ds::array::stack-topic::monotonic-stack'],              // Shortest Unsorted Subarr
  617: ['pat_ds::tree::dfs::dfs-template'],                          // Merge Two BTs
  763: ['pat_ds::string::greedy::sort-and-sweep'],                   // Partition Labels
  994: ['pat_ds::matrices::bfs::bfs-multi-source'],                  // Rotting Oranges
  200: ['pat_ds::matrices::dfs::dfs-grid-flood'],                    // Number of Islands +grid
  1143:['pat_ds::string::dp::dp-2-strings'],                          // LCS
  309: ['pat_ds::array::dp::state-machine-dp'],                      // Stock Cooldown
  416: ['pat_ds::array::dp::knapsack-01'],                            // Partition Equal Subset
  287: ['pat_ds::array::two-pointers::tp-fast-slow'],                // Find Duplicate
  11:  ['pat_ds::array::two-pointers::tp-converging'],               // Container With Water

  // ── Batch 2 (this turn — Top 100 Liked, ~50 new anchors) ─────────────
  // Linked-list family
  24:  ['pat_ds::linked-list::core::iterative-reverse'],             // Swap Nodes in Pairs
  61:  ['pat_ds::linked-list::two-pointers::tp-fast-slow'],          // Rotate List
  86:  ['pat_ds::linked-list::two-pointers::tp-fast-slow'],          // Partition List
  143: ['pat_ds::linked-list::core::slow-fast-middle'],              // Reorder List
  203: ['pat_ds::linked-list::core::dummy-head-merge'],              // Remove LL Elements
  328: ['pat_ds::linked-list::two-pointers::tp-fast-slow'],          // Odd Even LL

  // Binary tree DFS / BFS
  100: ['pat_ds::tree::dfs::dfs-template'],                          // Same Tree
  111: ['pat_ds::tree::bfs::bfs-level-order'],                       // Min Depth of BT
  116: ['pat_ds::tree::bfs::bfs-level-order'],                       // Populating Next Right Ptr
  117: ['pat_ds::tree::bfs::bfs-level-order'],                       // Populating Next Right Ptr II
  144: ['pat_ds::tree::dfs::dfs-tree-orders'],                       // BT Preorder
  145: ['pat_ds::tree::dfs::dfs-tree-orders'],                       // BT Postorder
  226: ['pat_ds::tree::dfs::dfs-template'],                          // Invert BT
  404: ['pat_ds::tree::dfs::dfs-template'],                          // Sum of Left Leaves
  662: ['pat_ds::tree::bfs::bfs-level-order'],                       // Max Width of BT
  958: ['pat_ds::tree::bfs::bfs-level-order'],                       // Check Completeness BT
  988: ['pat_ds::tree::dfs::dfs-tree-orders'],                       // Smallest String From Leaf
  1110:['pat_ds::tree::dfs::dfs-template'],                          // Delete Nodes Return Forest

  // BST
  99:  ['pat_ds::bst::core::inorder-bst'],                            // Recover BST
  669: ['pat_ds::bst::core::bst-insert-delete'],                      // Trim BST

  // Array search / partition
  4:   ['pat_ds::array::binary-search::bs-on-answer'],                // Median 2 Sorted Arrays
  45:  ['pat_ds::array::greedy::running-extreme'],                   // Jump Game II
  134: ['pat_ds::array::greedy::running-extreme'],                   // Gas Station
  228: ['pat_ds::array::core::in-place-read-write'],                  // Summary Ranges
  229: ['pat_ds::array::hash::freq-counter'],                         // Majority Element II
  349: ['pat_ds::array::hash::seen-set'],                             // Intersection 2 Arrays
  456: ['pat_ds::array::stack-topic::monotonic-stack'],              // 132 Pattern
  540: ['pat_ds::array::binary-search::bs-textbook'],                 // Single Element Sorted Array
  658: ['pat_ds::array::two-pointers::tp-converging'],               // K Closest Elements
  719: ['pat_ds::array::binary-search::bs-on-answer'],                // K-th Smallest Pair Distance
  852: ['pat_ds::array::binary-search::bs-rotated'],                  // Peak Index Mountain
  948: ['pat_ds::array::greedy::sort-and-sweep'],                    // Bag of Tokens
  977: ['pat_ds::array::two-pointers::tp-converging'],               // Squares of Sorted Array

  // Array DP
  77:  ['pat_ds::array::backtrack::subset-combination'],             // Combinations
  118: ['pat_ds::array::dp::dp-1d-linear'],                           // Pascal's Triangle
  119: ['pat_ds::array::dp::dp-1d-linear'],                           // Pascal's Triangle II
  120: ['pat_ds::array::dp::dp-1d-linear'],                           // Triangle (bottom-up)

  // Matrices
  36:  ['pat_ds::matrices::hash::seen-set'],                          // Valid Sudoku
  74:  ['pat_ds::matrices::binary-search::bs-textbook'],              // Search 2D Matrix
  240: ['pat_ds::matrices::binary-search::bs-textbook'],              // Search 2D Matrix II

  // String — sliding window / two-pointers / parsing
  301: ['pat_ds::string::backtrack::partition-on-string'],           // Remove Invalid Parens
  344: ['pat_ds::string::two-pointers::tp-converging'],              // Reverse String
  345: ['pat_ds::string::two-pointers::tp-converging'],              // Reverse Vowels
  424: ['pat_ds::string::sliding-window::sw-shrink-violation'],     // Longest Repeating Char Replacement
  844: ['pat_ds::string::stack-topic::parens-rewrite'],              // Backspace String Compare
  890: ['pat_ds::string::hash::freq-counter'],                       // Find and Replace Pattern
  1004:['pat_ds::array::sliding-window::sw-shrink-violation'],     // Max Consecutive Ones III

  // String — sorting / heap
  767: ['pat_ds::string::heap::top-k'],                               // Reorganize String

  // Graph
  815: ['pat_ds::graph::bfs::bfs-shortest-unweighted'],              // Bus Routes
  841: ['pat_ds::graph::dfs::dfs-template'],                          // Keys and Rooms
  947: ['pat_ds::graph::union-find::uf-with-size'],                   // Most Stones Removed
  721: ['pat_ds::graph::union-find::uf-with-size'],                   // Accounts Merge (UF on emails)

  // Greedy on arrays / intervals
  1024:['pat_ds::array::greedy::sort-and-sweep'],                    // Video Stitching

  // ── Batch 3 (this turn) ──────────────────────────────────────────────
  // First, the 5 problems that motivated NEW sub-micros in the schema.
  // ─────────────────────────────────────────────────────────────────────
  2:   ['pat_ds::linked-list::core::list-digit-arithmetic'],        // Add Two Numbers
  445: ['pat_ds::linked-list::core::list-digit-arithmetic'],        // Add Two Numbers II
  369: ['pat_ds::linked-list::core::list-digit-arithmetic'],        // Plus One Linked List
  28:  ['pat_ds::string::core::string-match-kmp'],                  // Implement strStr
  459: ['pat_ds::string::core::string-match-kmp'],                  // Repeated Substring Pattern
  214: ['pat_ds::string::core::string-match-kmp'],                  // Shortest Palindrome
  686: ['pat_ds::string::core::string-match-kmp'],                  // Repeated String Match
  1392:['pat_ds::string::core::string-match-kmp'],                  // Longest Happy Prefix
  1408:['pat_ds::string::core::string-match-kmp'],                  // String Matching in Array
  146: ['pat_ds::linked-list::core::dll-cache-design'],             // LRU Cache
  460: ['pat_ds::linked-list::core::dll-cache-design'],             // LFU Cache
  432: ['pat_ds::linked-list::core::dll-cache-design'],             // All O`one
  1756:['pat_ds::linked-list::core::dll-cache-design'],             // Design Most Recently Used Queue
  332: ['pat_ds::graph::core::euler-tour'],                          // Reconstruct Itinerary
  753: ['pat_ds::graph::core::euler-tour'],                          // Cracking the Safe
  2097:['pat_ds::graph::core::euler-tour'],                          // Valid Arrangement of Pairs
  4:   ['pat_ds::array::binary-search::bs-partition-2sorted'],      // Median 2 Sorted Arrays

  // ── Batch 3 continued — more Top 100 Liked anchors (existing micros) ─
  // Strings
  71:  ['pat_ds::string::stack-topic::parens-rewrite'],             // Simplify Path
  187: ['pat_ds::string::hash::seen-set'],                          // Repeated DNA Sequences
  241: ['pat_ds::string::backtrack::partition-on-string'],          // Different Ways to Add Parens
  282: ['pat_ds::string::backtrack::partition-on-string'],          // Expression Add Operators
  299: ['pat_ds::string::hash::freq-counter'],                      // Bulls and Cows
  336: ['pat_ds::string::trie-topic::trie-grid-dfs'],               // Palindrome Pairs (trie of reversed)
  392: ['pat_ds::string::two-pointers::tp-merge-walk'],             // Is Subsequence
  395: ['pat_ds::string::sliding-window::sw-at-most-k'],            // Longest Substring K Repeating
  409: ['pat_ds::string::hash::freq-counter'],                      // Longest Palindrome
  415: ['pat_ds::string::two-pointers::tp-converging'],             // Add Strings (both-end carry walk)
  67:  ['pat_ds::string::two-pointers::tp-converging'],             // Add Binary

  // Arrays — search / sort / dp / greedy
  220: ['pat_ds::array::sliding-window::sw-fixed'],                 // Contains Duplicate III
  264: ['pat_ds::array::dp::dp-1d-linear'],                          // Ugly Number II (3-pointer DP)
  274: ['pat_ds::array::sorting::bucket-sort-freq'],                 // H-Index
  275: ['pat_ds::array::binary-search::bs-textbook'],                // H-Index II
  324: ['pat_ds::array::sorting::sort-then-twoptr'],                 // Wiggle Sort II
  334: ['pat_ds::array::greedy::running-extreme'],                  // Increasing Triplet
  350: ['pat_ds::array::hash::freq-counter'],                       // Intersection 2 Arrays II
  354: ['pat_ds::array::dp::dp-1d-linear'],                          // Russian Doll Envelopes
  374: ['pat_ds::array::binary-search::bs-textbook'],                // Guess Number Higher Lower
  413: ['pat_ds::array::dp::dp-1d-linear'],                          // Arithmetic Slices
  436: ['pat_ds::array::binary-search::bs-textbook'],                // Find Right Interval

  // Trees
  222: ['pat_ds::tree::core::post-order-depth'],                    // Count Complete Tree Nodes

  // Graphs
  310: ['pat_ds::graph::core::topo-sort'],                          // Minimum Height Trees

  // Matrices
  174: ['pat_ds::matrices::dp::dp-2d-grid'],                         // Dungeon Game

  // Math/DP
  343: ['pat_ds::array::dp::dp-1d-linear'],                          // Integer Break
  403: ['pat_ds::array::dp::dp-1d-linear'],                          // Frog Jump
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
