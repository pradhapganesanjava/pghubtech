// DART — Daily Activity & Results Tracker.
//
// Unlike the other Utils tools (which live as tabs in the user's *main*
// spreadsheet), DART keeps everything in its own Drive folder so the tracker
// can be shared, backed up or wiped independently of the knowledge hub:
//
//   Drive/PGHubTechDART/DART   ← one spreadsheet, five tabs
//
//     Blocks!    id, title, subtitle, position, created_at, updated_at
//     Routines!  id, block_id, title, minutes, position, active, created_at, updated_at
//     Goals!     id, title, notes, start_date, end_date, frequency,
//                target_minutes, priority, active, created_at, updated_at,
//                target_units, unit_label
//     Log!       id, date, kind, ref_id, title, minutes, done_at, units
//     Thoughts!  id, date, raw, bucket, summary, highlights, created_at,
//                updated_at, path, rich, raw_original
//     Journal!   one row per DATE — the day written up, cleaned, and split into
//                a timeline plus the day's reflection. Structured fields that
//                are lists or records ride as JSON in a single cell.
//     JournalInsights! generated summaries over a window, kept so a report can
//                be re-read rather than regenerated.
//
// Log holds one row per completion (kind ∈ {routine, goal}); un-ticking a
// routine deletes its row, so "done today" is always a straight sum over the
// rows that exist rather than a mutable flag that can drift.

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'
import { getOrCreateFolder } from '../lib/drive'

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3/files'

export const DART_FOLDER = 'PGHubTechDART'
const DART_DOC = 'DART'

const BLOCKS_TAB   = 'Blocks'
const ROUTINES_TAB = 'Routines'
const GOALS_TAB    = 'Goals'
const LOG_TAB      = 'Log'
const THOUGHTS_TAB = 'Thoughts'
const CONFIG_TAB   = 'Config'
const JOURNAL_TAB  = 'Journal'
const JINSIGHT_TAB = 'JournalInsights'

const BLOCK_HEADERS   = ['id','title','subtitle','position','created_at','updated_at'] as const
const ROUTINE_HEADERS = ['id','block_id','title','minutes','position','active','created_at','updated_at'] as const
// target_units / unit_label and Log.units are appended at the END so a store
// written before they existed still reads back cleanly (missing cells → 0/'').
const GOAL_HEADERS    = ['id','title','notes','start_date','end_date','frequency','target_minutes','priority','active','created_at','updated_at','target_units','unit_label'] as const
const LOG_HEADERS     = ['id','date','kind','ref_id','title','minutes','done_at','units'] as const
const THOUGHT_HEADERS = ['id','date','raw','bucket','summary','highlights','created_at','updated_at','path','rich','raw_original'] as const
const JOURNAL_HEADERS = ['id','date','raw','raw_original','wake_time','sleep_time','timeline','went_right','went_wrong','expected','reality','fixing','worked','summary','created_at','updated_at'] as const
const JINSIGHT_HEADERS = ['id','from_date','to_date','label','days_covered','rich','created_at'] as const
const CONFIG_HEADERS = ['key','value','notes'] as const

const TABS: [string, readonly string[]][] = [
  [BLOCKS_TAB, BLOCK_HEADERS], [ROUTINES_TAB, ROUTINE_HEADERS], [GOALS_TAB, GOAL_HEADERS],
  [LOG_TAB, LOG_HEADERS], [THOUGHTS_TAB, THOUGHT_HEADERS],
  [JOURNAL_TAB, JOURNAL_HEADERS], [JINSIGHT_TAB, JINSIGHT_HEADERS],
  [CONFIG_TAB, CONFIG_HEADERS],
]

// ── Types ────────────────────────────────────────────────────────────────────

export interface DartBlock {
  id: string; title: string; subtitle: string; position: number
  createdAt: string; updatedAt: string
}

export interface DartRoutine {
  id: string; blockId: string; title: string; minutes: number
  position: number; active: boolean; createdAt: string; updatedAt: string
}

// 'total' = the target covers the whole start→end window rather than repeating.
export type GoalFrequency = 'daily' | 'weekly' | 'monthly' | 'total'
export type GoalPriority  = 'must' | 'could'

export interface DartGoal {
  id: string; title: string; notes: string
  startDate: string          // YYYY-MM-DD
  endDate: string            // YYYY-MM-DD, tentative — '' means open-ended
  frequency: GoalFrequency
  // The two verticals, tracked separately and never averaged. Either may be 0,
  // meaning "not targeted on this axis" — a goal can chase problems with no
  // hour budget, hours with no countable output, or both.
  targetMinutes: number      // minutes to spend per period
  targetUnits:   number      // countable output per period
  unitLabel:     string      // 'problems', 'topics', … (plural, user's words)
  priority: GoalPriority     // the floor; pace can escalate 'could' → 'must'
  active: boolean; createdAt: string; updatedAt: string
}

export type LogKind = 'routine' | 'goal'

export interface DartLogEntry {
  id: string; date: string; kind: LogKind
  refId: string; title: string; minutes: number; doneAt: string
  units: number
}

// Buckets are user-editable data now, so this is a plain string.
export type ThoughtBucket = string

export interface DartThought {
  id: string; date: string
  // `raw` is the readable version: same words, same order, fillers and stutters
  // removed and grammar lightly fixed — never restructured or summarised.
  // `rawOriginal` keeps the untouched capture so a bad clean-up is recoverable.
  raw: string
  rawOriginal: string
  bucket: ThoughtBucket
  summary: string
  highlights: string[]
  path: string               // '::'-delimited tree path, max 4 segments
  rich: string               // generated HTML rendering (sanitised on display)
  createdAt: string; updatedAt: string
}

// Tree paths are '::'-delimited, like the tag paths in Docs / AdsHub, and are
// capped so the left-nav tree can never grow past four levels.
export const MAX_PATH_DEPTH = 4

// Taxonomy defaults. These exist ONLY to seed the Config tab the first time
// the store is opened — after that the sheet is the source of truth and these
// are never read again, so a root or a bucket is added by editing the sheet
// rather than by shipping code. See dartConfig() / loadDartConfig().
export const DEFAULT_THOUGHT_ROOTS = ['Business', 'Career', 'Learning']
export const DEFAULT_THOUGHT_BUCKETS = [
  'Lessons Learned', 'Process Improvement', 'Productivity',
  'Tips', 'Tricks', 'Strategies', 'Goal', 'Other',
]

export function normalisePath(raw: string): string {
  return (raw || '')
    .split('::')
    // Strip stray colons an odd separator leaves behind (':::' would otherwise
    // yield a segment like ': C'), then drop anything that empties out.
    .map(p => p.trim().replace(/^:+|:+$/g, '').trim())
    .filter(Boolean)
    .slice(0, MAX_PATH_DEPTH)
    .join('::')
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

function auth(json = false): Record<string, string> {
  const t = GAuth.getToken()
  if (!t) throw new Error('Not authenticated')
  const h: Record<string, string> = { Authorization: `Bearer ${t}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

async function expectOk(res: Response, label: string): Promise<unknown> {
  if (res.ok) return res.json().catch(() => ({}))
  const err = await res.text().catch(() => '')
  throw new Error(`${label} failed: ${res.status} ${err.slice(0, 200)}`)
}

function uuid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function colLetter(n: number): string { return String.fromCharCode(64 + n) }

// Resolve (and on first use, create + seed) the DART spreadsheet. The id is
// cached in localStorage so day-to-day loads skip the Drive lookup entirely.
let _docPromise: Promise<string> | null = null

export function dartDocId(): string { return Config.dartSheetId }

async function doc(): Promise<string> {
  const cached = Config.dartSheetId
  if (cached) return cached
  if (!_docPromise) _docPromise = resolveDoc().catch(e => { _docPromise = null; throw e })
  return _docPromise
}

async function resolveDoc(): Promise<string> {
  const token    = GAuth.getToken()
  if (!token) throw new Error('Not authenticated')
  const folderId = await getOrCreateFolder(token, DART_FOLDER)

  const q   = `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet'`
            + ` and name='${DART_DOC}' and trashed=false`
  const res = await GAuth.fetch(
    `${DRIVE_BASE}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
    { headers: auth() },
  )
  const found = await expectOk(res, 'Find DART sheet') as { files?: { id: string }[] }
  if (found.files?.length) {
    Config.dartSheetId = found.files[0].id
    return found.files[0].id
  }

  // First run — create the spreadsheet with every tab, move it into the
  // folder, write headers, and seed the default routine.
  const cr = await GAuth.fetch(SHEETS_BASE, {
    method:  'POST',
    headers: auth(true),
    body:    JSON.stringify({
      properties: { title: DART_DOC },
      sheets:     TABS.map(([title]) => ({ properties: { title } })),
    }),
  })
  const created = await expectOk(cr, 'Create DART sheet') as { spreadsheetId: string }
  const id = created.spreadsheetId

  await GAuth.fetch(`${DRIVE_BASE}/${id}?addParents=${folderId}&removeParents=root&fields=id`, {
    method: 'PATCH', headers: auth(true),
  }).then(r => expectOk(r, 'Move DART sheet to folder'))

  await GAuth.fetch(`${SHEETS_BASE}/${id}/values:batchUpdate`, {
    method:  'POST', headers: auth(true),
    body:    JSON.stringify({
      valueInputOption: 'RAW',
      data: TABS.map(([title, headers]) => ({
        range:  `${title}!A1:${colLetter(headers.length)}1`,
        values: [headers as unknown as string[]],
      })),
    }),
  }).then(r => expectOk(r, 'Init DART headers'))

  Config.dartSheetId = id
  await seedDefaults(id)
  _schemaPromise = Promise.resolve()   // just written — no reconciliation needed
  return id
}

// Headers are written once, when the spreadsheet is created — so a store made
// before a column was added keeps a short header row. Every read/write here is
// positional, so the data is still correct, but the sheet stops describing
// itself and the drift compounds with each new column. This reconciles the
// header row once per session: cheap, idempotent, and it means adding a column
// to the *_HEADERS lists above is all a future migration needs.
let _schemaPromise: Promise<void> | null = null

async function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = reconcileHeaders().catch(e => { _schemaPromise = null; throw e })
  }
  return _schemaPromise
}

async function reconcileHeaders(): Promise<void> {
  const id = await doc()

  // A store created before a tab existed simply has no such sheet, and a
  // values.batchGet naming a missing range fails outright — so tabs are added
  // before headers are compared. Together these two steps mean a new tab or a
  // new column needs nothing but an entry in TABS above.
  const meta = await GAuth.fetch(`${SHEETS_BASE}/${id}?fields=sheets.properties.title`, { headers: auth() })
  if (!meta.ok) return
  const have = new Set(
    ((await meta.json() as { sheets?: { properties?: { title?: string } }[] }).sheets ?? [])
      .map(sh => sh.properties?.title ?? ''))
  const missing = TABS.filter(([tab]) => !have.has(tab))
  if (missing.length > 0) {
    const added = await GAuth.fetch(`${SHEETS_BASE}/${id}:batchUpdate`, {
      method:  'POST', headers: auth(true),
      body:    JSON.stringify({
        requests: missing.map(([title]) => ({ addSheet: { properties: { title } } })),
      }),
    })
    if (!added.ok) return
  }

  const ranges = TABS.map(([tab, h]) => `${tab}!A1:${colLetter(h.length)}1`)
  const qs  = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&')
  const res = await GAuth.fetch(`${SHEETS_BASE}/${id}/values:batchGet?${qs}`, { headers: auth() })
  if (!res.ok) return   // never block a load on a cosmetic repair
  const data = await res.json() as { valueRanges?: { values?: string[][] }[] }

  const stale = TABS
    .map(([tab, headers], i) => {
      const have = data.valueRanges?.[i]?.values?.[0] ?? []
      const want = headers as unknown as string[]
      const ok   = want.every((h, j) => have[j] === h)
      return ok ? null : {
        range:  `${tab}!A1:${colLetter(want.length)}1`,
        values: [want],
      }
    })
    .filter((x): x is { range: string; values: string[][] } => x !== null)

  if (stale.length === 0) return
  await GAuth.fetch(`${SHEETS_BASE}/${id}/values:batchUpdate`, {
    method:  'POST', headers: auth(true),
    body:    JSON.stringify({ valueInputOption: 'RAW', data: stale }),
  }).catch(() => {})
}

async function readRows(tab: string, range: string): Promise<string[][]> {
  await ensureSchema()
  const id = await doc()
  const r  = await GAuth.fetch(
    `${SHEETS_BASE}/${id}/values/${encodeURIComponent(`${tab}!${range}`)}`,
    { headers: auth() },
  )
  if (!r.ok) return []
  const d = await r.json() as { values?: string[][] }
  return d.values ?? []
}

async function appendRows(tab: string, lastCol: string, rows: string[][]): Promise<void> {
  if (rows.length === 0) return
  await ensureSchema()
  const id = await doc()
  await GAuth.fetch(
    `${SHEETS_BASE}/${id}/values/${encodeURIComponent(`${tab}!A:${lastCol}`)}`
    + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
    { method: 'POST', headers: auth(true), body: JSON.stringify({ values: rows }) },
  ).then(r => expectOk(r, `Append ${tab}`))
}

async function writeRow(tab: string, rowIdx: number, values: string[]): Promise<void> {
  await ensureSchema()
  const id    = await doc()
  const range = `${tab}!A${rowIdx}:${colLetter(values.length)}${rowIdx}`
  await GAuth.fetch(
    `${SHEETS_BASE}/${id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: 'PUT', headers: auth(true), body: JSON.stringify({ values: [values] }) },
  ).then(r => expectOk(r, `Write ${range}`))
}

// 1-based sheet row for a record id, or -1.
async function rowOf(tab: string, id: string): Promise<number> {
  const rows = await readRows(tab, 'A:A')
  for (let i = 0; i < rows.length; i++) if (rows[i][0] === id) return i + 1
  return -1
}

async function tabSheetId(tab: string): Promise<number> {
  const id = await doc()
  const r  = await GAuth.fetch(`${SHEETS_BASE}/${id}?fields=sheets.properties(sheetId,title)`, { headers: auth() })
  const d  = await r.json() as { sheets: { properties: { sheetId: number; title: string } }[] }
  const p  = d.sheets.find(s => s.properties.title === tab)?.properties
  if (!p) throw new Error(`${tab} tab not found`)
  return p.sheetId
}

async function deleteRowsByIds(tab: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const docId   = await doc()
  const sheetId = await tabSheetId(tab)
  const rows    = await readRows(tab, 'A:A')
  const idx: number[] = []
  rows.forEach((r, i) => { if (i > 0 && ids.includes(r[0])) idx.push(i) })
  if (idx.length === 0) return
  idx.sort((a, b) => b - a)   // bottom-up so earlier indices stay valid
  await GAuth.fetch(`${SHEETS_BASE}/${docId}:batchUpdate`, {
    method:  'POST', headers: auth(true),
    body:    JSON.stringify({
      requests: idx.map(i => ({
        deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } },
      })),
    }),
  }).then(r => expectOk(r, `Delete rows in ${tab}`))
}

const num  = (s: string | undefined, d = 0) => { const n = parseInt(s ?? '', 10); return Number.isFinite(n) ? n : d }
const bool = (s: string | undefined, d = true) => (s ?? '') === '' ? d : (s ?? '').toLowerCase() === 'true'

// ── Seed ─────────────────────────────────────────────────────────────────────

// The starting routine, straight from how the user already runs the day. It is
// written once, on the run that creates the spreadsheet — after that the tabs
// are the source of truth and this never fires again, so edits stick.
const SEED: { title: string; subtitle: string; items: [string, number][] }[] = [
  {
    title:    'Early Morning',
    subtitle: 'before the day asks anything of you',
    items: [
      ['Meditate / Visualize', 15],
      ['Say Gratitude',         5],
      ['Read',                 15],
      ['Lightup',               5],
      ['Exercise - Core',      20],
    ],
  },
  {
    title:    'Night Before Bed',
    subtitle: 'close the day out properly so tomorrow starts early',
    items: [
      ['Journal',     15],
      ['Review Day',  10],
      ['Meditate',    10],
      ['Gratitude',    5],
      ['Deep Sleep',   0],
    ],
  },
]

async function seedDefaults(docId: string): Promise<void> {
  const now = new Date().toISOString()
  const blockRows:   string[][] = []
  const routineRows: string[][] = []

  SEED.forEach((b, bi) => {
    const blockId = uuid('db')
    blockRows.push([blockId, b.title, b.subtitle, String(bi), now, now])
    b.items.forEach(([title, minutes], ri) => {
      routineRows.push([uuid('dr'), blockId, title, String(minutes), String(ri), 'true', now, now])
    })
  })

  await GAuth.fetch(`${SHEETS_BASE}/${docId}/values:batchUpdate`, {
    method:  'POST', headers: auth(true),
    body:    JSON.stringify({
      valueInputOption: 'RAW',
      data: [
        { range: `${BLOCKS_TAB}!A2`,   values: blockRows },
        { range: `${ROUTINES_TAB}!A2`, values: routineRows },
      ],
    }),
  }).then(r => expectOk(r, 'Seed DART routine'))
}

// ── Blocks ───────────────────────────────────────────────────────────────────

export async function loadBlocks(): Promise<DartBlock[]> {
  const rows = await readRows(BLOCKS_TAB, 'A2:F')
  return rows.filter(r => r[0]).map(r => ({
    id: r[0], title: r[1] ?? '', subtitle: r[2] ?? '',
    position: num(r[3]), createdAt: r[4] ?? '', updatedAt: r[5] ?? '',
  })).sort((a, b) => a.position - b.position)
}

export async function addBlock(title: string, subtitle = ''): Promise<DartBlock> {
  const existing = await loadBlocks()
  const position = existing.length === 0 ? 0 : Math.max(...existing.map(b => b.position)) + 1
  const now = new Date().toISOString()
  const b: DartBlock = { id: uuid('db'), title, subtitle, position, createdAt: now, updatedAt: now }
  await appendRows(BLOCKS_TAB, 'F', [[b.id, b.title, b.subtitle, String(b.position), now, now]])
  return b
}

export async function updateBlock(b: DartBlock): Promise<DartBlock> {
  const row = await rowOf(BLOCKS_TAB, b.id)
  if (row < 0) throw new Error('Block not found')
  const updated = { ...b, updatedAt: new Date().toISOString() }
  await writeRow(BLOCKS_TAB, row, [
    updated.id, updated.title, updated.subtitle, String(updated.position),
    updated.createdAt, updated.updatedAt,
  ])
  return updated
}

// Removes the block and every routine inside it, so the Today view can never
// show orphaned items pointing at a block that no longer renders.
export async function deleteBlock(id: string): Promise<void> {
  const routines = await loadRoutines()
  await deleteRowsByIds(ROUTINES_TAB, routines.filter(r => r.blockId === id).map(r => r.id))
  await deleteRowsByIds(BLOCKS_TAB, [id])
}

// ── Routines ─────────────────────────────────────────────────────────────────

export async function loadRoutines(): Promise<DartRoutine[]> {
  const rows = await readRows(ROUTINES_TAB, 'A2:H')
  return rows.filter(r => r[0]).map(r => ({
    id: r[0], blockId: r[1] ?? '', title: r[2] ?? '', minutes: num(r[3]),
    position: num(r[4]), active: bool(r[5]), createdAt: r[6] ?? '', updatedAt: r[7] ?? '',
  })).sort((a, b) => a.position - b.position)
}

export async function addRoutine(blockId: string, title: string, minutes: number): Promise<DartRoutine> {
  const all      = await loadRoutines()
  const siblings = all.filter(r => r.blockId === blockId)
  const position = siblings.length === 0 ? 0 : Math.max(...siblings.map(r => r.position)) + 1
  const now = new Date().toISOString()
  const r: DartRoutine = { id: uuid('dr'), blockId, title, minutes, position, active: true, createdAt: now, updatedAt: now }
  await appendRows(ROUTINES_TAB, 'H', [[
    r.id, r.blockId, r.title, String(r.minutes), String(r.position), 'true', now, now,
  ]])
  return r
}

export async function updateRoutine(r: DartRoutine): Promise<DartRoutine> {
  const row = await rowOf(ROUTINES_TAB, r.id)
  if (row < 0) throw new Error('Routine not found')
  const updated = { ...r, updatedAt: new Date().toISOString() }
  await writeRow(ROUTINES_TAB, row, [
    updated.id, updated.blockId, updated.title, String(updated.minutes),
    String(updated.position), String(updated.active), updated.createdAt, updated.updatedAt,
  ])
  return updated
}

export async function deleteRoutine(id: string): Promise<void> {
  await deleteRowsByIds(ROUTINES_TAB, [id])
}

// ── Goals ────────────────────────────────────────────────────────────────────

export async function loadGoals(): Promise<DartGoal[]> {
  const rows = await readRows(GOALS_TAB, 'A2:M')
  return rows.filter(r => r[0]).map(r => ({
    id: r[0], title: r[1] ?? '', notes: r[2] ?? '',
    startDate: r[3] ?? '', endDate: r[4] ?? '',
    frequency: (r[5] as GoalFrequency) || 'daily',
    targetMinutes: num(r[6]),
    priority: (r[7] as GoalPriority) || 'could',
    active: bool(r[8]), createdAt: r[9] ?? '', updatedAt: r[10] ?? '',
    targetUnits: num(r[11]), unitLabel: r[12] ?? '',
  }))
}

function goalRow(g: DartGoal): string[] {
  return [
    g.id, g.title, g.notes, g.startDate, g.endDate, g.frequency,
    String(g.targetMinutes), g.priority, String(g.active), g.createdAt, g.updatedAt,
    String(g.targetUnits), g.unitLabel,
  ]
}

export async function addGoal(g: Omit<DartGoal, 'id' | 'createdAt' | 'updatedAt'>): Promise<DartGoal> {
  const now     = new Date().toISOString()
  const created: DartGoal = { ...g, id: uuid('dg'), createdAt: now, updatedAt: now }
  await appendRows(GOALS_TAB, 'M', [goalRow(created)])
  return created
}

export async function updateGoal(g: DartGoal): Promise<DartGoal> {
  const row = await rowOf(GOALS_TAB, g.id)
  if (row < 0) throw new Error('Goal not found')
  const updated = { ...g, updatedAt: new Date().toISOString() }
  await writeRow(GOALS_TAB, row, goalRow(updated))
  return updated
}

export async function deleteGoal(id: string): Promise<void> {
  await deleteRowsByIds(GOALS_TAB, [id])
}

// ── Log ──────────────────────────────────────────────────────────────────────

function parseLog(rows: string[][]): DartLogEntry[] {
  return rows.filter(r => r[0]).map(r => ({
    id: r[0], date: r[1] ?? '', kind: (r[2] as LogKind) || 'routine',
    refId: r[3] ?? '', title: r[4] ?? '', minutes: num(r[5]), doneAt: r[6] ?? '',
    units: num(r[7]),
  }))
}

export async function loadLog(): Promise<DartLogEntry[]> {
  return parseLog(await readRows(LOG_TAB, 'A2:H'))
}

// Everything from `from` to `to` inclusive (YYYY-MM-DD sorts lexically, so a
// string compare is the right comparison here).
export async function loadLogInRange(from: string, to: string): Promise<DartLogEntry[]> {
  const all = await loadLog()
  return all.filter(e => e.date >= from && e.date <= to)
}

export async function addLogEntry(
  date: string, kind: LogKind, refId: string, title: string,
  minutes: number, units = 0,
): Promise<DartLogEntry> {
  const e: DartLogEntry = {
    id: uuid('dl'), date, kind, refId, title, minutes, units,
    doneAt: new Date().toISOString(),
  }
  await appendRows(LOG_TAB, 'H', [[
    e.id, e.date, e.kind, e.refId, e.title, String(e.minutes), e.doneAt, String(e.units),
  ]])
  return e
}

export async function deleteLogEntries(ids: string[]): Promise<void> {
  await deleteRowsByIds(LOG_TAB, ids)
}

// ── Thoughts ─────────────────────────────────────────────────────────────────

export async function loadThoughts(): Promise<DartThought[]> {
  const rows = await readRows(THOUGHTS_TAB, 'A2:K')
  return rows.filter(r => r[0]).map(r => ({
    id: r[0], date: r[1] ?? '', raw: r[2] ?? '',
    bucket: (r[3] as ThoughtBucket) || 'Other',
    summary: r[4] ?? '',
    highlights: (r[5] ?? '').split('\n').map(s => s.trim()).filter(Boolean),
    createdAt: r[6] ?? '', updatedAt: r[7] ?? '',
    path: normalisePath(r[8] ?? ''),
    rich: r[9] ?? '',
    // Older rows predate the clean-up step: their raw IS the original.
    rawOriginal: r[10] || r[2] || '',
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function thoughtRow(t: DartThought): string[] {
  return [
    t.id, t.date, t.raw, t.bucket, t.summary,
    t.highlights.join('\n'), t.createdAt, t.updatedAt,
    t.path, t.rich, t.rawOriginal,
  ]
}

export async function addThought(
  fields: Omit<DartThought, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<DartThought> {
  const now = new Date().toISOString()
  const t: DartThought = {
    ...fields, path: normalisePath(fields.path),
    id: uuid('dt'), createdAt: now, updatedAt: now,
  }
  await appendRows(THOUGHTS_TAB, 'K', [thoughtRow(t)])
  return t
}

export async function updateThought(t: DartThought): Promise<DartThought> {
  const row = await rowOf(THOUGHTS_TAB, t.id)
  if (row < 0) throw new Error('Thought not found')
  const updated = {
    ...t, path: normalisePath(t.path), updatedAt: new Date().toISOString(),
  }
  await writeRow(THOUGHTS_TAB, row, thoughtRow(updated))
  return updated
}

export async function deleteThought(id: string): Promise<void> {
  await deleteRowsByIds(THOUGHTS_TAB, [id])
}

// ── Journal ──────────────────────────────────────────────────────────────────

export type BandKey = string

export interface DayBand {
  key: BandKey; label: string; from: number; to: number; hint: string
}

// The day, split the way it is actually lived. `to` is exclusive, and night
// runs to midnight. Seeded into Config on first open, edited in the sheet after.
export const DEFAULT_DAY_BANDS: DayBand[] = [
  { key: 'early',     label: 'Early Morning', from: 0,  to: 7,  hint: 'before 7' },
  { key: 'morning',   label: 'Morning',       from: 7,  to: 12, hint: '7 – 11' },
  { key: 'afternoon', label: 'Afternoon',     from: 12, to: 17, hint: '12 – 4' },
  { key: 'evening',   label: 'Evening',       from: 17, to: 20, hint: '5 – 8' },
  { key: 'night',     label: 'Night',         from: 20, to: 24, hint: '8 – midnight' },
]

export function bandForHour(h: number): BandKey {
  const b = dartConfig().dayBands.find(x => h >= x.from && h < x.to)
  return b?.key ?? 'night'
}

export interface TimelineItem {
  band:    BandKey
  from:    string     // 'HH:MM' or '' when only a band is known
  to:      string
  minutes: number     // 0 when no duration was stated
  title:   string
  detail:  string
}

export interface JournalEntry {
  id:          string
  date:        string        // YYYY-MM-DD — one entry per day
  raw:         string        // cleaned capture
  rawOriginal: string        // exactly what was dictated or typed
  wakeTime:    string        // 'HH:MM' or ''
  sleepTime:   string
  timeline:    TimelineItem[]
  wentRight:   string[]
  wentWrong:   string[]
  expected:    string        // what the day was meant to be
  reality:     string        // what it actually was
  fixing:      string[]      // habits / tasks being worked on
  worked:      string[]      // habits / strategies that paid off
  summary:     string
  createdAt:   string
  updatedAt:   string
}

export type JournalFields = Omit<JournalEntry, 'id' | 'createdAt' | 'updatedAt'>

// Lists and records ride as JSON in one cell rather than spreading across
// columns — the shape changes as the extractor improves, and a sheet full of
// half-used columns would be worse than one opaque-but-stable field.
function jparse<T>(cell: string | undefined, fallback: T): T {
  if (!cell) return fallback
  try { return JSON.parse(cell) as T } catch { return fallback }
}
const lines = (c: string | undefined) =>
  (c ?? '').split('\n').map(x => x.trim()).filter(Boolean)

export async function loadJournal(): Promise<JournalEntry[]> {
  const rows = await readRows(JOURNAL_TAB, 'A2:P')
  return rows.filter(r => r[0]).map(r => ({
    id: r[0], date: r[1] ?? '', raw: r[2] ?? '', rawOriginal: r[3] || r[2] || '',
    wakeTime: r[4] ?? '', sleepTime: r[5] ?? '',
    timeline: jparse<TimelineItem[]>(r[6], []),
    wentRight: lines(r[7]), wentWrong: lines(r[8]),
    expected: r[9] ?? '', reality: r[10] ?? '',
    fixing: lines(r[11]), worked: lines(r[12]),
    summary: r[13] ?? '', createdAt: r[14] ?? '', updatedAt: r[15] ?? '',
  })).sort((a, b) => b.date.localeCompare(a.date))
}

function journalRow(e: JournalEntry): string[] {
  return [
    e.id, e.date, e.raw, e.rawOriginal, e.wakeTime, e.sleepTime,
    JSON.stringify(e.timeline),
    e.wentRight.join('\n'), e.wentWrong.join('\n'),
    e.expected, e.reality,
    e.fixing.join('\n'), e.worked.join('\n'),
    e.summary, e.createdAt, e.updatedAt,
  ]
}

// One entry per date: writing a day that already exists replaces it rather
// than stacking a second row, so the calendar can never show a day twice.
export async function saveJournal(fields: JournalFields): Promise<JournalEntry> {
  const now = new Date().toISOString()
  const existing = (await loadJournal()).find(e => e.date === fields.date)
  if (existing) {
    const updated: JournalEntry = { ...existing, ...fields, updatedAt: now }
    const row = await rowOf(JOURNAL_TAB, existing.id)
    if (row < 0) throw new Error('Journal entry not found')
    await writeRow(JOURNAL_TAB, row, journalRow(updated))
    return updated
  }
  const created: JournalEntry = { ...fields, id: uuid('dj'), createdAt: now, updatedAt: now }
  await appendRows(JOURNAL_TAB, 'P', [journalRow(created)])
  return created
}

export async function deleteJournal(id: string): Promise<void> {
  await deleteRowsByIds(JOURNAL_TAB, [id])
}

// ── Journal insights ─────────────────────────────────────────────────────────

export interface JournalInsight {
  id:          string
  fromDate:    string
  toDate:      string
  label:       string      // the window as chosen, e.g. 'Last 30 days'
  daysCovered: number
  rich:        string      // generated HTML, sanitised on display
  createdAt:   string
}

export async function loadInsights(): Promise<JournalInsight[]> {
  const rows = await readRows(JINSIGHT_TAB, 'A2:G')
  return rows.filter(r => r[0]).map(r => ({
    id: r[0], fromDate: r[1] ?? '', toDate: r[2] ?? '', label: r[3] ?? '',
    daysCovered: num(r[4]), rich: r[5] ?? '', createdAt: r[6] ?? '',
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function addInsight(
  i: Omit<JournalInsight, 'id' | 'createdAt'>,
): Promise<JournalInsight> {
  const created: JournalInsight = { ...i, id: uuid('ji'), createdAt: new Date().toISOString() }
  await appendRows(JINSIGHT_TAB, 'G', [[
    created.id, created.fromDate, created.toDate, created.label,
    String(created.daysCovered), created.rich, created.createdAt,
  ]])
  return created
}

export async function deleteInsight(id: string): Promise<void> {
  await deleteRowsByIds(JINSIGHT_TAB, [id])
}

// ── Config ───────────────────────────────────────────────────────────────────
//
// Everything the app treats as taxonomy — thought roots, buckets, the day's
// time bands — lives in the Config tab, not in this file. The DEFAULT_* values
// above seed the tab the first time the store is opened; from then on the sheet
// is authoritative and editing it there is how the vocabulary changes.
//
// A synchronous accessor backs rendering (dartConfig()), refreshed by an async
// load (loadDartConfig()) the views call on mount.

export interface DartConfig {
  thoughtRoots:   string[]
  thoughtBuckets: string[]
  dayBands:       DayBand[]
}

const CONFIG_SEED: { key: string; value: string; notes: string }[] = [
  { key: 'thought_roots', value: DEFAULT_THOUGHT_ROOTS.join('\n'),
    notes: 'Top-level groups a thought can be filed under. One per line.' },
  { key: 'thought_buckets', value: DEFAULT_THOUGHT_BUCKETS.join('\n'),
    notes: 'Bucket options on a thought. One per line.' },
  { key: 'day_bands', value: JSON.stringify(DEFAULT_DAY_BANDS),
    notes: 'Journal time bands. JSON: [{key,label,from,to,hint}], to is exclusive.' },
]

let _config: DartConfig = {
  thoughtRoots:   [...DEFAULT_THOUGHT_ROOTS],
  thoughtBuckets: [...DEFAULT_THOUGHT_BUCKETS],
  dayBands:       [...DEFAULT_DAY_BANDS],
}
let _configPromise: Promise<DartConfig> | null = null

/** Current config. Defaults until loadDartConfig() has run once. */
export function dartConfig(): DartConfig { return _config }

export async function loadDartConfig(force = false): Promise<DartConfig> {
  if (force) _configPromise = null
  if (!_configPromise) {
    _configPromise = readConfig().catch(e => { _configPromise = null; throw e })
  }
  return _configPromise
}

async function readConfig(): Promise<DartConfig> {
  const rows = await readRows(CONFIG_TAB, 'A2:C')
  const have = new Map(rows.filter(r => r[0]).map(r => [r[0], r[1] ?? '']))

  // Seed any key the sheet does not carry yet, so a store written before a
  // setting existed picks it up without a migration.
  const missing = CONFIG_SEED.filter(k => !have.has(k.key))
  if (missing.length > 0) {
    await appendRows(CONFIG_TAB, 'C', missing.map(k => [k.key, k.value, k.notes]))
    for (const k of missing) have.set(k.key, k.value)
  }

  const list = (key: string, fallback: string[]) => {
    const v = (have.get(key) ?? '').split('\n').map(x => x.trim()).filter(Boolean)
    return v.length > 0 ? v : fallback
  }
  let bands = [...DEFAULT_DAY_BANDS]
  try {
    const parsed = JSON.parse(have.get('day_bands') || '[]') as DayBand[]
    // A malformed edit must not leave the journal with no bands at all.
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(b => b?.key && typeof b.from === 'number')) {
      bands = parsed
    }
  } catch { /* keep the defaults */ }

  _config = {
    thoughtRoots:   list('thought_roots',   DEFAULT_THOUGHT_ROOTS),
    thoughtBuckets: list('thought_buckets', DEFAULT_THOUGHT_BUCKETS),
    dayBands:       bands,
  }
  return _config
}
