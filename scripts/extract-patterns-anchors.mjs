#!/usr/bin/env node
/**
 * scripts/extract-patterns-anchors.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot extractor: parse the current portal/public/patterns.html `PATTERNS`
 * array and emit the equivalent anchors as a CSV at portal/public/patterns-
 * data.csv. Lets us flip patterns.html to read its anchors from a data file
 * (next step) WITHOUT first touching the Google Sheet — same data, just
 * relocated.
 *
 * Once the sheet-driven seeder runs (scripts/seed-pat-tags.mjs) and tags
 * land on real LCProblems rows, the production generator (scripts/build-
 * patterns-csv.mjs) supersedes this script.
 *
 *   node scripts/extract-patterns-anchors.mjs           # dry-run, prints stats
 *   node scripts/extract-patterns-anchors.mjs --write   # writes patterns-data.csv
 *
 * Output CSV columns:
 *   anchor_id   LC frontend id
 *   tag         one of:
 *               pat_ds::<dsId>::core::<microId>                (DS-core micro)
 *               pat_topic::<topicId>::<microId>                (Topic micro, DS not yet known)
 *               pat_ds::<dsId>::<topicId>::<microId>           (full path — only after
 *                                                                   sheet-driven re-gen)
 *
 * One row per (anchor, tag) — easy to filter / dedupe.
 */

import { readFile, writeFile } from 'fs/promises'
import { dirname, join }       from 'path'
import { fileURLToPath }       from 'url'

const __dir       = dirname(fileURLToPath(import.meta.url))
const HTML_PATH   = join(__dir, '../portal/public/patterns.html')
const CSV_PATH    = join(__dir, '../portal/public/patterns-data.csv')
const DO_WRITE    = process.argv.includes('--write')

// ── Parse PATTERNS array out of patterns.html ────────────────────────────
// The array literal lives between `const PATTERNS = [` and the matching `\n]`
// followed by a blank line and the next const. We extract the literal and
// `Function('return [...]')` it — sandboxed enough since this script doesn't
// run the resulting code, just inspects the data.
async function loadPatterns() {
  const html = await readFile(HTML_PATH, 'utf8')
  const m = html.match(/const PATTERNS\s*=\s*\[([\s\S]*?)\n\]\n\n\/\/\s*── DS ↔ Topic/)
  if (!m) throw new Error('Could not locate PATTERNS array literal in patterns.html')
  return Function('return [' + m[1] + ']')()
}

function csvCell(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

async function main() {
  const patterns = await loadPatterns()
  const rows = []     // { anchor_id, tag }

  for (const p of patterns) {
    const isDs   = (p.tab || 'ds') === 'ds'
    for (const m of (p.micros || [])) {
      const anchors = m.anchors || []
      for (const id of anchors) {
        const tag = isDs
          ? `pat_ds::${p.id}::core::${m.id}`
          : `pat_topic::${p.id}::${m.id}`
        rows.push({ anchor_id: id, tag })
      }
    }
  }

  // Stats
  const dsTagCount    = rows.filter(r => r.tag.startsWith('pat_ds::')).length
  const topicTagCount = rows.filter(r => r.tag.startsWith('pat_topic::')).length
  const uniqAnchors   = new Set(rows.map(r => r.anchor_id)).size
  const uniqTags      = new Set(rows.map(r => r.tag)).size

  console.log(`\n  Parsed ${patterns.length} patterns from patterns.html`)
  console.log(`  → ${rows.length} (anchor, tag) rows`)
  console.log(`    · ${dsTagCount} pat_ds::*::core::*  (DS-core micros)`)
  console.log(`    · ${topicTagCount} pat_topic::*::*    (Topic micros — DS not yet inferred)`)
  console.log(`    · ${uniqAnchors} unique anchor IDs   /  ${uniqTags} unique tags\n`)

  if (!DO_WRITE) {
    console.log(`  [dry-run] would write ${CSV_PATH}`)
    console.log(`  Pass --write to commit.\n`)
    return
  }

  const header = 'anchor_id,tag\n'
  const body   = rows.map(r => csvCell(r.anchor_id) + ',' + csvCell(r.tag)).join('\n')
  await writeFile(CSV_PATH, header + body + '\n')
  console.log(`  ✓ Wrote ${CSV_PATH}  (${rows.length} rows, ${(header.length + body.length)} bytes)\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
