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
import { idbGet, idbPut, idbDel } from '../lib/idb'
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
// had open a minute ago should not stare at a spinner, so the list and the recent
// bodies are mirrored locally and rendered immediately while the real fetch
// revalidates behind them.
//
// This lives in IndexedDB rather than localStorage. A pad with a drawing carries
// stroke JSON plus baked SVG and runs to hundreds of KB; against localStorage's
// ~5 MB shared cliff that meant refusing to cache exactly the pads slowest to
// load. IndexedDB has room, so there is no per-body ceiling any more — only a cap
// on how many pads are kept, because a pad opened once last year should not be
// held forever.
//
// Reads are therefore async. That is a microtask and a few ms against a network
// round trip, so it is still the difference between a spinner and no spinner.

const STORE = 'scratch'
const K_LIST  = 'list'
const K_INDEX = 'index'                        // { [id]: { at, modifiedTime } }
const bodyKey = (id: string) => `body:${id}`

/** How many bodies to keep. The pad you want is nearly always the last one. */
const CACHE_MAX_PADS = 20

interface CachedBody { html: string; modifiedTime: string; at: number }
type CacheIndex = Record<string, { at: number; modifiedTime: string }>

export function cachedScratchList(): Promise<ScratchPad[] | null> {
  return idbGet<ScratchPad[]>(STORE, K_LIST).then(v => Array.isArray(v) ? v : null)
}
export function putScratchList(list: ScratchPad[]): void {
  void idbPut(STORE, K_LIST, list)
}

/** The cached body plus the modifiedTime it was fetched at, so a caller can tell
 *  a fresh hit from one the Drive listing has already moved past. */
export function cachedScratchBody(id: string): Promise<CachedBody | null> {
  return idbGet<CachedBody>(STORE, bodyKey(id))
}

// Fire and forget. Eviction reads only the index — a few hundred bytes — rather
// than every cached body, which is the whole reason the index exists.
export function putScratchBody(id: string, html: string, modifiedTime: string): void {
  void (async () => {
    const at = Date.now()
    await idbPut(STORE, bodyKey(id), { html, modifiedTime, at } satisfies CachedBody)
    const index: CacheIndex = (await idbGet<CacheIndex>(STORE, K_INDEX)) ?? {}
    index[id] = { at, modifiedTime }
    const stale = Object.keys(index)
      .sort((a, b) => index[b].at - index[a].at)
      .slice(CACHE_MAX_PADS)
    for (const old of stale) {
      delete index[old]
      await idbDel(STORE, bodyKey(old))
    }
    await idbPut(STORE, K_INDEX, index)
  })()
}

export function dropScratchBody(id: string): void {
  void (async () => {
    await idbDel(STORE, bodyKey(id))
    const index = await idbGet<CacheIndex>(STORE, K_INDEX)
    if (!index || !(id in index)) return
    delete index[id]
    await idbPut(STORE, K_INDEX, index)
  })()
}

// ── Which pad to reopen ──────────────────────────────────────────────────────
// Stays in localStorage on purpose. It is one short string read on the resume
// path before anything else can start, and it is the one value here that a
// synchronous read genuinely buys something: the pad begins opening in the same
// tick the panel does, rather than after a database handshake.

const LS_LAST = 'pghtech_scratch_last'

export function lastScratchId(): string | null {
  try { return localStorage.getItem(LS_LAST) } catch { return null }
}
export function setLastScratchId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LS_LAST, id)
    else    localStorage.removeItem(LS_LAST)
  } catch { /* private mode */ }
}

// The pre-IndexedDB cache. Nothing is migrated — it is a cache, and IndexedDB
// refills on the next open — but the old keys held real space, so drop them.
try {
  localStorage.removeItem('pghtech_scratch_list')
  localStorage.removeItem('pghtech_scratch_body')
} catch { /* private mode */ }
