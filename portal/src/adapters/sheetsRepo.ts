// Google Sheets REST API wrapper
// Items sheet:    id | title | content | tags | category | created_at | notes | status
// Settings sheet: key | value

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

const SHEETS = {
  ITEMS:    'Items',
  SETTINGS: 'Settings',
} as const

const HEADERS = {
  ITEMS:    ['id', 'title', 'content', 'tags', 'category', 'created_at', 'notes', 'status'],
  SETTINGS: ['key', 'value'],
}

export interface TechItem {
  id:         string
  title:      string
  content:    string
  tags:       string
  category:   string
  created_at: string
  notes:      string
  status:     string
}

function authHeaders(): Record<string, string> {
  const token = GAuth.getToken()
  if (!token) throw new Error('Not authenticated')
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

function sid(): string {
  const id = Config.sheetId
  if (!id) throw new Error('Sheet ID not configured')
  return id
}

function errMsg(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const obj = e as { error?: { message?: string }; message?: string }
    if (obj.error?.message) return obj.error.message
    if (obj.message) return obj.message
  }
  return String(e)
}

async function getRange(range: string): Promise<string[][]> {
  const url = `${BASE}/${sid()}/values/${encodeURIComponent(range)}`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as unknown
    throw new Error(errMsg(err) || `HTTP ${res.status}`)
  }
  const data = await res.json() as { values?: string[][] }
  return data.values ?? []
}

async function setRange(range: string, values: string[][]): Promise<void> {
  const url = `${BASE}/${sid()}/values/${encodeURIComponent(range)}?valueInputOption=RAW`
  const res = await fetch(url, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ values }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as unknown
    throw new Error(errMsg(err) || `HTTP ${res.status}`)
  }
}

async function appendRows(sheet: string, values: string[][]): Promise<void> {
  const url = `${BASE}/${sid()}/values/${encodeURIComponent(sheet + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ values }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as unknown
    throw new Error(errMsg(err) || `HTTP ${res.status}`)
  }
}

// ── Access check ───────────────────────────────────────────────
export async function checkAccess(): Promise<void> {
  const url = `${BASE}/${sid()}?fields=spreadsheetId`
  const res = await fetch(url, { headers: authHeaders() })
  if (res.status === 404) throw new Error('Sheet not found — check your Sheet ID.')
  if (res.status === 403) throw new Error('No access — make sure the sheet is shared with your Google account.')
  if (!res.ok) throw new Error(`Sheet error: HTTP ${res.status}`)
}

// ── Header bootstrap ────────────────────────────────────────────
export async function ensureHeaders(): Promise<void> {
  const specs: [string, string[], string][] = [
    [SHEETS.ITEMS,    HEADERS.ITEMS,    'A1:H1'],
    [SHEETS.SETTINGS, HEADERS.SETTINGS, 'A1:B1'],
  ]
  for (const [sheet, hdr, range] of specs) {
    try {
      const rows = await getRange(`${sheet}!${range}`)
      if (!rows.length) await setRange(`${sheet}!${range}`, [hdr])
    } catch { /* sheet tab may not exist yet */ }
  }
}

// ── Items CRUD ─────────────────────────────────────────────────
export async function loadItems(): Promise<TechItem[]> {
  const rows = await getRange(`${SHEETS.ITEMS}!A2:H`)
  return rows
    .map(r => ({
      id:         r[0] ?? '',
      title:      r[1] ?? '',
      content:    r[2] ?? '',
      tags:       r[3] ?? '',
      category:   r[4] ?? '',
      created_at: r[5] ?? '',
      notes:      r[6] ?? '',
      status:     r[7] ?? 'active',
    }))
    .filter(c => c.id && c.title)
}

export async function saveItem(item: Omit<TechItem, 'id' | 'created_at'> & Partial<Pick<TechItem, 'id' | 'created_at'>>): Promise<TechItem> {
  const full: TechItem = {
    id:         item.id         ?? crypto.randomUUID(),
    title:      item.title,
    content:    item.content,
    tags:       item.tags,
    category:   item.category,
    created_at: item.created_at ?? new Date().toISOString(),
    notes:      item.notes,
    status:     item.status     ?? 'active',
  }
  await appendRows(SHEETS.ITEMS, [[
    full.id, full.title, full.content, full.tags,
    full.category, full.created_at, full.notes, full.status,
  ]])
  return full
}

export async function updateItem(item: TechItem): Promise<void> {
  const rows = await getRange(`${SHEETS.ITEMS}!A:A`)
  const idx = rows.findIndex(r => r[0] === item.id)
  if (idx < 1) throw new Error('Item not found in sheet.')
  await setRange(`${SHEETS.ITEMS}!A${idx + 1}:H${idx + 1}`, [[
    item.id, item.title, item.content, item.tags,
    item.category, item.created_at, item.notes, item.status,
  ]])
}

export async function deleteItem(id: string): Promise<void> {
  const rows = await getRange(`${SHEETS.ITEMS}!A:A`)
  const idx = rows.findIndex(r => r[0] === id)
  if (idx < 1) return
  await setRange(`${SHEETS.ITEMS}!A${idx + 1}:H${idx + 1}`, [['', '', '', '', '', '', '', '']])
}

// ── Settings CRUD ──────────────────────────────────────────────
export async function loadSettings(): Promise<Record<string, string>> {
  try {
    const rows = await getRange(`${SHEETS.SETTINGS}!A2:B`)
    const map: Record<string, string> = {}
    rows.forEach(r => { if (r[0]) map[r[0]] = r[1] ?? '' })
    return map
  } catch { return {} }
}

export async function saveSetting(key: string, value: string): Promise<void> {
  const rows = await getRange(`${SHEETS.SETTINGS}!A:A`)
  const idx = rows.findIndex(r => r[0] === key)
  if (idx < 1) {
    await appendRows(SHEETS.SETTINGS, [[key, value]])
  } else {
    await setRange(`${SHEETS.SETTINGS}!A${idx + 1}:B${idx + 1}`, [[key, value]])
  }
}
