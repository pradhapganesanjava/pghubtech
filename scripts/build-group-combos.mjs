#!/usr/bin/env node
/**
 * scripts/build-group-combos.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only. From scripts/pat-tagged.json + scripts/group-pat.json, enumerate
 * every (group × DS) and (group × Topic) combination with the actual problems
 * in it. Prints a human-readable digest (for authoring summaries) and writes
 * scripts/group-combos.json — the grounding set for patterns-group-notes.json.
 *
 *   node scripts/build-group-combos.mjs
 */
import { readFile, writeFile } from 'fs/promises'
import { dirname, join }       from 'path'
import { fileURLToPath }       from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

const dsOf    = p => [...new Set(p.pat_ds.map(t => t.split('::')[1]))]
const topicOf = p => [...new Set([
  ...p.pat_topic.map(t => t.split('::')[1]),
  ...p.pat_ds.filter(t => t.split('::').length === 4 && t.split('::')[2] !== 'core').map(t => t.split('::')[2]),
])]

async function main() {
  const tagged = JSON.parse(await readFile(join(__dir, 'pat-tagged.json'), 'utf8'))
  const gp     = JSON.parse(await readFile(join(__dir, 'group-pat.json'), 'utf8'))
  const byId   = new Map(tagged.map(p => [String(p.id), p]))

  // group -> [problem]
  const groups = {}
  for (const [id, tags] of Object.entries(gp)) {
    const p = byId.get(String(id)); if (!p) continue
    for (const t of tags) {
      const g = t.split('::')[1]
      ;(groups[g] = groups[g] || []).push(p)
    }
  }

  const out = {}   // group -> { ds:{dsId:[{id,title}]}, topic:{...} }
  for (const [g, probs] of Object.entries(groups)) {
    const ds = {}, topic = {}
    for (const p of probs) {
      for (const d of dsOf(p))    (ds[d]    = ds[d]    || []).push({ id: p.id, title: p.title })
      for (const t of topicOf(p)) (topic[t] = topic[t] || []).push({ id: p.id, title: p.title })
    }
    out[g] = { ds, topic }
  }

  await writeFile(join(__dir, 'group-combos.json'), JSON.stringify(out, null, 2) + '\n')

  let combos = 0
  for (const [g, dims] of Object.entries(out)) {
    console.log(`\n══════ ${g} ══════`)
    for (const kind of ['ds', 'topic']) {
      for (const [dim, probs] of Object.entries(dims[kind])) {
        combos++
        console.log(`  [${kind}] ${g} × ${dim}  (${probs.length})`)
        console.log(`        ${probs.map(p => `#${p.id} ${p.title}`).join(' · ')}`)
      }
    }
  }
  console.log(`\n  ${combos} combinations · wrote scripts/group-combos.json\n`)
}
main().catch(e => { console.error(e.message); process.exit(1) })
