// Utils tools — ToDo (nested task tree) + Activity Log (per-date entries).
// Both live as new tabs in the user's main spreadsheet.
//
//   ToDo!     id, parent_id, title, done, position, created_at, updated_at
//   Activity! id, date, kind, time, content, created_at
//
//   Activity.kind ∈ {'top_task', 'hourly', 'wins', 'improvements'}
//     top_task / wins / improvements → one row per (date, kind), upsert.
//     hourly                          → many rows per date, append.

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

const TODO_TAB     = 'ToDo'
const ACTIVITY_TAB = 'Activity'
const TODO_HEADERS = ['id','parent_id','title','done','position','created_at','updated_at'] as const
const ACT_HEADERS  = ['id','date','kind','time','content','created_at'] as const

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToDoItem {
  id:        string
  parentId:  string   // '' for top-level
  title:     string
  done:      boolean
  position:  number
  createdAt: string
  updatedAt: string
}

export type ActivityKind = 'top_task' | 'hourly' | 'wins' | 'improvements' | 'reminder'

export interface ActivityEntry {
  id:        string
  date:      string         // YYYY-MM-DD
  kind:      ActivityKind
  time:      string         // HH:MM or ''
  content:   string
  createdAt: string
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

function auth(json = false): Record<string, string> {
  const t = GAuth.getToken()
  if (!t) throw new Error('Not authenticated')
  const h: Record<string, string> = { Authorization: `Bearer ${t}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

function sid(): string {
  const id = Config.sheetId
  if (!id) throw new Error('Sheet ID not configured')
  return id
}

async function expectOk(res: Response, label: string): Promise<unknown> {
  if (res.ok) return res.json().catch(() => ({}))
  const err = await res.text().catch(() => '')
  throw new Error(`${label} failed: ${res.status} ${err.slice(0, 200)}`)
}

function uuid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const _tabsEnsured = new Set<string>()

async function ensureTab(name: string, headers: readonly string[]): Promise<void> {
  const key = `${sid()}|${name}`
  if (_tabsEnsured.has(key)) return
  const res = await fetch(`${BASE}/${sid()}?fields=sheets.properties.title`, { headers: auth() })
  if (!res.ok) return
  const data = await res.json() as { sheets?: { properties?: { title?: string } }[] }
  const have = (data.sheets ?? []).map(s => s.properties?.title ?? '')
  if (!have.includes(name)) {
    await fetch(`${BASE}/${sid()}:batchUpdate`, {
      method:  'POST', headers: auth(true),
      body:    JSON.stringify({ requests: [{ addSheet: { properties: { title: name } } }] }),
    }).then(r => expectOk(r, `Add ${name} tab`))
    const lastCol = String.fromCharCode(65 + headers.length - 1)
    await fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${name}!A1:${lastCol}1`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(true), body: JSON.stringify({ values: [headers as unknown as string[]] }) },
    ).then(r => expectOk(r, `Init ${name} headers`))
  }
  _tabsEnsured.add(key)
}

async function readRows(name: string, range: string): Promise<string[][]> {
  const r = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${name}!${range}`)}`,
    { headers: auth() },
  )
  if (!r.ok) return []
  const d = await r.json() as { values?: string[][] }
  return d.values ?? []
}

async function writeRow(name: string, range: string, values: string[]): Promise<void> {
  await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${name}!${range}`)}?valueInputOption=RAW`,
    { method: 'PUT', headers: auth(true), body: JSON.stringify({ values: [values] }) },
  ).then(r => expectOk(r, `Write ${name}!${range}`))
}

async function appendRow(name: string, lastCol: string, values: string[]): Promise<void> {
  await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${name}!A:${lastCol}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: auth(true), body: JSON.stringify({ values: [values] }) },
  ).then(r => expectOk(r, `Append ${name}`))
}

async function findRowByCol0(name: string, id: string): Promise<number> {
  const rows = await readRows(name, 'A:A')
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === id) return i + 1
  }
  return -1
}

async function getTabSheetId(name: string): Promise<number> {
  const r = await fetch(`${BASE}/${sid()}?fields=sheets.properties(sheetId,title)`, { headers: auth() })
  const d = await r.json() as { sheets: { properties: { sheetId: number; title: string } }[] }
  const p = d.sheets.find(s => s.properties.title === name)?.properties
  if (!p) throw new Error(`${name} tab not found`)
  return p.sheetId
}

async function deleteRowsByIds(name: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const sheetId = await getTabSheetId(name)
  const rows = await readRows(name, 'A:A')
  const idx: number[] = []
  rows.forEach((r, i) => { if (i > 0 && ids.includes(r[0])) idx.push(i) })
  if (idx.length === 0) return
  idx.sort((a, b) => b - a)
  await fetch(`${BASE}/${sid()}:batchUpdate`, {
    method:  'POST', headers: auth(true),
    body:    JSON.stringify({
      requests: idx.map(i => ({
        deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } },
      })),
    }),
  }).then(r => expectOk(r, `Delete rows in ${name}`))
}

// ── ToDo CRUD ────────────────────────────────────────────────────────────────

export async function loadToDos(): Promise<ToDoItem[]> {
  await ensureTab(TODO_TAB, TODO_HEADERS)
  const rows = await readRows(TODO_TAB, 'A2:G')
  return rows
    .filter(r => r[0])
    .map(r => ({
      id:        r[0],
      parentId:  r[1] ?? '',
      title:     r[2] ?? '',
      done:      (r[3] ?? '').toLowerCase() === 'true',
      position:  parseInt(r[4] ?? '0', 10) || 0,
      createdAt: r[5] ?? '',
      updatedAt: r[6] ?? '',
    }))
}

export async function addToDo(parentId: string, title: string): Promise<ToDoItem> {
  await ensureTab(TODO_TAB, TODO_HEADERS)
  const all = await loadToDos()
  const siblings = all.filter(t => t.parentId === parentId)
  const position = siblings.length === 0 ? 0 : Math.max(...siblings.map(t => t.position)) + 1
  const now = new Date().toISOString()
  const item: ToDoItem = {
    id: uuid('t'), parentId,
    title:     title.trim() || 'New task',
    done:      false,
    position,
    createdAt: now, updatedAt: now,
  }
  await appendRow(TODO_TAB, 'G', [
    item.id, item.parentId, item.title, String(item.done),
    String(item.position), item.createdAt, item.updatedAt,
  ])
  return item
}

export async function updateToDo(item: ToDoItem): Promise<void> {
  await ensureTab(TODO_TAB, TODO_HEADERS)
  const idx = await findRowByCol0(TODO_TAB, item.id)
  if (idx < 0) throw new Error('ToDo row not found')
  const updated = { ...item, updatedAt: new Date().toISOString() }
  await writeRow(TODO_TAB, `A${idx}:G${idx}`, [
    updated.id, updated.parentId, updated.title, String(updated.done),
    String(updated.position), updated.createdAt, updated.updatedAt,
  ])
}

export async function deleteToDo(id: string): Promise<void> {
  await ensureTab(TODO_TAB, TODO_HEADERS)
  const all = await loadToDos()
  // Recursive: collect this id + every descendant.
  const childrenOf = new Map<string, string[]>()
  all.forEach(t => {
    const list = childrenOf.get(t.parentId) ?? []
    list.push(t.id)
    childrenOf.set(t.parentId, list)
  })
  const targets: string[] = []
  const stack = [id]
  while (stack.length) {
    const x = stack.pop()!
    targets.push(x)
    ;(childrenOf.get(x) ?? []).forEach(c => stack.push(c))
  }
  await deleteRowsByIds(TODO_TAB, targets)
}

// ── Activity CRUD ────────────────────────────────────────────────────────────

// Read every activity row — used by the 3-pane Activity Log to power the
// Recent / Reminder / Priority side panel and per-day markers on the
// calendar. Cheap for typical usage (few hundred rows).
export async function loadAllActivities(): Promise<ActivityEntry[]> {
  await ensureTab(ACTIVITY_TAB, ACT_HEADERS)
  const rows = await readRows(ACTIVITY_TAB, 'A2:F')
  return rows
    .filter(r => r[0])
    .map(r => ({
      id:        r[0],
      date:      r[1] ?? '',
      kind:      (['top_task','hourly','wins','improvements','reminder'].includes(r[2]) ? r[2] : 'hourly') as ActivityKind,
      time:      r[3] ?? '',
      content:   r[4] ?? '',
      createdAt: r[5] ?? '',
    }))
}

// Append a free-form reminder for a date.
export async function addReminder(date: string, content: string): Promise<ActivityEntry> {
  await ensureTab(ACTIVITY_TAB, ACT_HEADERS)
  const now = new Date().toISOString()
  const e: ActivityEntry = {
    id: uuid('a'), date, kind: 'reminder', time: '', content: content.trim(), createdAt: now,
  }
  await appendRow(ACTIVITY_TAB, 'F', [e.id, e.date, e.kind, e.time, e.content, e.createdAt])
  return e
}

export async function loadActivityForDate(date: string): Promise<ActivityEntry[]> {
  await ensureTab(ACTIVITY_TAB, ACT_HEADERS)
  const rows = await readRows(ACTIVITY_TAB, 'A2:F')
  return rows
    .filter(r => r[0] && r[1] === date)
    .map(r => ({
      id:        r[0],
      date:      r[1] ?? '',
      kind:      (['top_task','hourly','wins','improvements'].includes(r[2]) ? r[2] : 'hourly') as ActivityKind,
      time:      r[3] ?? '',
      content:   r[4] ?? '',
      createdAt: r[5] ?? '',
    }))
}

export async function addHourlyActivity(date: string, time: string, content: string): Promise<ActivityEntry> {
  await ensureTab(ACTIVITY_TAB, ACT_HEADERS)
  const now = new Date().toISOString()
  const e: ActivityEntry = {
    id: uuid('a'), date, kind: 'hourly', time: time.trim(), content: content.trim(), createdAt: now,
  }
  await appendRow(ACTIVITY_TAB, 'F', [e.id, e.date, e.kind, e.time, e.content, e.createdAt])
  return e
}

// Upsert one of (top_task | wins | improvements) per (date, kind).
export async function upsertSingleton(date: string, kind: ActivityKind, content: string): Promise<ActivityEntry> {
  await ensureTab(ACTIVITY_TAB, ACT_HEADERS)
  const rows = await readRows(ACTIVITY_TAB, 'A2:F')
  const idx = rows.findIndex(r => r[1] === date && r[2] === kind)
  const now = new Date().toISOString()
  if (idx < 0) {
    const e: ActivityEntry = {
      id: uuid('a'), date, kind, time: '', content: content.trim(), createdAt: now,
    }
    await appendRow(ACTIVITY_TAB, 'F', [e.id, e.date, e.kind, e.time, e.content, e.createdAt])
    return e
  }
  const existing = rows[idx]
  const rowNum = idx + 2
  const updated: ActivityEntry = {
    id:        existing[0],
    date,
    kind,
    time:      '',
    content:   content.trim(),
    createdAt: existing[5] ?? now,
  }
  await writeRow(ACTIVITY_TAB, `A${rowNum}:F${rowNum}`, [
    updated.id, updated.date, updated.kind, updated.time, updated.content, updated.createdAt,
  ])
  return updated
}

export async function deleteActivity(id: string): Promise<void> {
  await ensureTab(ACTIVITY_TAB, ACT_HEADERS)
  await deleteRowsByIds(ACTIVITY_TAB, [id])
}
