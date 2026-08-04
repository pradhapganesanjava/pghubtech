#!/usr/bin/env node
/**
 * scripts/add-closest-lc-batch.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Surface each custom (#10000+) problem's CLOSEST LeetCode equivalent as a
 * chip at the top of its description (LCProblems col J), the way #10068 does.
 *
 *   node scripts/add-closest-lc-batch.mjs            # dry-run
 *   node scripts/add-closest-lc-batch.mjs --write
 *   node scripts/add-closest-lc-batch.mjs --only 10049,10050
 *
 * Where the picks come from:
 *   • Most rows already had a curated "Refer — related LeetCode problems" list
 *     at the end of their Drive note; the FIRST entry is the closest match and
 *     is simply lifted here. Those are marked src:'note'.
 *   • Rows with no note and no reference got a pick authored from the problem
 *     statement — marked src:'authored'.
 *
 * The LC title and URL slug are resolved from the LCProblems sheet itself
 * (by frontend_id), never hand-typed, so a bad number fails loudly here
 * instead of shipping a 404 into the description.
 *
 * Idempotent: any row whose description already contains a `desc-eq-chip` is
 * skipped, so re-running is safe.
 *
 * Deliberately NOT covered — the note's top pick looked wrong and these want a
 * human call (see the review that produced this file):
 *   10006  note ranks #104 (binary) but the tree is n-ary (#559); part 2
 *          (min deletions to bound height) has no LC equivalent at all.
 *   10052  note ranks #1110 (delete → return forest) but the question asks for
 *          the HEIGHT of what remains. Neither #1110 nor #2049 is exact.
 *   10056  note ranks #322 Coin Change, which MINIMISES; this maximises
 *          revenue under a budget. #1449 is the max-value unbounded twin.
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
const ARGS       = process.argv.slice(2)
const DO_WRITE   = ARGS.includes('--write')
const ONLY       = (() => { const i = ARGS.indexOf('--only'); return i >= 0 ? new Set(ARGS[i + 1].split(',').map(Number)) : null })()
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
const TAB = 'LCProblems'

// tier: 'exact' → green chip (near-identical task)
//       'loose' → amber chip (same pattern, looser fit)
const PICKS = [
  // ── lifted verbatim from the note's "Refer" list ──────────────────────────
  { id: 10020, lc: 1233, tier: 'loose', src: 'note',
    why: 'Same prefix-pruning over a path hierarchy: delete a folder and every descendant path goes with it. Yours deletes a given set; 1233 removes any folder covered by another.' },
  { id: 10047, lc: 1106, tier: 'exact', src: 'note',
    why: 'Same parse-and-evaluate over a boolean expression with operators and parentheses. Note also ranks #772 Basic Calculator III as the structural twin; 1106 is the semantic one — your operators are boolean, not arithmetic.' },
  { id: 10048, lc:  981, tier: 'loose', src: 'note',
    why: 'The closest LeetCode gets to a versioned KV store — reads resolve against a stack of versions. LeetCode has no begin/commit/rollback problem; #1146 Snapshot Array is the other half of the idea.' },
  { id: 10049, lc:  286, tier: 'exact', src: 'note',
    why: 'Direct analog: gates = Bathrooms, rooms = Desks. One multi-source BFS seeded from every source at distance 0. Only difference: you emit at Desk cells and force -1 elsewhere — a post-filter, the BFS is unchanged.' },
  { id: 10050, lc: 2192, tier: 'exact', src: 'note',
    why: 'Identical ancestor-set propagation in topological order. Yours carries two 26-bit masks (allow, disallow) per node instead of an ancestor list, and subtracts at the end.' },
  { id: 10051, lc:  559, tier: 'exact', src: 'note',
    why: 'The trap: deletions cannot help, so the answer is just the height. Keeping the root connected means the best you can do is the existing deepest root path — this IS n-ary max depth.' },
  { id: 10053, lc: 1751, tier: 'exact', src: 'note',
    why: 'Weighted interval scheduling with a cardinality cap — pick at most k non-overlapping intervals to maximise value. Same DP, same binary-search-for-next-compatible step.' },
  { id: 10054, lc:  864, tier: 'exact', src: 'note',
    why: 'Same state-augmented BFS: candies ≡ keys. State is (cell, bitmask of collected), goal is the full mask. Grid, walls and 4-directional moves all match.' },
  { id: 10055, lc: 1408, tier: 'exact', src: 'note',
    why: 'Multi-pattern substring matching — is each recipe a contiguous run of the ingredient sequence. Same question over a token list instead of a string; #28 is the single-pattern KMP core.' },
  { id: 10057, lc:  210, tier: 'loose', src: 'note',
    why: 'The execution-order half is exactly Course Schedule II (Kahn + cycle detection). Yours composes it with a deep copy of the graph (#133-style) behind one API.' },
  { id: 10058, lc: 1242, tier: 'loose', src: 'note',
    why: 'Concurrent graph traversal with dedup — fan out async requests, collect replies, never revisit. Yours counts cluster nodes; 1242 crawls URLs. Same skeleton, same retry/idempotency concerns.' },
  { id: 10059, lc:  286, tier: 'loose', src: 'note',
    why: 'Same multi-source BFS engine, but you want a single global minimum, so you early-stop at the first opposite cell instead of filling every cell (#542 is the fill-everything version).' },
  { id: 10060, lc:  821, tier: 'exact', src: 'note',
    why: 'Same 1D nearest-occurrence scan: two passes (nearest target to the left, then to the right), take the closer. Yours returns the cake INDEX rather than the distance.' },
  { id: 10061, lc: 2694, tier: 'loose', src: 'note',
    why: 'Same reactive subscribe/emit shape — state changes fire callbacks. Your twist is emitting only on a genuine visibility FLIP of an already-seen value, tracked with two hash sets.' },
  { id: 10062, lc: 1206, tier: 'loose', src: 'note',
    why: 'You are barred from a built-in ordered container, which is precisely what 1206 makes you build. Add the range query on top and #981 / #715 cover the timestamp lookup half.' },
  { id: 10063, lc: 1958, tier: 'exact', src: 'note',
    why: 'Same question, one move later: given the cell just played, scan the axes outward from it to see whether the move completed a line. Only the last move can complete one.' },
  { id: 10064, lc:  589, tier: 'exact', src: 'note',
    why: 'N-ary pre-order with insertion-ordered children. The soft-delete twist is one line: the active flag gates EMISSION of a node, never recursion into its children.' },
  { id: 10065, lc:  821, tier: 'exact', src: 'note',
    why: 'Same 1D nearest-occurrence two-pass scan. Yours has 3 symbols (empty/person/cake) and measures the GAP |i-j|-1 (empty spots between) rather than the index difference.' },

  // ── authored from the statement (no note, no prior reference) ─────────────
  { id: 10000, lc: 2187, tier: 'loose', src: 'authored',
    why: 'Binary search on the answer with a summed-ceiling feasibility check: for t operations, job i needs ceil((exec[i] - t*y) / (x-y)) major turns, and it is feasible when those sum to at most t.' },
  { id: 10010, lc: 1710, tier: 'loose', src: 'authored',
    why: 'Single-pick greedy by rate: 1710 sorts by units per box, you rank query types by floor(k / time) * profit and take the best one. No DP needed — you may only choose ONE type.' },
  { id: 10011, lc: 1106, tier: 'exact', src: 'authored',
    why: 'Parse and evaluate a boolean expression with && / || and parentheses against a per-document token set. Same recursive parse-and-eval; only the syntax differs. Same problem as #10047.' },
  { id: 10013, lc: 1751, tier: 'exact', src: 'authored',
    why: 'Part 1 is weighted interval scheduling capped at K non-overlapping picks — exactly 1751. (Part 2, the tree path encoding, is closer to #1740 Find Distance in a Binary Tree.)' },
  { id: 10014, lc:  508, tier: 'exact', src: 'authored',
    why: 'Same single post-order pass computing every subtree sum. 508 tallies their frequencies; you write each sum into the matching position of a second identically-shaped tree.' },
  { id: 10015, lc:  297, tier: 'loose', src: 'authored',
    why: 'Same serialize/deserialize contract — design a wire format, then reconstruct the structure from it. Applied to a trie (#208) rather than a binary tree, so end-of-word markers replace null markers.' },
  { id: 10021, lc: 1408, tier: 'exact', src: 'authored',
    why: 'Is each recipe a contiguous run of the ingredient sequence — multi-pattern substring matching. Identical to #10055; #28 is the single-pattern KMP core.' },
  { id: 10022, lc:  278, tier: 'exact', src: 'authored',
    why: 'Part A is First Bad Version verbatim: the log is monotone (once Error appears every later entry is Error), so binary-search the left boundary. (Part B, failure propagation, is #2192.)' },
  { id: 10023, lc:  981, tier: 'loose', src: 'authored',
    why: 'The closest LeetCode gets to a versioned KV store — reads resolve against a stack of versions. No LC problem has begin/commit/rollback; #1146 Snapshot Array is the other half. Same problem as #10048.' },
  { id: 10025, lc: 1136, tier: 'exact', src: 'authored',
    why: 'Layered topological startup: everything with in-degree 0 starts together, then the next wave. 1136 counts the semesters; you emit the layers themselves and report cycles.' },
  { id: 10026, lc:  210, tier: 'exact', src: 'authored',
    why: 'Course Schedule II is the same deliverable: a topological order if the graph is a DAG, otherwise a cycle report. Yours additionally wants the iterative DFS and discover/finish times.' },

  // ── re-ranking an existing (unranked) reference ───────────────────────────
  { id: 10046, lc: 1011, tier: 'exact', src: 'authored',
    why: 'Minimum CAPACITY such that the count stays within a budget — the exact shape (1011: within D days; yours: within maxBoxes). Closer than #875 Koko, which searches a minimum SPEED. Your extra wrinkle is the per-box weight cap making the feasibility check a simulation.' },
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

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function buildChip({ lcNum, lcTitle, lcSlug, tier, why }) {
  const cls = tier === 'exact' ? 'desc-eq-chip' : 'desc-eq-chip loose'
  const mark = tier === 'exact' ? '≈' : '~';
  const label = tier === 'exact' ? 'Closest LC match' : 'Closest LC pattern'
  return `<p><a class="${cls}" href="https://leetcode.com/problems/${lcSlug}/" target="_blank" rel="noopener noreferrer"`
       + ` title="${esc(why)}">${mark} ${label} · ${lcNum}. ${esc(lcTitle)}</a></p>`
}

// Insert the chip as the first child of the wrapping <div>, else at the top.
function injectChip(desc, chip) {
  const m = desc.match(/^\s*<div[^>]*>/i)
  if (m) return desc.slice(0, m[0].length) + '\n  ' + chip + desc.slice(m[0].length)
  return chip + '\n' + desc
}

async function main() {
  console.log('\n' + '═'.repeat(72))
  console.log(`  Closest-LC chips for custom problems  [${DO_WRITE ? 'WRITE' : 'DRY-RUN'}]`)
  console.log('═'.repeat(72))
  const { sheetId } = await loadEnv()
  const sheets = google.sheets({ version: 'v4', auth: await authorize() })

  const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!A2:L` })).data.values ?? []
  const byId = new Map()
  rows.forEach((r, i) => { const id = (r[1] ?? '').trim(); if (id) byId.set(id, { row: i + 2, slug: r[0] ?? '', title: r[2] ?? '', desc: r[9] ?? '' }) })

  const updates = [], skipped = [], failed = []
  for (const p of PICKS) {
    if (ONLY && !ONLY.has(p.id)) continue
    const target = byId.get(String(p.id))
    const lc     = byId.get(String(p.lc))
    if (!target)            { failed.push(`#${p.id} — no LCProblems row`); continue }
    if (!lc)                { failed.push(`#${p.id} — LC ${p.lc} not in the sheet, cannot resolve its slug/title`); continue }
    if (target.desc.includes('desc-eq-chip')) { skipped.push(`#${p.id} (already chipped)`); continue }

    const chip = buildChip({ lcNum: p.lc, lcTitle: lc.title, lcSlug: lc.slug, tier: p.tier, why: p.why })
    updates.push({ p, row: target.row, title: target.title, lcTitle: lc.title, desc: injectChip(target.desc, chip) })
  }

  for (const u of updates) {
    const badge = u.p.tier === 'exact' ? 'green' : 'amber'
    console.log(`  #${u.p.id}  ${u.title.slice(0, 40).padEnd(40)} → ${String(u.p.lc).padStart(4)}. ${u.lcTitle.slice(0, 38).padEnd(38)} ${badge.padEnd(5)} ${u.p.src}`)
  }
  console.log(`\nto update: ${updates.length}   already chipped: ${skipped.length}   unresolved: ${failed.length}`)
  if (skipped.length) console.log('  ' + skipped.join('\n  '))
  if (failed.length)  console.log('✗ ' + failed.join('\n✗ '))

  if (!DO_WRITE) { console.log('\n[dry-run] pass --write to commit.\n'); return }
  if (failed.length) { console.error('\n✗ refusing to write while any pick is unresolved.\n'); process.exit(1) }
  if (!updates.length) { console.log('\n✓ Nothing to do.\n'); return }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates.map(u => ({ range: `${TAB}!J${u.row}`, values: [[u.desc]] })),
    },
  })
  console.log(`\n✓ Chipped ${updates.length} descriptions.\n`)
}
main().catch(e => { console.error('\n✗', e.message); process.exit(1) })
