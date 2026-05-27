// AdsHub adapter — one row per LeetCode problem in the "LCProblems" sheet tab.
// Mirrors docsRepo's lazy-tab + load pattern. Populated by
// scripts/ads-to-sheets.mjs from a local _ADS checkout. Read-only from the
// portal's side for now (browse + lineage); tag-editing can be layered on later.

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'
import { getOrCreateFolder, uploadFileToDrive, updateDriveFileContent } from '../lib/drive'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const TAB  = 'LCProblems'

// Same Drive folder the migration script (ads-to-sheets.mjs) uploads notes to,
// so portal-authored notes live alongside the migrated ones.
const NOTES_FOLDER = 'PGHubTechAdsNotes'

const HEADERS = [
  'slug',             // problem slug (PK)
  'frontend_id',      // LeetCode display number
  'title',
  'difficulty',       // Easy | Medium | Hard
  'topics',           // "; "-joined LeetCode topics
  'companies',        // "; "-joined company list
  'companies_recent', // "; "-joined companies seen in the last 6 months
  'tags',             // "; "-joined custom :: lineage paths
  'leetcode_url',
  'description_html',  // formatted description fragment (rendered natively)
  'notes_drive_id',    // Drive file id of the Anki note page (blank if none)
  'has_notes',         // "1" if a note page exists
] as const

const COL_RANGE = `A2:L`   // row 1 is the header

export interface LCProblem {
  slug:            string
  frontendId:      string
  title:           string
  difficulty:      string
  topics:          string[]
  companies:       string[]
  companiesRecent: string[]
  tags:            string[]
  leetcodeUrl:     string
  descriptionHtml: string
  notesDriveId:    string
  hasNotes:        boolean
}

function auth(): Record<string, string> {
  const t = GAuth.getToken()
  if (!t) throw new Error('Not authenticated')
  return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
}

function sid(): string {
  const id = Config.sheetId
  if (!id) throw new Error('Sheet ID not configured')
  return id
}

let _tabEnsured = false
let _tabPending: Promise<void> | null = null

async function ensureTab(): Promise<void> {
  if (_tabEnsured) return
  if (_tabPending) return _tabPending
  _tabPending = (async () => {
    const res = await fetch(`${BASE}/${sid()}?fields=sheets.properties.title`, { headers: auth() })
    if (!res.ok) return
    const data = await res.json() as { sheets?: { properties?: { title?: string } }[] }
    const tabs = (data.sheets ?? []).map(s => s.properties?.title ?? '')
    if (!tabs.includes(TAB)) {
      await fetch(`${BASE}/${sid()}:batchUpdate`, {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] }),
      })
      await fetch(
        `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A1')}?valueInputOption=RAW`,
        { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [HEADERS as unknown as string[]] }) }
      )
    }
    _tabEnsured = true
  })().finally(() => { _tabPending = null })
  return _tabPending
}

const splitList = (s: string | undefined): string[] =>
  (s ?? '').split(/\s*;\s*/).map(t => t.trim()).filter(Boolean)

function rowToProblem(r: string[]): LCProblem | null {
  if (!r[0]) return null
  return {
    slug:            r[0],
    frontendId:      r[1] ?? '',
    title:           r[2] ?? '',
    difficulty:      r[3] ?? '',
    topics:          splitList(r[4]),
    companies:       splitList(r[5]),
    companiesRecent: splitList(r[6]),
    tags:            splitList(r[7]),
    leetcodeUrl:     r[8] ?? '',
    descriptionHtml: r[9] ?? '',
    notesDriveId:    r[10] ?? '',
    hasNotes:        (r[11] ?? '') === '1',
  }
}

// In-memory cache so switching away from AdsHub and back doesn't re-fetch all
// ~4k rows. Survives view remounts within a session; cleared on full reload.
let _cache: LCProblem[] | null = null

/** Synchronously returns cached problems if a load already happened, else null. */
export function getCachedProblems(): LCProblem[] | null {
  return _cache
}

// Wrap an edited note body fragment into a standalone, self-contained HTML
// document — same shape as the migrated Anki note pages (white page, images
// capped to width) so the in-app iframe viewer renders both identically.
function wrapNoteHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notes</title>
<style>
  html,body{margin:0;padding:16px;background:#fff;color:#1a1a2e;
    font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  img{max-width:100%;height:auto;}
  pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;
    padding:10px;border-radius:6px;border:1px solid #e1e4e8;}
  code{background:#f6f8fa;padding:1px 5px;border-radius:3px;}
  blockquote{border-left:3px solid #d0d7de;margin:6px 0;padding:2px 12px;color:#57606a;}
  h1,h2,h3{margin:10px 0 4px;}
  table{max-width:100%;border-collapse:collapse;}
</style>
</head>
<body>
${body}
</body>
</html>`
}

// Locate a problem's sheet row by slug → 1-based row number (or -1).
async function findRowNum(slug: string): Promise<number> {
  const res = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A2:A')}`,
    { headers: auth() },
  )
  if (!res.ok) throw new Error(`Failed to scan LCProblems: ${res.status}`)
  const data = await res.json() as { values?: string[][] }
  const idx  = (data.values ?? []).findIndex(r => r[0] === slug)
  return idx < 0 ? -1 : idx + 2   // +1 header, +1 to 1-based
}

// Write the notes_drive_id (col K) + has_notes (col L) back to the row.
async function updateProblemNoteRef(slug: string, driveId: string): Promise<void> {
  const rowNum = await findRowNum(slug)
  if (rowNum < 0) throw new Error('Problem row not found in LCProblems')
  const res = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!K${rowNum}:L${rowNum}`)}?valueInputOption=RAW`,
    { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [[driveId, '1']] }) },
  )
  if (!res.ok) throw new Error(`Failed to update note ref: ${res.status}`)
}

// Update a problem's custom :: tags (column H). Writes the sheet, patches the
// in-memory cache, and returns the cleaned tag list. The portal rebuilds
// lineage from this column, so the graph reflects the change on next render.
export async function updateProblemTags(slug: string, tags: string[]): Promise<string[]> {
  await ensureTab()
  const clean = [...new Set(tags.map(t => t.trim()).filter(Boolean))]
  const rowNum = await findRowNum(slug)
  if (rowNum < 0) throw new Error('Problem row not found in LCProblems')
  const res = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!H${rowNum}`)}?valueInputOption=RAW`,
    { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [[clean.join('; ')]] }) },
  )
  if (!res.ok) throw new Error(`Failed to update tags: ${res.status}`)
  const cached = _cache?.find(p => p.slug === slug)
  if (cached) cached.tags = clean
  return clean
}

// Create or overwrite a problem's note: uploads the wrapped HTML to the
// PGHubTechAdsNotes Drive folder, writes the reference back to the sheet, and
// patches the in-memory cache. `bodyHtml` should already have its images
// uploaded + be sanitised by the caller. Returns the Drive file id.
export async function saveProblemNote(problem: LCProblem, bodyHtml: string): Promise<string> {
  const token = GAuth.getToken()
  if (!token) throw new Error('Not authenticated')
  const blob = new Blob([wrapNoteHtml(bodyHtml)], { type: 'text/html' })

  let id = problem.notesDriveId
  if (id) {
    await updateDriveFileContent(token, id, blob)
  } else {
    const folderId = await getOrCreateFolder(token, NOTES_FOLDER)
    id = (await uploadFileToDrive(token, folderId, blob, `${problem.slug}.html`, 'text/html')).id
  }
  await updateProblemNoteRef(problem.slug, id)

  // Keep the cache (and any live view reading from it) in sync.
  const cached = _cache?.find(p => p.slug === problem.slug)
  if (cached) { cached.notesDriveId = id; cached.hasNotes = true }
  return id
}

export async function loadProblems(force = false): Promise<LCProblem[]> {
  if (_cache && !force) return _cache
  await ensureTab()
  const res = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!' + COL_RANGE)}`,
    { headers: auth() },
  )
  if (!res.ok) throw new Error(`Failed to load LCProblems: ${res.status}`)
  const data = await res.json() as { values?: string[][] }
  _cache = (data.values ?? []).map(rowToProblem).filter((p): p is LCProblem => p != null)
  return _cache
}

// ─── MyList: user-defined problem collections ────────────────────────────────
// Stored in a sibling tab "LCLists", one row per (list, problem) membership.
// A list exists as long as it has ≥1 row.
const LISTS_TAB     = 'LCLists'
const LISTS_HEADERS = ['list_name', 'slug', 'added_at'] as const

export interface LCList { name: string; slugs: string[] }

let _listsTabEnsured = false
async function ensureListsTab(): Promise<void> {
  if (_listsTabEnsured) return
  const res = await fetch(`${BASE}/${sid()}?fields=sheets.properties.title`, { headers: auth() })
  if (!res.ok) return
  const data = await res.json() as { sheets?: { properties?: { title?: string } }[] }
  const tabs = (data.sheets ?? []).map(s => s.properties?.title ?? '')
  if (!tabs.includes(LISTS_TAB)) {
    await fetch(`${BASE}/${sid()}:batchUpdate`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: LISTS_TAB } } }] }),
    })
    await fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(LISTS_TAB + '!A1')}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [LISTS_HEADERS as unknown as string[]] }) },
    )
  }
  _listsTabEnsured = true
}

let _listsCache: LCList[] | null = null
export function getCachedLists(): LCList[] | null { return _listsCache }

export async function loadLists(force = false): Promise<LCList[]> {
  if (_listsCache && !force) return _listsCache
  await ensureListsTab()
  const res = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(LISTS_TAB + '!A2:B')}`, { headers: auth() },
  )
  if (!res.ok) throw new Error(`Failed to load lists: ${res.status}`)
  const data = await res.json() as { values?: string[][] }
  const byName = new Map<string, string[]>()
  for (const r of data.values ?? []) {
    const name = (r[0] ?? '').trim(); const slug = (r[1] ?? '').trim()
    if (!name) continue
    const arr = byName.get(name) ?? []
    if (slug && !arr.includes(slug)) arr.push(slug)
    byName.set(name, arr)
  }
  _listsCache = [...byName.entries()]
    .map(([name, slugs]) => ({ name, slugs }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return _listsCache
}

export async function addToList(listName: string, slug: string): Promise<void> {
  const name = listName.trim()
  if (!name) throw new Error('List name required')
  await ensureListsTab()
  // No-op if the membership already exists.
  const existing = _listsCache?.find(l => l.name === name)
  if (existing?.slugs.includes(slug)) return
  await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(LISTS_TAB + '!A:C')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: auth(), body: JSON.stringify({ values: [[name, slug, new Date().toISOString()]] }) },
  ).then(r => { if (!r.ok) throw new Error(`Add to list failed: ${r.status}`) })
  // Patch cache.
  if (_listsCache) {
    const l = _listsCache.find(x => x.name === name)
    if (l) { if (!l.slugs.includes(slug)) l.slugs.push(slug) }
    else { _listsCache.push({ name, slugs: [slug] }); _listsCache.sort((a, b) => a.name.localeCompare(b.name)) }
  }
}

export async function renameList(oldName: string, newName: string): Promise<void> {
  const next = newName.trim()
  if (!next || next === oldName) return
  await ensureListsTab()
  const rows = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(LISTS_TAB + '!A2:A')}`, { headers: auth() },
  ).then(r => r.json()) as { values?: string[][] }
  const data = (rows.values ?? [])
    .map((r, i) => ({ name: (r[0] ?? '').trim(), row: i + 2 }))
    .filter(x => x.name === oldName)
    .map(x => ({ range: `${LISTS_TAB}!A${x.row}`, values: [[next]] }))
  if (!data.length) return
  await fetch(`${BASE}/${sid()}/values:batchUpdate`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  }).then(r => { if (!r.ok) throw new Error(`Rename list failed: ${r.status}`) })
  if (_listsCache) {
    const l = _listsCache.find(x => x.name === oldName)
    if (l) l.name = next
    _listsCache.sort((a, b) => a.name.localeCompare(b.name))
  }
}

// ─── Per-problem code (Python3 / Java) ───────────────────────────────────────
// Stored in an LCCode tab, one row per problem (lazy). Loaded on demand when a
// problem's code panel is opened, so the 4k-row browse stays light.
const CODE_TAB     = 'LCCode'
const CODE_HEADERS = ['slug', 'python3', 'java', 'py3_modified', 'java_modified', 'pins'] as const

export interface CodePin { code: string; ts: string }
export interface ProblemCode {
  python3: string; java: string
  py3Modified: string; javaModified: string
  pins: { python3: CodePin[]; java: CodePin[] }
}
export const EMPTY_CODE = (): ProblemCode =>
  ({ python3: '', java: '', py3Modified: '', javaModified: '', pins: { python3: [], java: [] } })

let _codeTabEnsured = false
async function ensureCodeTab(): Promise<void> {
  if (_codeTabEnsured) return
  const res = await fetch(`${BASE}/${sid()}?fields=sheets.properties.title`, { headers: auth() })
  if (!res.ok) return
  const data = await res.json() as { sheets?: { properties?: { title?: string } }[] }
  if (!(data.sheets ?? []).some(s => s.properties?.title === CODE_TAB)) {
    await fetch(`${BASE}/${sid()}:batchUpdate`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: CODE_TAB } } }] }),
    })
    await fetch(`${BASE}/${sid()}/values/${encodeURIComponent(CODE_TAB + '!A1')}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [CODE_HEADERS as unknown as string[]] }) })
  }
  _codeTabEnsured = true
}

async function findCodeRow(slug: string): Promise<number> {
  const res = await fetch(`${BASE}/${sid()}/values/${encodeURIComponent(CODE_TAB + '!A2:A')}`, { headers: auth() })
  if (!res.ok) return -1
  const data = await res.json() as { values?: string[][] }
  const idx = (data.values ?? []).findIndex(r => r[0] === slug)
  return idx < 0 ? -1 : idx + 2
}

export async function loadCode(slug: string): Promise<ProblemCode> {
  await ensureCodeTab()
  const rowNum = await findCodeRow(slug)
  if (rowNum < 0) return EMPTY_CODE()
  const res = await fetch(`${BASE}/${sid()}/values/${encodeURIComponent(`${CODE_TAB}!A${rowNum}:F${rowNum}`)}`, { headers: auth() })
  if (!res.ok) return EMPTY_CODE()
  const r = ((await res.json() as { values?: string[][] }).values ?? [[]])[0] ?? []
  let pins = { python3: [] as CodePin[], java: [] as CodePin[] }
  try { const p = JSON.parse(r[5] || '{}'); pins = { python3: p.python3 ?? [], java: p.java ?? [] } } catch { /* keep empty */ }
  return { python3: r[1] ?? '', java: r[2] ?? '', py3Modified: r[3] ?? '', javaModified: r[4] ?? '', pins }
}

export async function saveCode(slug: string, code: ProblemCode): Promise<void> {
  await ensureCodeTab()
  const row = [slug, code.python3, code.java, code.py3Modified, code.javaModified, JSON.stringify(code.pins)]
  const rowNum = await findCodeRow(slug)
  if (rowNum < 0) {
    await fetch(`${BASE}/${sid()}/values/${encodeURIComponent(CODE_TAB + '!A:F')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', headers: auth(), body: JSON.stringify({ values: [row] }) })
      .then(r => { if (!r.ok) throw new Error(`Save code failed: ${r.status}`) })
  } else {
    await fetch(`${BASE}/${sid()}/values/${encodeURIComponent(`${CODE_TAB}!A${rowNum}:F${rowNum}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [row] }) })
      .then(r => { if (!r.ok) throw new Error(`Save code failed: ${r.status}`) })
  }
}

export async function removeFromList(listName: string, slug: string): Promise<void> {
  await ensureListsTab()
  // Find the matching row (list_name + slug) and delete it.
  const meta = await fetch(`${BASE}/${sid()}?fields=sheets.properties(sheetId,title)`, { headers: auth() })
    .then(r => r.json()) as { sheets?: { properties?: { sheetId: number; title: string } }[] }
  const sheetId = (meta.sheets ?? []).find(s => s.properties?.title === LISTS_TAB)?.properties?.sheetId
  if (sheetId == null) return
  const rows = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(LISTS_TAB + '!A2:B')}`, { headers: auth() },
  ).then(r => r.json()) as { values?: string[][] }
  const idx = (rows.values ?? []).findIndex(r => (r[0] ?? '').trim() === listName && (r[1] ?? '').trim() === slug)
  if (idx < 0) return
  await fetch(`${BASE}/${sid()}:batchUpdate`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ requests: [{ deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: idx + 1, endIndex: idx + 2 },
    } }] }),
  }).then(r => { if (!r.ok) throw new Error(`Remove from list failed: ${r.status}`) })
  // Patch cache.
  if (_listsCache) {
    const l = _listsCache.find(x => x.name === listName)
    if (l) { l.slugs = l.slugs.filter(s => s !== slug) }
    _listsCache = _listsCache.filter(x => x.slugs.length > 0)
  }
}
