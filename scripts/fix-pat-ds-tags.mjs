#!/usr/bin/env node
/**
 * scripts/fix-pat-ds-tags.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-healing cleanup: for every row carrying `pat_ds::<ds>::<topic>::<micro>`
 * tags, re-evaluate the DS using the CURRENT (fixed) inferDs() heuristic.
 * If the existing tag's DS doesn't match what we'd pick today, replace it.
 * Core tags (`pat_ds::<ds>::core::<micro>`) and short topic tags
 * (`pat_topic::<topic>::<micro>`) are left untouched.
 *
 *   node scripts/fix-pat-ds-tags.mjs            # dry-run, lists changes
 *   node scripts/fix-pat-ds-tags.mjs --write    # actually patches the sheet
 *
 * Workflow when inferDs() changes:
 *   1. Edit inferDs() in seed-pat-tags.mjs (and mirror here, kept in sync).
 *   2. node scripts/fix-pat-ds-tags.mjs --write
 *   3. node scripts/build-patterns-csv.mjs --write
 *   4. patterns.html picks up corrected anchors on next load.
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
const COL_ID     = 1   // B  frontend_id
const COL_TOPICS = 4   // E
const COL_TAGS   = 7   // H

// Keep this in sync with seed-pat-tags.mjs's inferDs.
function inferDs(lcTopics) {
  const t = new Set(lcTopics.split(/[;\n]+/).map(s => s.trim()))
  if (t.has('Linked List'))                                  return 'linked-list'
  if (t.has('Binary Search Tree') && !t.has('Data Stream'))   return 'bst'
  if (t.has('Tree') || t.has('Binary Tree') || t.has('N-ary Tree')) return 'tree'
  if (t.has('Graph') || t.has('Graph Theory') || t.has('Topological Sort') || t.has('Shortest Path')) return 'graph'
  if (t.has('Matrix'))                                        return 'matrices'
  if (t.has('Trie')  && t.has('Design')) return 'trie'
  if (t.has('Stack') && t.has('Design')) return 'stack'
  if (t.has('Queue') && t.has('Design')) return 'queue'
  if (t.has('String'))                                        return 'string'
  if (t.has('Array'))                                         return 'array'
  if (t.has('Math') || t.has('Bit Manipulation') || t.has('Dynamic Programming')
      || t.has('Backtracking') || t.has('Bitmask') || t.has('Data Stream')
      || t.has('Recursion') || t.has('Divide and Conquer')
      || t.has('Combinatorics') || t.has('Number Theory') || t.has('Memoization')
      || t.has('Interactive') || t.has('Simulation')) return 'array'
  return null
}

// ── env + auth (same convention as sibling scripts) ──────────────────────
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

  // Walk every row whose tags contain pat_ds::<X>::<Y>::<Z> where Y != core.
  // Reconcile each against the current inferDs.
  const writeRequests = []
  let totalRowsChanged = 0
  let totalTagsFixed   = 0
  const sample = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const id      = (r[COL_ID]     || '').trim()
    const topics  = (r[COL_TOPICS] || '').trim()
    const tagsRaw = (r[COL_TAGS]   || '').trim()
    if (!tagsRaw) continue
    const tags = tagsRaw.split(/[;\n]+/).map(s => s.trim()).filter(Boolean)

    // Only act if there's at least one 4-segment pat_ds tag (non-core).
    const has4Seg = tags.some(t => {
      const p = t.split('::')
      return p[0] === 'pat_ds' && p.length === 4 && p[2] !== 'core'
    })
    if (!has4Seg) continue

    const correctDs = inferDs(topics)
    if (!correctDs) continue

    const out = []
    const fixesHere = []
    const seen = new Set()
    for (const t of tags) {
      const p = t.split('::')
      if (p[0] === 'pat_ds' && p.length === 4 && p[2] !== 'core' && p[1] !== correctDs) {
        // Wrong DS — rewrite to the corrected DS.
        const fixed = `pat_ds::${correctDs}::${p[2]}::${p[3]}`
        if (!seen.has(fixed)) { out.push(fixed); seen.add(fixed) }
        fixesHere.push(`${t} → ${fixed}`)
      } else {
        if (!seen.has(t)) { out.push(t); seen.add(t) }
      }
    }

    if (!fixesHere.length) continue
    totalRowsChanged++
    totalTagsFixed += fixesHere.length
    if (sample.length < 10) sample.push({ id, fixes: fixesHere })
    writeRequests.push({
      range: `${TAB}!H${i + 2}`,
      values: [[out.join('; ')]],
    })
  }

  console.log(`  ${totalRowsChanged} rows would change; ${totalTagsFixed} tag occurrences would be rewritten.\n`)
  for (const s of sample) {
    console.log(`    LC ${s.id}:`)
    for (const f of s.fixes) console.log(`       ${f}`)
  }
  if (sample.length < totalRowsChanged) console.log(`    … (${totalRowsChanged - sample.length} more)`)

  if (!DO_WRITE) {
    console.log(`\n  [dry-run] no sheet writes performed.  Pass --write to apply.\n`)
    return
  }
  if (!writeRequests.length) { console.log('\n  Nothing to fix.\n'); return }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: 'RAW', data: writeRequests },
  })
  console.log(`\n  ✓ Patched ${writeRequests.length} rows.\n`)
  console.log(`  Next: node scripts/build-patterns-csv.mjs --write\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
