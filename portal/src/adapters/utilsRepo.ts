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

const TODO_TAB         = 'ToDo'
const ACTIVITY_TAB     = 'Activity'
const LESSONS_TAB      = 'Lessons'
const TODO_COMMENTS_TAB = 'ToDoComments'
const TODO_HEADERS    = ['id','parent_id','title','done','position','created_at','updated_at','description'] as const
const ACT_HEADERS     = ['id','date','kind','time','content','created_at'] as const
const LESSONS_HEADERS = ['id','problem','not_worked','worked','source','created_at','updated_at'] as const
const TODO_COMMENT_HEADERS = ['id','todo_id','content','created_at','updated_at'] as const

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToDoItem {
  id:          string
  parentId:    string   // '' for top-level
  title:       string
  done:        boolean
  position:    number
  createdAt:   string
  updatedAt:   string
  description: string   // long-form info / what the item means
}

export interface ToDoComment {
  id:        string
  todoId:    string
  content:   string
  createdAt: string
  updatedAt: string
}

export type ActivityKind =
  | 'top_task' | 'hourly' | 'wins' | 'improvements' | 'reminder'
  | 'not_worked' | 'raw'

export interface ActivityEntry {
  id:        string
  date:      string         // YYYY-MM-DD
  kind:      ActivityKind
  time:      string         // HH:MM or ''
  content:   string
  createdAt: string
}

export interface Lesson {
  id:         string
  problem:    string
  notWorked:  string
  worked:     string
  source:     string         // 'manual' | 'ai:YYYY-MM-DD..YYYY-MM-DD'
  createdAt:  string
  updatedAt:  string
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
  const rows = await readRows(TODO_TAB, 'A2:H')
  return rows
    .filter(r => r[0])
    .map(r => ({
      id:          r[0],
      parentId:    r[1] ?? '',
      title:       r[2] ?? '',
      done:        (r[3] ?? '').toLowerCase() === 'true',
      position:    parseInt(r[4] ?? '0', 10) || 0,
      createdAt:   r[5] ?? '',
      updatedAt:   r[6] ?? '',
      description: r[7] ?? '',
    }))
}

export async function addToDo(parentId: string, title: string, description = ''): Promise<ToDoItem> {
  await ensureTab(TODO_TAB, TODO_HEADERS)
  const all = await loadToDos()
  const siblings = all.filter(t => t.parentId === parentId)
  const position = siblings.length === 0 ? 0 : Math.max(...siblings.map(t => t.position)) + 1
  const now = new Date().toISOString()
  const item: ToDoItem = {
    id: uuid('t'), parentId,
    title:       title.trim() || 'New task',
    done:        false,
    position,
    createdAt:   now,
    updatedAt:   now,
    description: description.trim(),
  }
  await appendRow(TODO_TAB, 'H', [
    item.id, item.parentId, item.title, String(item.done),
    String(item.position), item.createdAt, item.updatedAt, item.description,
  ])
  return item
}

// Batched insert for a whole tree (used by the AI Generate flow). One Sheets
// :append call instead of one-per-row, so deep trees don't hit the 60/min
// write-quota. Walks the recursive shape, pre-generates ids so children
// carry their parent's id, and returns the flat list of created items in
// DFS order.
export interface ToDoDraftInput {
  title:       string
  description?: string
  children?:   ToDoDraftInput[]
}

export async function appendToDoTreeBatch(
  drafts: ToDoDraftInput[],
  rootParentId = '',
): Promise<ToDoItem[]> {
  await ensureTab(TODO_TAB, TODO_HEADERS)
  if (drafts.length === 0) return []
  const all = await loadToDos()
  const posByParent = new Map<string, number>()
  for (const t of all) {
    const cur = posByParent.get(t.parentId) ?? -1
    if (t.position > cur) posByParent.set(t.parentId, t.position)
  }
  const now = new Date().toISOString()
  const out:  ToDoItem[] = []
  const rows: string[][] = []
  function walk(list: ToDoDraftInput[], parentId: string) {
    for (const d of list) {
      const pos = (posByParent.get(parentId) ?? -1) + 1
      posByParent.set(parentId, pos)
      const item: ToDoItem = {
        id:          uuid('t'),
        parentId,
        title:       (d.title || 'New task').trim(),
        done:        false,
        position:    pos,
        createdAt:   now,
        updatedAt:   now,
        description: (d.description ?? '').trim(),
      }
      out.push(item)
      rows.push([
        item.id, item.parentId, item.title, String(item.done),
        String(item.position), item.createdAt, item.updatedAt, item.description,
      ])
      if (d.children && d.children.length > 0) walk(d.children, item.id)
    }
  }
  walk(drafts, rootParentId)
  await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TODO_TAB}!A:H`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: auth(true), body: JSON.stringify({ values: rows }) },
  ).then(r => expectOk(r, 'Append ToDos batch'))
  return out
}

export async function updateToDo(item: ToDoItem): Promise<void> {
  await ensureTab(TODO_TAB, TODO_HEADERS)
  const idx = await findRowByCol0(TODO_TAB, item.id)
  if (idx < 0) throw new Error('ToDo row not found')
  const updated = { ...item, updatedAt: new Date().toISOString() }
  await writeRow(TODO_TAB, `A${idx}:H${idx}`, [
    updated.id, updated.parentId, updated.title, String(updated.done),
    String(updated.position), updated.createdAt, updated.updatedAt, updated.description ?? '',
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
      kind:      (['top_task','hourly','wins','improvements','reminder','not_worked','raw'].includes(r[2]) ? r[2] : 'hourly') as ActivityKind,
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
      kind:      (['top_task','hourly','wins','improvements','reminder','not_worked','raw'].includes(r[2]) ? r[2] : 'hourly') as ActivityKind,
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

// ── Lessons CRUD ─────────────────────────────────────────────────────────────

export async function loadLessons(): Promise<Lesson[]> {
  await ensureTab(LESSONS_TAB, LESSONS_HEADERS)
  const rows = await readRows(LESSONS_TAB, 'A2:G')
  return rows
    .filter(r => r[0])
    .map(r => ({
      id:        r[0],
      problem:   r[1] ?? '',
      notWorked: r[2] ?? '',
      worked:    r[3] ?? '',
      source:    r[4] ?? 'manual',
      createdAt: r[5] ?? '',
      updatedAt: r[6] ?? '',
    }))
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
}

export async function addLesson(input: {
  problem: string; notWorked: string; worked: string; source?: string
}): Promise<Lesson> {
  await ensureTab(LESSONS_TAB, LESSONS_HEADERS)
  const now = new Date().toISOString()
  const l: Lesson = {
    id:        uuid('l'),
    problem:   input.problem.trim(),
    notWorked: input.notWorked.trim(),
    worked:    input.worked.trim(),
    source:    input.source ?? 'manual',
    createdAt: now,
    updatedAt: now,
  }
  await appendRow(LESSONS_TAB, 'G', [
    l.id, l.problem, l.notWorked, l.worked, l.source, l.createdAt, l.updatedAt,
  ])
  return l
}

export async function updateLesson(l: Lesson): Promise<Lesson> {
  await ensureTab(LESSONS_TAB, LESSONS_HEADERS)
  const idx = await findRowByCol0(LESSONS_TAB, l.id)
  if (idx < 0) throw new Error('Lesson row not found')
  const updated: Lesson = { ...l, updatedAt: new Date().toISOString() }
  await writeRow(LESSONS_TAB, `A${idx}:G${idx}`, [
    updated.id, updated.problem, updated.notWorked, updated.worked,
    updated.source, updated.createdAt, updated.updatedAt,
  ])
  return updated
}

export async function deleteLesson(id: string): Promise<void> {
  await ensureTab(LESSONS_TAB, LESSONS_HEADERS)
  await deleteRowsByIds(LESSONS_TAB, [id])
}

// Read activities for an inclusive date range (used to feed AI lesson generation).
export async function loadActivitiesInRange(from: string, to: string): Promise<ActivityEntry[]> {
  const all = await loadAllActivities()
  return all
    .filter(e => e.date >= from && e.date <= to)
    .sort((a, b) => (a.date + a.time + a.createdAt).localeCompare(b.date + b.time + b.createdAt))
}

// ── ToDo comments (progress log per todo) ────────────────────────────────────

export async function loadAllToDoComments(): Promise<ToDoComment[]> {
  await ensureTab(TODO_COMMENTS_TAB, TODO_COMMENT_HEADERS)
  const rows = await readRows(TODO_COMMENTS_TAB, 'A2:E')
  return rows
    .filter(r => r[0])
    .map(r => ({
      id:        r[0],
      todoId:    r[1] ?? '',
      content:   r[2] ?? '',
      createdAt: r[3] ?? '',
      updatedAt: r[4] ?? '',
    }))
}

export async function addToDoComment(todoId: string, content: string): Promise<ToDoComment> {
  await ensureTab(TODO_COMMENTS_TAB, TODO_COMMENT_HEADERS)
  const now = new Date().toISOString()
  const c: ToDoComment = {
    id: uuid('c'), todoId,
    content:   content.trim(),
    createdAt: now,
    updatedAt: now,
  }
  await appendRow(TODO_COMMENTS_TAB, 'E', [c.id, c.todoId, c.content, c.createdAt, c.updatedAt])
  return c
}

export async function updateToDoComment(c: ToDoComment): Promise<ToDoComment> {
  await ensureTab(TODO_COMMENTS_TAB, TODO_COMMENT_HEADERS)
  const idx = await findRowByCol0(TODO_COMMENTS_TAB, c.id)
  if (idx < 0) throw new Error('Comment not found')
  const updated: ToDoComment = { ...c, updatedAt: new Date().toISOString() }
  await writeRow(TODO_COMMENTS_TAB, `A${idx}:E${idx}`, [
    updated.id, updated.todoId, updated.content, updated.createdAt, updated.updatedAt,
  ])
  return updated
}

export async function deleteToDoComment(id: string): Promise<void> {
  await ensureTab(TODO_COMMENTS_TAB, TODO_COMMENT_HEADERS)
  await deleteRowsByIds(TODO_COMMENTS_TAB, [id])
}
