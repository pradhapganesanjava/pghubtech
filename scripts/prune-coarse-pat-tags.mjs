#!/usr/bin/env node
/**
 * scripts/prune-coarse-pat-tags.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Cleanup after a sub-micro split: when an LC row carries BOTH a coarse
 * tag (e.g. pat_*::dp::dp-1d-linear) AND a more-specific sub-micro under
 * the same topic (e.g. pat_*::dp::dp-lis), the coarse one is redundant —
 * the row already lives under the precise micro card. Strip the coarse.
 *
 *   node scripts/prune-coarse-pat-tags.mjs            # dry-run
 *   node scripts/prune-coarse-pat-tags.mjs --write    # actually prunes
 *
 * Idempotent. Re-running after a future split just removes whatever's
 * been newly superseded — extend SUPERSEDES as splits are added.
 *
 * Both tag forms are recognised + stripped:
 *   pat_topic::<topic>::<coarseMicro>
 *   pat_ds::<ds>::<topic>::<coarseMicro>
 *
 * `pat_ds::<ds>::core::<microId>` tags are NEVER pruned by this script —
 * those are DS-core anchors with no topic involved.
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
const COL_ID   = 1
const COL_TAGS = 7

// ─── Supersede map ──────────────────────────────────────────────────────
// Keyed by `${topicId}::${coarseMicroId}`. Value = Set of sub-micro IDs
// that, when present on the SAME row under the SAME topic, mean the
// coarse tag is redundant.
//
// Extend this each time a new sub-micro split lands. The current set
// reflects batches 4–6 (commits f5d5ace, d535ef0, this turn).
const SUPERSEDES = {
  // batch 4
  'dp::dp-1d-linear':              new Set(['dp-lis', 'dp-row-build']),
  'two-pointers::tp-converging':   new Set(['tp-k-sum', 'tp-area-greedy']),
  'greedy::sort-and-sweep':        new Set(['greedy-end-sorted']),
  // batch 5
  'dfs::dfs-template':             new Set(['dfs-parallel-trees', 'dfs-tree-mutate', 'dfs-grid-flood']),
  'bfs::bfs-level-order':          new Set(['bfs-position-tracked', 'bfs-level-connect']),
  'hash::seen-set':                new Set(['hash-chain-build']),
  'backtrack::permutation':        new Set(['next-permutation-algo', 'combinatorial-product']),
  // batch 6 (this turn)
  'stack-topic::monotonic-stack':  new Set(['monotonic-stack-spans']),
  'dp::dp-2d-grid':                new Set(['dp-2d-square']),
  'sliding-window::sw-shrink-violation': new Set(['sw-distinct-count']),
  // bs-on-answer → compound (simulated-feasibility) split
  'binary-search::bs-on-answer':   new Set(['bs-on-answer-compound']),
}

// Parse a tag → { kind, ds, topic, micro } or null if not pat_*.
function parsePatTag(tag) {
  const p = tag.split('::')
  if (p[0] === 'pat_topic' && p.length === 3)
    return { kind: 'topic', topic: p[1], micro: p[2] }
  if (p[0] === 'pat_ds' && p.length === 4 && p[2] === 'core')
    return { kind: 'ds-core', ds: p[1], micro: p[3] }
  if (p[0] === 'pat_ds' && p.length === 4 && p[2] !== 'core')
    return { kind: 'ds-topic', ds: p[1], topic: p[2], micro: p[3] }
  return null
}

// ── env + auth (same as sibling scripts) ─────────────────────────────────
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
  console.log(`  Supersedes table covers ${Object.keys(SUPERSEDES).length} coarse → sub mappings.\n`)

  const writeRequests = []
  let totalRowsTouched = 0
  let totalTagsPruned  = 0
  const sample = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const id      = (r[COL_ID]   || '').trim()
    const tagsRaw = (r[COL_TAGS] || '').trim()
    if (!tagsRaw) continue

    const tags = tagsRaw.split(/[;\n]+/).map(s => s.trim()).filter(Boolean)
    const parsed = tags.map(t => ({ tag: t, p: parsePatTag(t) }))

    // What sub-micros does this row have, grouped by topic?
    const subsByTopic = {}   // topicId → Set<microId>
    for (const { p } of parsed) {
      if (!p || !p.topic) continue   // skip non-pat tags and ds-core
      ;(subsByTopic[p.topic] = subsByTopic[p.topic] || new Set()).add(p.micro)
    }

    // Identify redundant coarse tags.
    const drop = new Set()
    for (const { tag, p } of parsed) {
      if (!p || !p.topic) continue
      const supersedeKey = `${p.topic}::${p.micro}`
      const subs = SUPERSEDES[supersedeKey]
      if (!subs) continue
      const present = subsByTopic[p.topic] || new Set()
      // Drop only if the row genuinely has a sub-micro under the same topic.
      // (Not just itself — must be a DIFFERENT, more-specific one.)
      let hasSub = false
      for (const s of subs) if (present.has(s)) { hasSub = true; break }
      if (hasSub) drop.add(tag)
    }

    if (!drop.size) continue
    totalRowsTouched++
    totalTagsPruned += drop.size
    const kept = tags.filter(t => !drop.has(t))
    if (sample.length < 10) sample.push({ id, drop: [...drop], kept })
    writeRequests.push({
      range: `${TAB}!H${i + 2}`,
      values: [[kept.join('; ')]],
    })
  }

  console.log(`  ${totalRowsTouched} rows would change; ${totalTagsPruned} coarse tags pruned.\n`)
  for (const s of sample) {
    console.log(`    LC ${String(s.id).padStart(4)}:`)
    for (const d of s.drop) console.log(`       − ${d}`)
  }
  if (sample.length < totalRowsTouched)
    console.log(`    … (${totalRowsTouched - sample.length} more)`)

  if (!DO_WRITE) {
    console.log(`\n  [dry-run] no sheet writes performed.  Pass --write to apply.\n`)
    return
  }
  if (!writeRequests.length) { console.log('\n  Nothing to prune.\n'); return }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: 'RAW', data: writeRequests },
  })
  console.log(`\n  ✓ Patched ${writeRequests.length} rows.\n`)
  console.log(`  Next: node scripts/build-patterns-csv.mjs --write\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
