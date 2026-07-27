// Point2Rem — "points to remember": free-form notes carrying ::-hierarchical
// tags and optional links to existing AdsHub problems.
//
// One row per note in the "Point2Rem" sheet tab (its own tab — Browse problems
// and pattern notes are untouched). Unlike patternNotesRepo, the body lives in
// the row itself rather than a Drive file: these notes are short prose /
// markdown, and keeping them in the cell makes them editable straight from the
// Sheet as well as the portal.
//
// The bundled public/point2rem.json is the SEED: when the tab doesn't exist
// yet it's created and populated from that file, so a fresh sheet starts with
// the shipped notes instead of an empty tab.

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const TAB  = 'Point2Rem'

const HEADERS = [
  'id',          // stable slug (PK)
  'title',
  'tags',        // "; "-joined :: paths
  'content',     // markdown (or HTML when format = html)
  'format',      // 'md' | 'html'
  'problems',    // "; "-joined LC frontend ids
  'links',       // one per line: "label | url"
  'updated_at',
] as const

const COL_RANGE = 'A2:H'

// Google Sheets caps a cell at 50,000 characters. Fail loudly below that
// rather than let the API truncate a note silently.
export const P2R_MAX_CONTENT = 45_000

export interface P2RLink {
  label?: string
  url:    string
}

export interface P2RItem {
  id:        string
  title:     string
  tags:      string[]          // ::-hierarchical; [] ⇒ grouped under "untagged"
  content:   string            // markdown unless format === 'html'
  format:    'md' | 'html'
  problems:  string[]          // LC frontend ids linked to this note
  links:     P2RLink[]
  updated:   string
}

// Items with no tags are grouped under this synthetic path so they stay
// visible instead of silently dropping out of the tree.
export const P2R_UNTAGGED = 'untagged'

export function emptyP2RItem(): P2RItem {
  return { id: '', title: '', tags: [], content: '', format: 'md', problems: [], links: [], updated: '' }
}

export function slugifyP2RId(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
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

// ── Row ↔ item ───────────────────────────────────────────────────────────────

const splitList = (s: string | undefined): string[] =>
  (s ?? '').split(/\s*;\s*/).map(t => t.trim()).filter(Boolean)

// Links are newline-separated "label | url" (a bare url is fine too) — labels
// may contain ";" so the "; " convention used for the flat lists won't do.
function parseLinks(s: string | undefined): P2RLink[] {
  const out: P2RLink[] = []
  for (const line of (s ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const bar = t.indexOf('|')
    if (bar < 0) { out.push({ url: t }); continue }
    const label = t.slice(0, bar).trim()
    const url   = t.slice(bar + 1).trim()
    if (!url) continue
    out.push(label ? { label, url } : { url })
  }
  return out
}

const stringifyLinks = (links: P2RLink[]): string =>
  links.map(l => l.label ? `${l.label} | ${l.url}` : l.url).join('\n')

function rowToItem(r: string[]): P2RItem | null {
  if (!r[0]) return null
  return {
    id:       r[0],
    title:    r[1] || r[0],
    tags:     splitList(r[2]),
    content:  r[3] ?? '',
    format:   (r[4] ?? '').toLowerCase() === 'html' ? 'html' : 'md',
    problems: splitList(r[5]),
    links:    parseLinks(r[6]),
    updated:  r[7] ?? '',
  }
}

const itemToRow = (i: P2RItem): string[] => [
  i.id, i.title, i.tags.join('; '), i.content, i.format,
  i.problems.join('; '), stringifyLinks(i.links), i.updated,
]

// ── Tab bootstrap (+ one-time seed from the bundled JSON) ────────────────────

let _tabEnsured = false
let _tabPending: Promise<void> | null = null

async function ensureTab(): Promise<void> {
  if (_tabEnsured) return
  if (_tabPending) return _tabPending
  _tabPending = (async () => {
    const res = await GAuth.fetch(`${BASE}/${sid()}?fields=sheets.properties.title`, { headers: auth() })
    if (!res.ok) return
    const data = await res.json() as { sheets?: { properties?: { title?: string } }[] }
    const tabs = (data.sheets ?? []).map(s => s.properties?.title ?? '')
    if (!tabs.includes(TAB)) {
      await GAuth.fetch(`${BASE}/${sid()}:batchUpdate`, {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] }),
      })
      await GAuth.fetch(
        `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A1')}?valueInputOption=RAW`,
        { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [HEADERS as unknown as string[]] }) },
      )
      // Only ever seeded on the tab's first creation — deleting every note
      // later must NOT resurrect the shipped ones.
      await seedFromBundledJson()
    }
    _tabEnsured = true
  })().finally(() => { _tabPending = null })
  return _tabPending
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []

function normalizeSeed(raw: unknown, idx: number): P2RItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const title   = String(r.title ?? '').trim()
  const content = String(r.content ?? '')
  if (!title && !content) return null
  const links: P2RLink[] = []
  if (Array.isArray(r.links)) {
    for (const l of r.links) {
      if (typeof l === 'string') { links.push({ url: l }); continue }
      if (l && typeof l === 'object') {
        const url = String((l as P2RLink).url ?? '').trim()
        if (!url) continue
        const label = String((l as P2RLink).label ?? '').trim()
        links.push(label ? { label, url } : { url })
      }
    }
  }
  return {
    id: String(r.id ?? '').trim() || slugifyP2RId(title) || `p2r-${idx + 1}`,
    title: title || `Point ${idx + 1}`,
    tags: asStrings(r.tags),
    content,
    format: String(r.format ?? '').toLowerCase() === 'html' ? 'html' : 'md',
    problems: asStrings(r.problems),
    links,
    updated: String(r.updated ?? '').trim(),
  }
}

async function seedFromBundledJson(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}point2rem.json`)
    if (!res.ok) return
    const json = await res.json() as { items?: unknown }
    const items = Array.isArray(json.items) ? json.items : []
    const rows: string[][] = []
    const seen = new Set<string>()
    for (let i = 0; i < items.length; i++) {
      const item = normalizeSeed(items[i], i)
      if (!item) continue
      if (seen.has(item.id)) item.id = `${item.id}-${i}`
      seen.add(item.id)
      rows.push(itemToRow(item))
    }
    if (rows.length === 0) return
    await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', headers: auth(), body: JSON.stringify({ values: rows }) },
    )
  } catch { /* seeding is best-effort — an empty tab is still usable */ }
}

// ── Load ─────────────────────────────────────────────────────────────────────

let _cache: P2RItem[] | null = null

export function getCachedPoint2Rem(): P2RItem[] | null {
  return _cache
}

export async function loadPoint2Rem(force = false): Promise<P2RItem[]> {
  if (_cache && !force) return _cache
  await ensureTab()
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!${COL_RANGE}`)}`, { headers: auth() },
  )
  if (!res.ok) throw new Error(`Point2Rem: ${res.status} ${res.statusText}`)
  const data = await res.json() as { values?: string[][] }
  const out: P2RItem[] = []
  const seen = new Set<string>()
  for (const r of (data.values ?? [])) {
    const item = rowToItem(r)
    if (!item) continue
    // Ids drive selection; a duplicate would make two rows highlight together.
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  _cache = out
  return out
}

// ── Write ────────────────────────────────────────────────────────────────────

// 1-based sheet row for an id, or -1. Read fresh (not from _cache) so a note
// added in another tab/session is still found.
async function findRowNum(id: string): Promise<number> {
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A2:A`)}`, { headers: auth() },
  )
  if (!res.ok) return -1
  const data = await res.json() as { values?: string[][] }
  const idx = (data.values ?? []).findIndex(r => r[0] === id)
  return idx < 0 ? -1 : idx + 2   // +1 header, +1 for 1-based rows
}

// Create or update one note. `id` is assigned from the title when blank, and
// de-duplicated against what's already loaded. Returns the saved item.
export async function savePoint2Rem(item: P2RItem): Promise<P2RItem> {
  await ensureTab()
  const title = item.title.trim()
  if (!title) throw new Error('Title is required')
  if (item.content.length > P2R_MAX_CONTENT) {
    throw new Error(`Content is ${item.content.length.toLocaleString()} chars — the sheet caps a cell at ${P2R_MAX_CONTENT.toLocaleString()}`)
  }

  let id = item.id.trim()
  if (!id) {
    const base = slugifyP2RId(title) || 'point'
    const taken = new Set((_cache ?? []).map(i => i.id))
    id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  }

  const saved: P2RItem = {
    ...item, id, title,
    updated: (() => { try { return new Date().toISOString().slice(0, 10) } catch { return item.updated } })(),
  }
  const values = [itemToRow(saved)]
  const rowNum = await findRowNum(id)
  if (rowNum < 0) {
    await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', headers: auth(), body: JSON.stringify({ values }) },
    )
  } else {
    await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A${rowNum}:H${rowNum}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values }) },
    )
  }

  // Keep the module cache in step so the sidebar re-renders without a refetch.
  const next = [...(_cache ?? [])]
  const at = next.findIndex(i => i.id === id)
  if (at < 0) next.push(saved); else next[at] = saved
  _cache = next
  return saved
}

// Delete a note: blank its row (rowToItem skips rows with no id, and blanking
// avoids re-indexing every row below it).
export async function deletePoint2Rem(id: string): Promise<void> {
  await ensureTab()
  const rowNum = await findRowNum(id)
  if (rowNum >= 0) {
    await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A${rowNum}:H${rowNum}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [['', '', '', '', '', '', '', '']] }) },
    )
  }
  _cache = (_cache ?? []).filter(i => i.id !== id)
}
