#!/usr/bin/env node
/**
 * scripts/build-group-pat.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Curated pat_group:: classification. GROUPS maps each logical group → the LC
 * ids that clearly belong to it (a problem may appear in several groups).
 * Emits scripts/group-pat.json in the { "<id>": ["pat_group::<g>", ...] } shape
 * that apply-pat-json.mjs consumes.
 *
 * Every id is validated against scripts/pat-tagged.json (the 815 already-tagged
 * problems) so we never invent a group tag for an untagged / non-existent row.
 *
 *   node scripts/dump-pat-tagged.mjs     # refresh pat-tagged.json first
 *   node scripts/build-group-pat.mjs     # writes scripts/group-pat.json + stats
 *
 * After review:
 *   node scripts/apply-pat-json.mjs scripts/group-pat.json --write
 *   node scripts/build-patterns-csv.mjs --write
 */
import { readFile, writeFile } from 'fs/promises'
import { dirname, join }       from 'path'
import { fileURLToPath }       from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

// ── Group vocabulary ────────────────────────────────────────────────────────
// The 6 user-specified groups + 3 discovered families (anagram, subsequence,
// scheduling). Each value is the list of LC ids whose CORE is that family —
// incidental keyword hits (e.g. "Sum of Two Integers" = bit-twiddling) are
// deliberately excluded.
const GROUPS = {
  palindrome:     [5, 9, 125, 131, 214, 234, 266, 336, 409, 647, 680, 1216, 1312, 1457, 2002],
  parenthesis:    [20, 22, 32, 241, 301, 921, 1249],
  'buy-sell':     [121, 122, 123, 188, 309, 714],
  'word-process': [30, 79, 126, 127, 139, 140, 151, 186, 211, 212, 243, 244, 245, 290, 291,
                   408, 411, 422, 648, 692, 758, 809, 819, 843, 1255, 1268, 2018],
  expression:     [150, 224, 227, 241, 282, 394, 439, 726, 736, 772, 1106, 10018, 10047],
  sum:            [1, 15, 16, 18, 39, 40, 112, 113, 124, 129, 167, 209, 216, 259, 327, 363,
                   377, 416, 437, 494, 523, 560, 653, 698, 862, 918, 923, 930, 974, 1099,
                   1214, 1679, 2461, 2761, 10014, 10027],
  // ── discovered / proposed (flagged for review) ──
  anagram:        [49, 242, 438, 760],
  // Strict: ordered, NON-contiguous subset on a linear DS (no subarray/substring).
  // LIS family (300/334/376/673/1218/354/646/1048), two-sequence/LCS
  // (115/392/727/792/1143/583), palindromic-subseq (2002/1312), enumerate (491),
  // subset-optimum (2542). #10021 was contiguous → excluded.
  subsequence:    [115, 300, 334, 354, 376, 392, 491, 583, 646, 673, 727, 792, 1048, 1143, 1218, 1312, 1671, 2002, 2542],
  // Optimal subset choice where ORDER doesn't matter (vs subsequence) — pick a
  // subset under a constraint (max/count/partition); backtrack or bitmask-DP.
  // Sub-patterns by solution shape: enumerate include-exclude (78/90),
  // combination-to-target (39/40/216), subset-sum/partition knapsack
  // (416/494/698), bitmask-DP / set-cover (698/1125/1239/1255),
  // optimal-under-constraint sort+heap (2542). Several are multi-group (sum,
  // word-process, subsequence).
  'subset-selection': [39, 40, 78, 90, 216, 416, 494, 698, 1125, 1239, 1255, 2542],
  scheduling:     [207, 210, 252, 253, 621, 1029, 1229, 1235, 1335, 1462, 2127, 2365, 2402],
  // Online / streaming: maintain a running statistic over an unbounded
  // arriving sequence without rescanning (two-heap median, bounded heap,
  // moving window, ordered-interval merge).
  stream:         [295, 346, 352, 480, 703],
  // Partition: split a sequence into contiguous pieces optimizing / satisfying
  // a constraint (minimize the largest piece, count splits, partition by a
  // predicate). Engines: binary-search-on-answer, partition DP.
  partition:      [410, 1011, 1231, 1335],
  // Minimum Change: fewest removals/deletions/changes to make a collection
  // consistent (non-overlapping, all-unique, equalized, valid shape).
  'min-change':   [435, 945, 1647, 1671, 2449],
  // Pattern Matching: match a string/sequence against a pattern or locate a
  // pattern in text — exact (KMP/Z), regex/wildcard (DP or trie), structural
  // pattern<->word isomorphism. (Excludes edit-distance/LCS DP.)
  'pattern-matching': [10, 28, 44, 205, 211, 214, 290, 291, 459, 676, 686, 745, 796, 890, 1023, 1392, 1408],
  // ── moved from Topics → Group By (shortest/longest path, interactive, design, simulation) ──
  'shortest-path':[127, 286, 317, 433, 499, 505, 542, 743, 752, 778, 787, 815, 909, 934, 994, 1091, 1162, 1334, 1368, 1631, 1730, 1765, 2290, 2642, 2812, 10049],
  'longest-path': [124, 329, 543, 687, 1245, 1372, 1522, 1857, 2050, 2127, 10019, 10045],
  interactive:    [1533, 1538],
  design:         [281, 352, 380, 604, 1244, 2336, 2694, 10048, 10057],
  simulation:     [68, 289, 422, 794, 1958, 2303, 10008],
}

// ── Sub-group micro-patterns ────────────────────────────────────────────────
// SUBGROUPS[group][micro] = ids that solve the group via that engine. Emitted
// as `pat_group::<group>::<micro>` (3-level), ADDITIVE to the 2-level
// pat_group::<group> tag above. A problem may appear under several micros when
// it admits more than one engine (e.g. #32 has both a counter and a stack form).
const SUBGROUPS = {
  parenthesis: {
    // integer balance scan over a single-type ()  — counter, no stack
    'balance-counter':    [921, 32],
    // push opens / indices; typed brackets ()[]{} or need positions to erase
    'bracket-stack':      [20, 32, 1249],
    // enumerate the valid solution space via balance-pruned backtracking
    'backtrack-generate': [22],
    // BFS/DFS trying removals, returning ALL minimum-length valid strings
    'search-removal':     [301],
    // divide & conquer: split at operators and recurse (expression shapes)
    'divide-split':       [241],
  },
  stream: {
    // two balanced heaps split at the median (max-heap lower / min-heap upper)
    'two-heap-median':       [295, 480],
    // fixed-size-k heap; its top is the k-th order statistic
    'bounded-heap':          [703],
    // fixed-width window + running aggregate (queue + sum)
    'moving-window':         [346],
    // maintain sorted intervals, merge on insert (ordered map / binary search)
    'ordered-interval-merge': [352],
  },
  partition: {
    // partition a contiguous array into k pieces; binary-search the answer
    // (min-max / max-min objective) + greedy feasibility sweep
    'subarray-binary-search': [410, 1011, 1231],
    // exact k-segment partition DP: dp[p][i] = min over cut of combine(...)
    'partition-dp':           [410, 1335],
  },
  // ── moved from Topics → Group By ──
  'shortest-path': {
    'bfs':                    [127, 286, 317, 433, 542, 752, 815, 909, 994, 1091, 1162, 1730, 1765, 10049],
    'dijkstra':               [499, 505, 743, 778, 787, 1631, 2642, 2812],
    'bellman-ford':           [787],
    'zero-one-bfs':           [934, 1368, 2290],
    'floyd-warshall':         [1334],
  },
  'longest-path': {
    'lp-tree':                [124, 543, 687, 1245, 1372, 1522],
    'lp-grid':                [329],
    'lp-dag':                 [1857, 2050, 2127, 10019, 10045],
  },
  interactive: {
    'interactive-bsearch':    [1533],
    'interactive-deduce':     [1538],
  },
  design: {
    'multi-stream-iterator':  [281],
    'ordered-interval-merge': [352],
    'array-hash-random':      [380],
    'lazy-decode-iterator':   [604],
    'ordered-aggregate':      [1244, 2336],
    'observer-pubsub':        [2694],
    'transaction-stack':      [10048],
    'dependency-graph-system':[10057],
  },
  simulation: {
    'line-format':            [68],
    'grid-simulate':          [289],
    'board-validate':         [422, 794, 1958, 10008],
    'tiered-scan':            [2303],
  },
}

async function main() {
  const tagged = JSON.parse(await readFile(join(__dir, 'pat-tagged.json'), 'utf8'))
  const known  = new Map(tagged.map(p => [String(p.id), p]))

  const out = {}           // id -> [pat_group::x, ...]
  const unknown = []
  for (const [group, ids] of Object.entries(GROUPS)) {
    for (const id of ids) {
      const key = String(id)
      if (!known.has(key)) { unknown.push(`${group}:${key}`); continue }
      ;(out[key] = out[key] || []).push(`pat_group::${group}`)
    }
  }

  // Sub-group micro tags (3-level), additive to the 2-level group tag.
  for (const [group, micros] of Object.entries(SUBGROUPS)) {
    for (const [micro, ids] of Object.entries(micros)) {
      for (const id of ids) {
        const key = String(id)
        if (!known.has(key)) { unknown.push(`${group}::${micro}:${key}`); continue }
        ;(out[key] = out[key] || []).push(`pat_group::${group}::${micro}`)
      }
    }
  }

  // Print a per-group summary with titles so the JSON is easy to eyeball.
  console.log('')
  for (const [group, ids] of Object.entries(GROUPS)) {
    console.log(`### pat_group::${group}  (${ids.length})`)
    for (const id of ids) {
      const p = known.get(String(id))
      console.log(`   ${String(id).padStart(5)}  ${p ? p.title : '⚠️ NOT IN pat-tagged.json'}`)
    }
    console.log('')
  }
  if (unknown.length) console.log(`⚠️  ${unknown.length} ids not found in pat-tagged.json: ${unknown.join(', ')}\n`)

  const multi = Object.entries(out).filter(([, g]) => g.length > 1)
  console.log(`Problems tagged: ${Object.keys(out).length}   (${multi.length} in >1 group)`)
  multi.forEach(([id, g]) => console.log(`   ${id.padStart(5)}  ${g.join(', ')}`))

  await writeFile(join(__dir, 'group-pat.json'), JSON.stringify(out, null, 2) + '\n')
  console.log(`\n  ✓ Wrote scripts/group-pat.json  (${Object.keys(out).length} ids)\n`)
}
main().catch(e => { console.error(e.message); process.exit(1) })
