#!/usr/bin/env node
/**
 * scripts/add-snowflake-prachub-batch.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Bulk-append the Snowflake prachub Group B (algorithmic) + Group C (system
 * design) questions as custom AdsHub problems (#10006–#10040).
 *
 * Each row carries the prachub URL in the leetcode_url field as the canonical
 * source so the user can click through for the full problem text + community
 * discussion. Description is the AI-enhanced summary from prachub's list view.
 *
 *   node scripts/add-snowflake-prachub-batch.mjs           # dry-run
 *   node scripts/add-snowflake-prachub-batch.mjs --write
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

// ── Problems to add ────────────────────────────────────────────────────────
// Each: id, slug (custom-<prachub-slug>), title, difficulty, topics, tags,
// prachub URL (stored in leetcode_url for reference), short summary.
// Pattern: closest LC analog noted in tags + summary.
const PRACHUB = 'https://prachub.com'
const CK = (s) => `${PRACHUB}/coding-questions/${s}`
const IK = (s) => `${PRACHUB}/interview-questions/${s}`

const PROBLEMS = [
  // ── Group B: Algorithmic ──────────────────────────────────────────────────
  { id: 10006, slug: 'compute-height-of-tree-with-deleted-nodes-minimize-deletions',
    title: 'Compute height of tree with deleted nodes; minimize deletions',
    difficulty: 'Hard', topics: ['Tree', 'Depth-First Search', 'Greedy', 'Dynamic Programming'],
    tags: ['_ds::tree::n-ary', '_prob::tree::skip-deleted', '_prob::tree::min-deletions-bounded-height'],
    url: IK('compute-height-of-tree-with-deleted-nodes-minimize-deletions'),
    summary: 'Rooted (non-binary) tree where some nodes are marked deleted. (a) Effective height when ignoring deleted nodes. (b) Follow-up: minimum number of additional deletions so effective height ≤ K. Patterns: LC 1110 (delete-and-promote), LC 559 (n-ary depth).' },

  { id: 10007, slug: 'compute-height-after-deletions-enumerate-valid-delete-sets',
    title: 'Compute height after deletions; enumerate valid delete sets',
    difficulty: 'Hard', topics: ['Tree', 'Depth-First Search', 'Backtracking'],
    tags: ['_ds::tree::n-ary', '_prob::tree::skip-deleted', '_prob::backtracking::valid-sets'],
    url: IK('compute-height-after-deletions-enumerate-valid-delete-sets'),
    summary: 'Variant of #10006 — height under deletions plus enumerating all valid delete-sets satisfying some property (e.g. exactly K). Tree DP + backtracking.' },

  { id: 10008, slug: 'validate-an-extended-tic-tac-toe-state',
    title: 'Validate an extended tic-tac-toe state',
    difficulty: 'Medium', topics: ['Array', 'Matrix', 'Simulation'],
    tags: ['_prob::game::valid-state', '_ds::matrix'],
    url: CK('validate-an-extended-tic-tac-toe-state'),
    summary: 'Extension of LC 794: given a 3×3 board, decide whether the state is reachable in a valid tic-tac-toe game (count parity + early-win detection). Follow-up: extend to larger boards.' },

  { id: 10009, slug: 'minimize-coins-with-overpay-and-change',
    title: 'Minimize coins with overpay and change',
    difficulty: 'Hard', topics: ['Dynamic Programming', 'BFS', 'Greedy', 'Math'],
    tags: ['_prob::coin-change::with-change-back', '_prob::dp::unbounded-knapsack'],
    url: CK('minimize-coins-with-overpay-and-change'),
    summary: 'Coins {1, 5, 10, 50, 100, 200}. Pay exactly n; you may overpay and receive exact change. Return the minimum TOTAL coins exchanged. Twist on LC 322: BFS / DP on signed payment-minus-change.' },

  { id: 10010, slug: 'maximize-revenue-by-choosing-one-query-type',
    title: 'Maximize revenue by choosing one query type',
    difficulty: 'Hard', topics: ['Array', 'Math', 'Greedy'],
    tags: ['_prob::greedy::unit-time-rate', '_prob::array::single-pick'],
    url: CK('maximize-revenue-by-choosing-one-query-type'),
    summary: 'Snowflake virtual warehouse: n query types each with (time, profit). You run one type repeatedly for at most k minutes. Maximize total profit, return (max_profit, chosen_type). Greedy: pick max ⌊k/time⌋ * profit.' },

  { id: 10011, slug: 'implement-document-predicate-apis',
    title: 'Implement document predicate APIs',
    difficulty: 'Medium', topics: ['Design', 'Hash Table', 'String', 'Stack'],
    tags: ['_prob::design::doc-store', '_prob::boolean-expr::eval', '_prob::parser::shunting-yard'],
    url: CK('implement-document-predicate-apis'),
    summary: 'Design a doc store with InsertDoc(filename, content) and CheckContains(filename, predicate) where predicate is a boolean expression like "a && b || c" over keywords. Tokenize + parse + evaluate against a per-doc keyword set.' },

  { id: 10012, slug: 'schedule-prerequisite-classes-with-retakes',
    title: 'Schedule prerequisite classes with retakes',
    difficulty: 'Easy', topics: ['Graph', 'Topological Sort', 'BFS'],
    tags: ['_prob::graph::topo-sort', '_prob::topo::with-retakes'],
    url: CK('schedule-prerequisite-classes-with-retakes'),
    summary: 'Each course has a prevCoursesList. Given roots (target courses), return courses you need to pass and a valid order accounting for retake semantics. LC 210 with extra wrinkles.' },

  { id: 10013, slug: 'solve-scheduling-and-tree-path-problems',
    title: 'Solve scheduling and tree path problems',
    difficulty: 'Hard', topics: ['Greedy', 'Dynamic Programming', 'Tree', 'Sorting'],
    tags: ['_prob::interval::max-k-non-overlap', '_prob::tree::path-encoding'],
    url: CK('solve-scheduling-and-tree-path-problems'),
    summary: '(1) n courses with (start, end, credit) and at most K non-overlapping — max total credit. (2) Tree path between two nodes encoded as up/left/right moves.' },

  { id: 10014, slug: 'set-second-tree-values-by-subtree-sums',
    title: 'Set second tree values by subtree sums (T2 ← sum of T1 subtree)',
    difficulty: 'Medium', topics: ['Tree', 'Depth-First Search', 'Recursion'],
    tags: ['_ds::tree::binary', '_prob::tree::dfs-subtree-sum', '_prob::tree::two-tree-mapping'],
    url: CK('set-second-tree-values-by-subtree-sums'),
    summary: 'Two complete binary trees with identical shape. For each position, set T2.val = sum of T1.subtree (at that position). Linear-time DFS. Same as: transform-tree-using-counterpart-subtree-sums, transform-tree-with-subtree-sum-mapping.' },

  { id: 10015, slug: 'serialize-and-deserialize-a-dictionary-trie',
    title: 'Serialize and deserialize a dictionary trie',
    difficulty: 'Medium', topics: ['Trie', 'Design', 'String'],
    tags: ['_ds::trie', '_prob::serialize::tree', '_prob::design::wire-format'],
    url: CK('serialize-and-deserialize-a-dictionary-trie'),
    summary: 'Design a compact wire format for a trie of lowercase English words (end-of-word markers, shared prefixes, branching). serialize(root) → bytes/string; deserialize(data) → root. Discuss forward/backward compatibility, streaming.' },

  { id: 10016, slug: 'solve-three-coding-rounds',
    title: 'Solve three coding rounds (2D nearest cake/person + follow-ups)',
    difficulty: 'Medium', topics: ['Matrix', 'BFS', 'Heap (Priority Queue)'],
    tags: ['_prob::matrix::nearest-of-type', '_prob::bfs::multi-source-2d'],
    url: CK('solve-three-coding-rounds'),
    summary: '(1) m×n grid with 1=cake, 0=person — min distance between any cake and person. (2) Each person picks closest cake; given person index, return their cake. (3) Variant scenarios. 2D extension of #10003 Eat Cake (LC 542).' },

  { id: 10017, slug: 'solve-four-oa-algorithm-problems',
    title: 'Solve four OA algorithm problems',
    difficulty: 'Hard', topics: ['Array', 'String', 'Two Pointers', 'Matrix'],
    tags: ['_prob::oa::mixed', '_prob::palindrome::swap'],
    url: CK('solve-four-oa-algorithm-problems'),
    summary: 'Four mixed OA problems: count axis-aligned square subgrids in R×C grid; min swaps for I/O palindrome; n×m grid walk with obstacles; +one more. CodeSignal-style.' },

  { id: 10018, slug: 'evaluate-arithmetic-expression-with-variables',
    title: 'Evaluate arithmetic expression with variables',
    difficulty: 'Medium', topics: ['String', 'Stack', 'Parser'],
    tags: ['_prob::expression-eval', '_prob::parser::shunting-yard'],
    url: CK('evaluate-arithmetic-expression-with-variables'),
    summary: 'Expression with non-negative ints, alphabetic variables, +-*/, parens, spaces. Given a dict of variable values, compute the 64-bit result with standard precedence. LC 224/227 + variables.' },

  { id: 10019, slug: 'compute-total-time-to-finish-all-courses',
    title: 'Compute total time to finish all courses (per-task duration)',
    difficulty: 'Medium', topics: ['Graph', 'Topological Sort', 'BFS'],
    tags: ['_prob::graph::topo-sort', '_prob::topo::critical-path'],
    url: CK('compute-total-time-to-finish-all-courses'),
    summary: 'n courses with prereqs and per-course time. Courses run in batches (one batch per level); total time = sum of max-time-per-level. Layered topo + per-batch max. LC 210 + critical path.' },

  { id: 10020, slug: 'filter-hierarchical-paths-after-deletions',
    title: 'Filter hierarchical paths after deletions',
    difficulty: 'Medium', topics: ['Trie', 'String', 'Tree'],
    tags: ['_ds::trie', '_prob::path::delete-and-children'],
    url: CK('filter-hierarchical-paths-after-deletions'),
    summary: 'Input: slash-delimited paths (e.g. "California/San Francisco/7th Street") and a list of paths to delete. Remove every path equal to OR descendant of any delete-path. Trie + DFS-prune.' },

  { id: 10021, slug: 'check-if-each-recipe-is-a-contiguous-subsequence',
    title: 'Check if each recipe is a contiguous subsequence',
    difficulty: 'Hard', topics: ['Array', 'String', 'Two Pointers', 'Hash Table'],
    tags: ['_prob::array::contiguous-subseq', '_prob::sliding-window'],
    url: CK('check-if-each-recipe-is-a-contiguous-subsequence'),
    summary: 'Ordered ingredients[]. For each recipe (list of ingredients), determine if it can be formed by a contiguous run of ingredients. Position-index lookup + sequential check.' },

  { id: 10022, slug: 'design-error-detection-and-propagation-algorithms',
    title: 'Design error detection and propagation algorithms (logs + graph)',
    difficulty: 'Medium', topics: ['Binary Search', 'BFS', 'Graph'],
    tags: ['_prob::binary-search::first-occurrence', '_prob::graph::failure-propagation'],
    url: CK('design-error-detection-and-propagation-algorithms'),
    summary: '(A) Ordered logs of [Info]/[Warn]/[Error] — once first Error appears, all later are Error; preceded by Warn. Binary-search left bound. (B) Propagate failures through a graph of services. See sibling: find-first-error-and-propagate-failures.' },

  { id: 10023, slug: 'design-transactional-in-memory-key-value-store',
    title: 'Design transactional in-memory key-value store',
    difficulty: 'Hard', topics: ['Design', 'Hash Table', 'Stack', 'Concurrency'],
    tags: ['_prob::design::kv-store', '_prob::txn::begin-commit-rollback', '_prob::concurrency::mvcc'],
    url: CK('design-transactional-in-memory-key-value-store'),
    summary: 'In-memory KV with get/put/delete + begin/commit/rollback. Follow-ups: O(1) per op; multi-threaded support. Stack of dirty deltas; commit merges to base; rollback discards top.' },

  { id: 10024, slug: 'implement-course-scheduling-and-rate-limiter-analysis',
    title: 'Implement course scheduling and rate-limiter analysis',
    difficulty: 'Hard', topics: ['Graph', 'Topological Sort', 'Design', 'Sliding Window'],
    tags: ['_prob::topo-sort', '_prob::rate-limiter::sliding-window'],
    url: CK('implement-course-scheduling-and-rate-limiter-analysis'),
    summary: 'Round 1: LC 210 with a DP follow-up. Round 2: design a per-key rate limiter (sliding-window log / token bucket); analyze QPS + burst behavior. Common Snowflake combo.' },

  { id: 10025, slug: 'schedule-dependent-services-with-layered-startup',
    title: 'Schedule dependent services with layered startup',
    difficulty: 'Medium', topics: ['Graph', 'Topological Sort', 'BFS'],
    tags: ['_prob::topo::layered', '_prob::topo::cycle-detect'],
    url: CK('schedule-dependent-services-with-layered-startup'),
    summary: 'N services with (u → v) deps. (1) Valid startup order or detect cycle. (2) Layered output: in-degree-0 first, then next layer. (3) Given a service, return its full dependency closure.' },

  { id: 10026, slug: 'implement-dfs-with-cycle-detection-and-topo-order',
    title: 'Implement DFS (recursive + iterative) with cycle detection and topo order',
    difficulty: 'Hard', topics: ['Graph', 'Depth-First Search', 'Stack'],
    tags: ['_prob::dfs::recursive-vs-iterative', '_prob::graph::cycle-detect'],
    url: CK('implement-dfs-with-cycle-detection-and-topo-order'),
    summary: 'Directed graph: implement DFS both recursively and iteratively (own stack). Both must return topo order if DAG, else detect cycle. Compute discover/finish times.' },

  { id: 10027, slug: 'solve-and-optimize-3sum-and-variants-at-scale',
    title: 'Solve and optimize 3Sum and variants at scale',
    difficulty: 'Medium', topics: ['Array', 'Two Pointers', 'Sorting', 'Hash Table'],
    tags: ['_prob::array::triplet-sum', '_prob::dedup::sorted-scan'],
    url: CK('solve-and-optimize-3sum-and-variants-at-scale'),
    summary: 'LC 15 + scale: n ≤ 200k, values in [-1e9, 1e9]. Sort + two-pointer; rigorous dedup; analyze complexity vs hash-set variant. Follow-up: 4Sum / kSum generalization.' },

  { id: 10028, slug: 'design-and-validate-a-cost-sensitive-classifier',
    title: 'Design and validate a cost-sensitive classifier',
    difficulty: 'Hard', topics: ['Machine Learning', 'Statistics', 'Design'],
    tags: ['_prob::ml::imbalanced', '_prob::ml::delayed-labels', '_prob::ml::cost-matrix'],
    url: IK('design-and-validate-a-cost-sensitive-classifier'),
    summary: 'Real-time binary purchase classifier. Positives ≈ 3%, label delay ≤ 10 days. TP = +$2 margin, FP = -$0.x cost. Design: features, threshold, validation, monitoring under label delay.' },

  { id: 10029, slug: 'derive-uniform-rngs-from-limited-or-biased-sources',
    title: 'Derive uniform RNGs from limited or biased sources',
    difficulty: 'Hard', topics: ['Math', 'Probability', 'Randomized', 'Rejection Sampling'],
    tags: ['_prob::rng::rand7-from-rand5', '_prob::rejection-sampling', '_prob::von-neumann-extractor'],
    url: IK('derive-uniform-rngs-from-limited-or-biased-sources'),
    summary: '(A) rand7() from rand5() — unbiased + near-optimal expected calls. (B) general randN() from randM(). (C) Fairness from a biased coin (von Neumann extractor). LC 470 + generalizations.' },

  // ── Group C: System Design ────────────────────────────────────────────────
  { id: 10030, slug: 'design-a-cron-job-scheduler',
    title: 'Design a cron job scheduler',
    difficulty: 'Medium', topics: ['System Design', 'Scheduling', 'Distributed Systems'],
    tags: ['_design::scheduler', '_design::cron', '_design::pause-resume'],
    url: IK('design-a-cron-job-scheduler'),
    summary: 'Job scheduler with effectively unlimited workers. Recurring cron jobs; pause(job) (stop scheduling new, let running finish); resume(job); cancel. Discuss persistence, leader election, missed-fire policy.' },

  { id: 10031, slug: 'design-a-disk-backed-kv-store-under-contention',
    title: 'Design a disk-backed KV store under contention',
    difficulty: 'Hard', topics: ['System Design', 'Storage', 'Concurrency'],
    tags: ['_design::kv-store', '_design::disk-backed', '_design::high-contention'],
    url: IK('design-a-disk-backed-kv-store-under-contention'),
    summary: 'KV store with very-large values stored primarily on disk. Focus: high contention (many concurrent readers/writers, hot keys). Discuss LSM vs B-tree, locks/MVCC, page cache, write buffering.' },

  { id: 10032, slug: 'design-a-rest-api-abstraction-layer',
    title: 'Design a REST API abstraction layer',
    difficulty: 'Hard', topics: ['System Design', 'API', 'Code Generation'],
    tags: ['_design::api-gateway', '_design::sdk-codegen', '_design::retry-policy'],
    url: IK('design-a-rest-api-abstraction-layer'),
    summary: 'Boilerplate everywhere: callers repeat request construction, headers, auth, retries, error mapping. Design a shared SDK / codegen layer. Discuss schema definition (OpenAPI/proto), retry/backoff, circuit breakers, observability.' },

  { id: 10033, slug: 'design-an-acl-authorization-checking-service',
    title: 'Design an ACL authorization checking service',
    difficulty: 'Hard', topics: ['System Design', 'Authorization', 'Caching'],
    tags: ['_design::authz', '_design::acl', '_design::rbac-abac'],
    url: IK('design-an-acl-authorization-checking-service'),
    summary: 'Central authorization service: decide if a principal can perform an action on a resource. Cover RBAC vs ABAC, latency budget, cache invalidation on policy change, audit log, fail-open vs fail-closed.' },

  { id: 10034, slug: 'design-an-object-store-with-deduplication',
    title: 'Design an object store with deduplication',
    difficulty: 'Medium', topics: ['System Design', 'Storage', 'Hashing'],
    tags: ['_design::object-store', '_design::dedup::content-hash'],
    url: IK('design-an-object-store-with-deduplication'),
    summary: 'S3-like service. Focus: reduce cost by avoiding storing duplicate files. Content-addressable storage (hash → blob), reference counting, GC, ranged reads, hash collisions.' },

  { id: 10035, slug: 'design-a-multi-tenant-quota-system',
    title: 'Design a multi-tenant quota system',
    difficulty: 'Hard', topics: ['System Design', 'Distributed Systems', 'Consensus'],
    tags: ['_design::quota', '_design::no-overdraft', '_design::multi-tenant'],
    url: IK('design-a-multi-tenant-quota-system'),
    summary: 'Global per-user quota shared across upstream products (e.g. Drive + Photos sharing 100 GB). Consume / release / query. Must never overdraft; M+ DAU and QPS; high consistency. Discuss reservation tokens, leader-led counter, lease scheme.' },

  { id: 10036, slug: 'design-a-distributed-tree-node-counter',
    title: 'Design a distributed tree node counter',
    difficulty: 'Medium', topics: ['System Design', 'Distributed Systems', 'Tree'],
    tags: ['_design::distributed-tree', '_prob::message-passing::request-reply'],
    url: IK('design-a-distributed-tree-node-counter'),
    summary: 'N-ary tree where each node runs on a separate machine. Implement Node.call(from, message) so any node can initiate a count and eventually get the total. Two message types: request count + reply count. Critical section: aggregate before reply.' },

  { id: 10037, slug: 'design-cache-for-dag-based-query-views',
    title: 'Design cache for DAG-based query views',
    difficulty: 'Hard', topics: ['System Design', 'Caching', 'Database'],
    tags: ['_design::materialized-view', '_design::cache-invalidation', '_ds::dag'],
    url: IK('design-cache-for-dag-based-query-views'),
    summary: 'Materialized query views form a DAG of dependencies. Design caching to reduce latency while keeping correctness on writes. Granularity (base/partial/whole), placement (memory/disk/distributed), invalidation cascade.' },

  { id: 10038, slug: 'design-multi-core-service-startup-scheduler',
    title: 'Design multi-core service startup scheduler',
    difficulty: 'Hard', topics: ['System Design', 'Scheduling', 'Concurrency'],
    tags: ['_design::scheduler', '_prob::dag::parallel-execution', '_design::dependency-startup'],
    url: IK('design-multi-core-service-startup-scheduler'),
    summary: 'DAG of services on a host with M CPU cores; each service has startup time. Minimize total startup time respecting deps. Detect ready services, prioritize critical path, bound concurrency to M, handle failures.' },

  { id: 10039, slug: 'design-resilient-auth-with-flaky-third-party-tokens',
    title: 'Design resilient auth with flaky third-party tokens',
    difficulty: 'Hard', topics: ['System Design', 'Security', 'Resilience'],
    tags: ['_design::auth-flow', '_design::token-cache', '_design::circuit-breaker'],
    url: IK('design-resilient-auth-with-flaky-third-party-tokens'),
    summary: 'Multi-region API requiring a 3rd-party auth token before calling main API. 3rd party is intermittent / malformed. Design token cache, refresh, retry/backoff, circuit breaker, graceful degradation.' },

  { id: 10040, slug: 'design-a-distributed-system-end-to-end',
    title: 'Design a distributed system end-to-end (multi-tenant analytics platform)',
    difficulty: 'Hard', topics: ['System Design', 'Distributed Systems', 'SQL'],
    tags: ['_design::analytics-platform', '_design::sharding', '_design::multi-tenant'],
    url: IK('design-a-distributed-system-end-to-end'),
    summary: 'Multi-tenant analytics platform: ingest batch files into object storage, query via SQL with interactive latencies, elastic compute. Cover assumptions/SLAs, data model, sharding/replication, consistency, isolation, monitoring. Consolidated with design-under-vague-distributed-requirements.' },
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
  <p><em>Snowflake interview question — original source: <a href="${p.url}">${p.url}</a></em></p>
  <p>${p.summary}</p>
</div>`
}

function toRow(p) {
  return [
    `custom-${p.slug}`,           // slug
    String(p.id),                  // frontend_id
    p.title,                       // title
    p.difficulty,                  // difficulty
    p.topics.join('; '),           // topics
    'Snowflake',                   // companies
    '',                            // companies_recent
    p.tags.join('; '),             // tags
    p.url,                         // leetcode_url (repurposed: prachub URL)
    buildDescription(p),           // description_html
    '',                            // notes_drive_id
    '',                            // has_notes
  ]
}

async function main() {
  console.log('\n' + '═'.repeat(60))
  console.log(`  Bulk-add Snowflake prachub problems  [${DO_WRITE ? 'WRITE' : 'DRY-RUN'}]`)
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
    if (slugs.has(slug))             { skipped.push(`${p.id} (slug exists)`); continue }
    if (ids.has(String(p.id)))       { skipped.push(`${p.id} (id taken)`); continue }
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
