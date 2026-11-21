// Comfort adapter — how comfortable the user is with each problem, one row per
// problem in the "Comfort" sheet tab. The user sets it; Solve Path reads it to
// suggest what to try next (building on comfortable problems) and what to
// solve first before a problem they are struggling with.
//
// Personal progress, so it lives in its own tab rather than as a column on
// LCProblems: the problem catalogue stays the same for everyone, and clearing
// progress never touches it. Created lazily on first use, like PatternNotes.

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const TAB  = 'Comfort'
const HEADERS = ['frontend_id', 'level', 'tries', 'last_tried', 'note', 'updated_at'] as const
const COL_RANGE = 'A2:F'

export type ComfortLevel = 'new' | 'tried' | 'comfortable' | 'fluent'

export const COMFORT_LEVELS: { id: ComfortLevel; icon: string; label: string; hint: string }[] = [
  { id: 'new',         icon: '🔴', label: 'Struggling',  hint: 'Can’t solve it yet' },
  { id: 'tried',       icon: '🟠', label: 'Tried',       hint: 'Solved with help, or after a few attempts' },
  { id: 'comfortable', icon: '🟢', label: 'Comfortable', hint: 'Solve it on my own' },
  { id: 'fluent',      icon: '⭐', label: 'Fluent',      hint: 'Fast, and could teach it' },
]
export const levelMeta = (l: ComfortLevel) => COMFORT_LEVELS.find(x => x.id === l) ?? COMFORT_LEVELS[0]
const isLevel = (s: string): s is ComfortLevel => COMFORT_LEVELS.some(l => l.id === s)

// Comfortable or better: these are the problems new ones get built on.
export const isAnchorLevel = (l: ComfortLevel) => l === 'comfortable' || l === 'fluent'

export interface ComfortEntry {
  id:        string        // LCProblems frontend_id
  level:     ComfortLevel
  tries:     number
  lastTried: string        // YYYY-MM-DD, '' if never logged
  note:      string
  updatedAt: string        // ISO timestamp
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
    }
    _tabEnsured = true
  })().finally(() => { _tabPending = null })
  return _tabPending
}

let _cache: Map<string, ComfortEntry> | null = null
export function getCachedComfort(): Map<string, ComfortEntry> | null { return _cache }

export async function loadComfort(force = false): Promise<Map<string, ComfortEntry>> {
  if (_cache && !force) return _cache
  await ensureTab()
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!${COL_RANGE}`)}`, { headers: auth() },
  )
  if (!res.ok) throw new Error(`Failed to load Comfort: ${res.status}`)
  const data = await res.json() as { values?: string[][] }
  const map = new Map<string, ComfortEntry>()
  for (const r of data.values ?? []) {
    const id = (r[0] ?? '').trim()
    const level = (r[1] ?? '').trim()
    if (!id || !isLevel(level)) continue          // blank (deleted) or malformed row
    map.set(id, {
      id, level,
      tries:     parseInt(r[2] ?? '', 10) || 0,
      lastTried: r[3] ?? '',
      note:      r[4] ?? '',
      updatedAt: r[5] ?? '',
    })
  }
  _cache = map
  return map
}

async function findRowNum(id: string): Promise<number> {
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A2:A`)}`, { headers: auth() },
  )
  if (!res.ok) return -1
  const data = await res.json() as { values?: string[][] }
  const idx = (data.values ?? []).findIndex(r => (r[0] ?? '').trim() === id)
  return idx < 0 ? -1 : idx + 2   // +1 header, +1 for 1-based rows
}

const toRow = (e: ComfortEntry): string[] =>
  [e.id, e.level, String(e.tries), e.lastTried, e.note, e.updatedAt]

// Create or overwrite the row for e.id. Returns the saved entry.
export async function saveComfort(e: Omit<ComfortEntry, 'updatedAt'>): Promise<ComfortEntry> {
  await ensureTab()
  const entry: ComfortEntry = { ...e, updatedAt: new Date().toISOString() }
  const rowNum = await findRowNum(entry.id)
  if (rowNum < 0) {
    const res = await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', headers: auth(), body: JSON.stringify({ values: [toRow(entry)] }) },
    )
    if (!res.ok) throw new Error(`Failed to save comfort: ${res.status}`)
  } else {
    const res = await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A${rowNum}:F${rowNum}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [toRow(entry)] }) },
    )
    if (!res.ok) throw new Error(`Failed to save comfort: ${res.status}`)
  }
  ;(_cache ??= new Map()).set(entry.id, entry)
  return entry
}

// Forget a problem: blank its row (row positions stay stable, like
// PatternNotes deletes) and drop it from the cache.
export async function removeComfort(id: string): Promise<void> {
  await ensureTab()
  const rowNum = await findRowNum(id)
  if (rowNum > 0) {
    const res = await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A${rowNum}:F${rowNum}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [['', '', '', '', '', '']] }) },
    )
    if (!res.ok) throw new Error(`Failed to remove comfort: ${res.status}`)
  }
  _cache?.delete(id)
}

export const today = () => new Date().toISOString().slice(0, 10)
