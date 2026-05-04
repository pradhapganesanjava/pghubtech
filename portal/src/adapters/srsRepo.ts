import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'

const BASE    = 'https://sheets.googleapis.com/v4/spreadsheets'
const TAB     = 'SRS_Progress'
const HEADERS = ['note_id','template_id','deck','state','interval_days','ease','reps','lapses','last_reviewed','next_due']

const LS_KEY = 'pghub_srs'

export interface SRSRecord {
  noteId:       string
  templateId:   string
  deck:         string
  state:        'new' | 'learning' | 'review'
  intervalDays: number
  ease:         number
  reps:         number
  lapses:       number
  lastReviewed: string
  nextDue:      string   // YYYY-MM-DD
}

export type Rating = 0 | 1 | 2 | 3   // Again | Hard | Good | Easy

export const RATING_LABELS: Record<Rating, string> = {
  0: 'Again',
  1: 'Hard',
  2: 'Good',
  3: 'Easy',
}

// ── localStorage cache helpers ────────────────────────────────────────────────

function loadCacheMap(): Map<string, SRSRecord> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, SRSRecord>
    return new Map(Object.entries(obj))
  } catch { return new Map() }
}

function saveCacheMap(map: Map<string, SRSRecord>): void {
  try {
    const obj: Record<string, SRSRecord> = {}
    map.forEach((v, k) => { obj[k] = v })
    localStorage.setItem(LS_KEY, JSON.stringify(obj))
  } catch {}
}

/** Synchronous read from localStorage cache only — for queue building */
export function getAllSRS(): Map<string, SRSRecord> {
  return loadCacheMap()
}

// ── Sheets helpers ────────────────────────────────────────────────────────────

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

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function addDays(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

let _tabEnsured    = false
let _tabPending:     Promise<void> | null = null
let _srsMapCache:    Map<string, SRSRecord> | null = null
let _srsMapPending:  Promise<Map<string, SRSRecord>> | null = null

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
        { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [HEADERS] }) }
      )
    }
    _tabEnsured = true
  })().finally(() => { _tabPending = null })
  return _tabPending
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchSRSMap(): Promise<Map<string, SRSRecord>> {
  const localMap = loadCacheMap()

  await ensureTab()
  const res = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A2:J')}`,
    { headers: auth() }
  )
  const data = await res.json() as { values?: string[][] }
  const sheetsMap = new Map<string, SRSRecord>()
  for (const r of data.values ?? []) {
    if (!r[0]) continue
    sheetsMap.set(r[0], {
      noteId:       r[0],
      templateId:   r[1] ?? '',
      deck:         r[2] ?? '',
      state:        (r[3] as SRSRecord['state']) ?? 'new',
      intervalDays: parseFloat(r[4] ?? '1'),
      ease:         parseFloat(r[5] ?? '2.5'),
      reps:         parseInt(r[6] ?? '0', 10),
      lapses:       parseInt(r[7] ?? '0', 10),
      lastReviewed: r[8] ?? '',
      nextDue:      r[9] ?? '',
    })
  }

  const merged = new Map<string, SRSRecord>(localMap)
  for (const [id, sheetsRec] of sheetsMap) {
    const local = merged.get(id)
    if (!local) {
      merged.set(id, sheetsRec)
    } else {
      const sheetTs = sheetsRec.lastReviewed ? new Date(sheetsRec.lastReviewed).getTime() : 0
      const localTs = local.lastReviewed     ? new Date(local.lastReviewed).getTime()     : 0
      if (sheetTs >= localTs) merged.set(id, sheetsRec)
    }
  }

  saveCacheMap(merged)
  _srsMapCache = merged
  return merged
}

/** Load SRS map from localStorage + sheets; deduplicates concurrent calls. */
export function loadSRSMap(): Promise<Map<string, SRSRecord>> {
  if (_srsMapCache) return Promise.resolve(_srsMapCache)
  if (_srsMapPending) return _srsMapPending
  _srsMapPending = fetchSRSMap()
    .catch(e  => { _srsMapPending = null; throw e })
    .finally(() => { _srsMapPending = null })
  return _srsMapPending
}

export function isDue(r: SRSRecord | undefined): boolean {
  if (!r || r.state === 'new') return true
  return r.nextDue <= todayStr()
}

export function computeNextSRS(
  existing: SRSRecord | undefined,
  noteId: string,
  templateId: string,
  deck: string,
  rating: Rating,
): SRSRecord {
  const base: SRSRecord = existing ?? {
    noteId, templateId, deck,
    state: 'new', intervalDays: 1, ease: 2.5, reps: 0, lapses: 0,
    lastReviewed: '', nextDue: '',
  }

  let { reps, ease, intervalDays, lapses } = base

  if (rating === 0) {
    return {
      ...base, state: 'learning', reps: 0,
      ease: Math.max(1.3, ease - 0.2), intervalDays: 1,
      lapses: lapses + 1,
      lastReviewed: new Date().toISOString(),
      nextDue: addDays(1),
    }
  }

  if (rating === 1) ease = Math.max(1.3, ease - 0.15)
  if (rating === 3) ease = Math.min(4.0, ease + 0.15)

  let interval: number
  if (reps === 0)      interval = 1
  else if (reps === 1) interval = 6
  else {
    interval = Math.round(intervalDays * ease)
    if (rating === 1) interval = Math.max(intervalDays + 1, Math.round(intervalDays * 1.2))
    if (rating === 3) interval = Math.round(interval * 1.3)
  }

  return {
    ...base, state: 'review',
    reps: reps + 1, ease, intervalDays: interval, lapses,
    lastReviewed: new Date().toISOString(),
    nextDue: addDays(interval),
  }
}

/** Writes to localStorage immediately; saves to sheets in background (fire-and-forget) */
export function setSRSRecord(record: SRSRecord): void {
  const map = loadCacheMap()
  map.set(record.noteId, record)
  saveCacheMap(map)
  if (_srsMapCache) _srsMapCache.set(record.noteId, record)  // keep in-memory cache consistent
  saveSRSRecord(record).catch(() => {})
}

export async function saveSRSRecord(record: SRSRecord): Promise<void> {
  await ensureTab()
  const row = [
    record.noteId, record.templateId, record.deck, record.state,
    String(record.intervalDays), String(record.ease),
    String(record.reps), String(record.lapses),
    record.lastReviewed, record.nextDue,
  ]

  const colARes = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A:A')}`,
    { headers: auth() }
  )
  const colAData = await colARes.json() as { values?: string[][] }
  const idx = (colAData.values ?? []).findIndex(r => r[0] === record.noteId)

  if (idx < 1) {
    await fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', headers: auth(), body: JSON.stringify({ values: [row] }) }
    )
  } else {
    const n = idx + 1
    await fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(TAB + `!A${n}:J${n}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [row] }) }
    )
  }
}

export function formatInterval(days: number): string {
  if (days <= 0) return '<1d'
  if (days === 1) return '1d'
  if (days < 30)  return `${days}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${Math.round(days / 365)}y`
}

/**
 * Returns 4 strings showing what interval would result from each rating
 * (Again/Hard/Good/Easy) given an existing record (or undefined for new card).
 */
export function previewIntervals(existing: SRSRecord | undefined): string[] {
  const ratings: Rating[] = [0, 1, 2, 3]
  return ratings.map(r => {
    const next = computeNextSRS(existing, '', '', '', r)
    return formatInterval(next.intervalDays)
  })
}
