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
                   408, 411, 422, 648, 692, 758, 809, 819, 843, 1255, 2018],
  expression:     [150, 224, 227, 241, 282, 394, 439, 726, 736, 772, 1106, 10018],
  sum:            [1, 15, 16, 18, 39, 40, 112, 113, 124, 129, 167, 209, 216, 259, 327, 363,
                   377, 416, 437, 494, 523, 560, 653, 698, 862, 918, 923, 930, 974, 1099,
                   1214, 1679, 2461, 2761, 10014, 10027],
  // ── discovered / proposed (flagged for review) ──
  anagram:        [49, 242, 438, 760],
  // Strict: ordered, NON-contiguous subset on a linear DS (no subarray/substring).
  // LIS family (300/334/376/673/1218/354/646/1048), two-sequence/LCS
  // (115/392/727/792/1143/583), palindromic-subseq (2002/1312), enumerate (491),
  // subset-optimum (2542). #10021 was contiguous → excluded.
  subsequence:    [115, 300, 334, 354, 376, 392, 491, 583, 646, 673, 727, 792, 1048, 1143, 1218, 1312, 2002, 2542],
  scheduling:     [207, 210, 252, 253, 621, 1029, 1229, 1235, 1335, 1462, 2127, 2365, 2402],
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
