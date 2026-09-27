// Scratch Pad — quick notes that belong to nobody in particular.
//
//   Drive folder    PGHubTechScratch/
//     ├─ 2026-09-06 15-42.html      ← one file per pad
//     └─ Kafka rebalance.html          (renamed by the user)
//
// Deliberately NOT the Notes store. A Note is a Sheet per note with a node
// tree, which is the right shape for something you organise and come back to.
// A scratch pad is one page you open mid-thought, so it is one Drive file
// holding the same note-body HTML the problem notes use — rich text plus an
// optional `.hw-doc` handwriting block. That keeps the same editor (Rich /
// HTML / Preview / Draw) working over it with no conversion, and rename is
// just a Drive rename.

import { GAuth } from '../lib/gauth'
import {
  getOrCreateFolder,
  uploadFileToDrive,
  updateDriveFileContent,
  fetchDriveFile,
  deleteDriveFile,
} from '../lib/drive'

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files'
export const SCRATCH_FOLDER = 'PGHubTechScratch'
const EXT = '.html'

export interface ScratchPad {
  id:           string
  name:         string      // without the .html suffix
  modifiedTime: string
}

function token(): string {
  const t = GAuth.getToken()
  if (!t) throw new Error('Not signed in')
  return t
}

/** "2026-09-06 15-42" — sorts chronologically and is legal in a filename. */
export function defaultScratchName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}-${p(d.getMinutes())}`
}

const stripExt = (n: string) => n.endsWith(EXT) ? n.slice(0, -EXT.length) : n

async function folderId(): Promise<string> {
  return getOrCreateFolder(token(), SCRATCH_FOLDER)
}

/** Newest first — a scratch pad is nearly always the one you just had open. */
export async function listScratch(): Promise<ScratchPad[]> {
  const q = `'${await folderId()}' in parents and trashed=false`
  const url = `${DRIVE_BASE}?q=${encodeURIComponent(q)}` +
              `&fields=${encodeURIComponent('files(id,name,modifiedTime)')}` +
              `&orderBy=modifiedTime desc&pageSize=200`
  const r = await GAuth.fetch(url)
  if (!r.ok) throw new Error(`Couldn't list scratch pads (${r.status})`)
  const data = await r.json() as { files?: { id: string; name: string; modifiedTime: string }[] }
  return (data.files ?? []).map(f => ({ id: f.id, name: stripExt(f.name), modifiedTime: f.modifiedTime }))
}

export async function createScratch(name = defaultScratchName(), html = ''): Promise<ScratchPad> {
  const { id } = await uploadFileToDrive(
    token(), await folderId(),
    new Blob([html], { type: 'text/html' }),
    `${name}${EXT}`, 'text/html',
  )
  return { id, name, modifiedTime: new Date().toISOString() }
}

export async function loadScratch(id: string): Promise<string> {
  return (await fetchDriveFile(token(), id)).text()
}

export async function saveScratch(id: string, html: string): Promise<void> {
  await updateDriveFileContent(token(), id, new Blob([html], { type: 'text/html' }))
}

export async function renameScratch(id: string, name: string): Promise<void> {
  const r = await GAuth.fetch(`${DRIVE_BASE}/${id}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${name}${EXT}` }),
  })
  if (!r.ok) throw new Error(`Rename failed (${r.status})`)
}

export async function deleteScratch(id: string): Promise<void> {
  await deleteDriveFile(token(), id)
}

// ── Local cache ──────────────────────────────────────────────────────────────
// A pad is one Drive file, and Drive is a round trip away. Reopening the pad you
// had open a minute ago should not stare at a spinner, so the list and the last
// few bodies are mirrored to localStorage and rendered immediately while the
// real fetch revalidates behind them.
//
// Bounded on purpose. A pad with a drawing carries stroke JSON plus baked SVG
// and can run to hundreds of KB, and localStorage is a ~5 MB cliff shared with
// everything else the app keeps there — so oversized bodies are simply not
// cached (they still load from Drive, just without the head start), and only the
// few most recent are kept. Every write is guarded: a cache that cannot be
// written is a missing optimisation, never an error the user should see.

const LS_LIST = 'pghtech_scratch_list'
const LS_BODY = 'pghtech_scratch_body'
const LS_LAST = 'pghtech_scratch_last'

/** Bodies past this are left uncached rather than risking the whole quota. */
const CACHE_MAX_BYTES = 400_000
/** How many bodies to keep. The pad you want is nearly always the last one. */
const CACHE_MAX_PADS = 3

interface CachedBody { html: string; modifiedTime: string; at: number }

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch { return null }
}
function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) }
  catch {
    // Almost certainly the quota. Drop the bodies — the biggest thing here and
    // the only part that is pure optimisation — and let the next write retry.
    try { localStorage.removeItem(LS_BODY) } catch { /* nothing left to try */ }
  }
}

export function cachedScratchList(): ScratchPad[] | null {
  const v = readJson<ScratchPad[]>(LS_LIST)
  return Array.isArray(v) ? v : null
}
export function putScratchList(list: ScratchPad[]): void {
  writeJson(LS_LIST, list)
}

/** The cached body plus the modifiedTime it was fetched at, so a caller can
 *  tell a fresh cache hit from one the Drive list has already moved past. */
export function cachedScratchBody(id: string): CachedBody | null {
  const all = readJson<Record<string, CachedBody>>(LS_BODY)
  return all?.[id] ?? null
}
export function putScratchBody(id: string, html: string, modifiedTime: string): void {
  if (html.length > CACHE_MAX_BYTES) { dropScratchBody(id); return }
  const all = readJson<Record<string, CachedBody>>(LS_BODY) ?? {}
  all[id] = { html, modifiedTime, at: Date.now() }
  const ids = Object.keys(all).sort((a, b) => all[b].at - all[a].at)
  for (const stale of ids.slice(CACHE_MAX_PADS)) delete all[stale]
  writeJson(LS_BODY, all)
}
export function dropScratchBody(id: string): void {
  const all = readJson<Record<string, CachedBody>>(LS_BODY)
  if (!all || !(id in all)) return
  delete all[id]
  writeJson(LS_BODY, all)
}

/** The pad to reopen next time. Cleared when that pad is deleted. */
export function lastScratchId(): string | null {
  try { return localStorage.getItem(LS_LAST) } catch { return null }
}
export function setLastScratchId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LS_LAST, id)
    else    localStorage.removeItem(LS_LAST)
  } catch { /* private mode */ }
}
