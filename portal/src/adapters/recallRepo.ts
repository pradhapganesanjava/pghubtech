// Recall — the quiz/drill deck behind AdsHub's 🎯 Quiz / Recall page.
//
// Where Point2Rem stores *prose* you reread, a Recall card is a **question you
// answer from memory**: the small reusable trick ("a window holds consecutive
// numbers iff a[j]-a[i]+1 === j-i+1") or the pattern confusion worth drilling
// ("this looks like DFS+memo — when is greedy actually correct?").
//
// One row per card in the "Recall" sheet tab — its own tab, Point2Rem and the
// problem archive are untouched. The body lives in the row (not a Drive file)
// for the same reason Point2Rem's does: cards are short, and keeping them in
// the cell makes them editable straight from the Sheet as well as the portal.
//
// The bundled public/recall.json is the SEED: when the tab doesn't exist yet
// it's created and populated from that file, so a fresh sheet starts with the
// shipped drills instead of an empty deck.

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const TAB  = 'Recall'

const HEADERS = [
  'id',          // stable slug (PK)
  'question',    // the prompt — plain text, one or two lines
  'hint',        // optional nudge, revealed before the answer
  'answer',      // markdown (or HTML when format = html)
  'kind',        // 'trick' | 'confusion' | 'concept'
  'tags',        // "; "-joined :: paths
  'problems',    // "; "-joined LC frontend ids
  'points',      // "; "-joined Point2Rem ids
  'links',       // one per line: "label | url"
  'format',      // 'md' | 'html'
  'updated_at',
] as const

const COL_RANGE = 'A2:K'
const BLANK_ROW = HEADERS.map(() => '')

// Google Sheets caps a cell at 50,000 characters. Fail loudly below that
// rather than let the API truncate an answer silently.
export const RECALL_MAX_ANSWER = 45_000

export type RecallKind = 'trick' | 'confusion' | 'concept'

export const RECALL_KINDS: RecallKind[] = ['trick', 'confusion', 'concept']

// Label + glyph per kind, shared by the deck badge and the editor pills so the
// two never drift.
export const RECALL_KIND_META: Record<RecallKind, { label: string; icon: string; blurb: string }> = {
  trick:     { label: 'Trick',     icon: '⚡', blurb: 'A small reusable move that shortens the code' },
  confusion: { label: 'Confusion', icon: '🌓', blurb: 'Two patterns that look alike — which one, and why' },
  concept:   { label: 'Concept',   icon: '🧠', blurb: 'An idea worth being able to restate cold' },
}

export interface RecallLink {
  label?: string
  url:    string
}

export interface RecallItem {
  id:       string
  question: string
  hint:     string
  answer:   string            // markdown unless format === 'html'
  kind:     RecallKind
  tags:     string[]          // ::-hierarchical; [] ⇒ grouped under "untagged"
  problems: string[]          // LC frontend ids this card was learned from
  points:   string[]          // Point2Rem ids that expand on it
  links:    RecallLink[]
  format:   'md' | 'html'
  updated:  string
}

// Cards with no tags group under this synthetic path so they stay visible
// instead of silently dropping out of the deck's grouping.
export const RECALL_UNTAGGED = 'untagged'

export function emptyRecallItem(): RecallItem {
  return {
    id: '', question: '', hint: '', answer: '', kind: 'trick',
    tags: [], problems: [], points: [], links: [], format: 'md', updated: '',
  }
}

export function slugifyRecallId(s: string): string {
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

const asKind = (s: string | undefined): RecallKind => {
  const k = (s ?? '').toLowerCase().trim()
  return (RECALL_KINDS as string[]).includes(k) ? k as RecallKind : 'trick'
}

// Links are newline-separated "label | url" (a bare url is fine too) — labels
// may contain ";" so the "; " convention used for the flat lists won't do.
function parseLinks(s: string | undefined): RecallLink[] {
  const out: RecallLink[] = []
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

const stringifyLinks = (links: RecallLink[]): string =>
  links.map(l => l.label ? `${l.label} | ${l.url}` : l.url).join('\n')

function rowToItem(r: string[]): RecallItem | null {
  if (!r[0]) return null
  return {
    id:       r[0],
    question: r[1] || r[0],
    hint:     r[2] ?? '',
    answer:   r[3] ?? '',
    kind:     asKind(r[4]),
    tags:     splitList(r[5]),
    problems: splitList(r[6]),
    points:   splitList(r[7]),
    links:    parseLinks(r[8]),
    format:   (r[9] ?? '').toLowerCase() === 'html' ? 'html' : 'md',
    updated:  r[10] ?? '',
  }
}

const itemToRow = (i: RecallItem): string[] => [
  i.id, i.question, i.hint, i.answer, i.kind, i.tags.join('; '),
  i.problems.join('; '), i.points.join('; '), stringifyLinks(i.links),
  i.format, i.updated,
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
      // Only ever seeded on the tab's first creation — deleting every card
      // later must NOT resurrect the shipped ones.
      await seedFromBundledJson()
    }
    _tabEnsured = true
  })().finally(() => { _tabPending = null })
  return _tabPending
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []

function normalizeSeed(raw: unknown, idx: number): RecallItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const question = String(r.question ?? '').trim()
  const answer   = String(r.answer ?? '')
  if (!question && !answer) return null
  const links: RecallLink[] = []
  if (Array.isArray(r.links)) {
    for (const l of r.links) {
      if (typeof l === 'string') { links.push({ url: l }); continue }
      if (l && typeof l === 'object') {
        const url = String((l as RecallLink).url ?? '').trim()
        if (!url) continue
        const label = String((l as RecallLink).label ?? '').trim()
        links.push(label ? { label, url } : { url })
      }
    }
  }
  return {
    id: String(r.id ?? '').trim() || slugifyRecallId(question) || `recall-${idx + 1}`,
    question: question || `Card ${idx + 1}`,
    hint: String(r.hint ?? '').trim(),
    answer,
    kind: asKind(r.kind as string),
    tags: asStrings(r.tags),
    problems: asStrings(r.problems),
    points: asStrings(r.points),
    links,
    format: String(r.format ?? '').toLowerCase() === 'html' ? 'html' : 'md',
    updated: String(r.updated ?? '').trim(),
  }
}

async function seedFromBundledJson(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}recall.json`)
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
  } catch { /* seeding is best-effort — an empty deck is still usable */ }
}

// ── Load ─────────────────────────────────────────────────────────────────────

let _cache: RecallItem[] | null = null

export function getCachedRecall(): RecallItem[] | null {
  return _cache
}

export async function loadRecall(force = false): Promise<RecallItem[]> {
  if (_cache && !force) return _cache
  await ensureTab()
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!${COL_RANGE}`)}`, { headers: auth() },
  )
  if (!res.ok) throw new Error(`Recall: ${res.status} ${res.statusText}`)
  const data = await res.json() as { values?: string[][] }
  const out: RecallItem[] = []
  const seen = new Set<string>()
  for (const r of (data.values ?? [])) {
    const item = rowToItem(r)
    if (!item) continue
    // Ids drive the deck position and the ?recall= deep link; a duplicate
    // would make two cards answer to the same link.
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  _cache = out
  return out
}

// ── Write ────────────────────────────────────────────────────────────────────

// 1-based sheet row for an id, or -1. Read fresh (not from _cache) so a card
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

// Create or update one card. `id` is assigned from the question when blank,
// and de-duplicated against what's already loaded. Returns the saved card.
export async function saveRecall(item: RecallItem): Promise<RecallItem> {
  await ensureTab()
  const question = item.question.trim()
  if (!question) throw new Error('Question is required')
  if (item.answer.length > RECALL_MAX_ANSWER) {
    throw new Error(`Answer is ${item.answer.length.toLocaleString()} chars — the sheet caps a cell at ${RECALL_MAX_ANSWER.toLocaleString()}`)
  }

  let id = item.id.trim()
  if (!id) {
    const base = slugifyRecallId(question) || 'card'
    const taken = new Set((_cache ?? []).map(i => i.id))
    id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  }

  const saved: RecallItem = {
    ...item, id, question,
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
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A${rowNum}:K${rowNum}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values }) },
    )
  }

  // Keep the module cache in step so the deck re-renders without a refetch.
  const next = [...(_cache ?? [])]
  const at = next.findIndex(i => i.id === id)
  if (at < 0) next.push(saved); else next[at] = saved
  _cache = next
  return saved
}

// Delete a card: blank its row (rowToItem skips rows with no id, and blanking
// avoids re-indexing every row below it).
export async function deleteRecall(id: string): Promise<void> {
  await ensureTab()
  const rowNum = await findRowNum(id)
  if (rowNum >= 0) {
    await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A${rowNum}:K${rowNum}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [BLANK_ROW] }) },
    )
  }
  _cache = (_cache ?? []).filter(i => i.id !== id)
}
