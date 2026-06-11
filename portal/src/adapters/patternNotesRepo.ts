// Pattern notes adapter — user-authored, editable notes for the Patterns
// reference (Group By combos and DS/Topic micros). Deliberately ISOLATED from
// the Browse problem-notes feature (adsRepo): its own sheet tab + Drive folder,
// keyed by an arbitrary string `key` (e.g. "group/palindrome/ds/string" or
// "micro/two-sum-hash"). Mirrors adsRepo's note machinery (Drive HTML file +
// sheet index row) so editing behaves exactly like Browse notes.

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'
import { getOrCreateFolder, uploadFileToDrive, updateDriveFileContent, deleteDriveFile, DRIVE_API_PREFIX } from '../lib/drive'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const TAB  = 'PatternNotes'                  // NOT LCProblems — keeps Browse untouched
const NOTES_FOLDER = 'PGHubTechPatternNotes' // NOT PGHubTechAdsNotes
const HEADERS = ['key', 'drive_id', 'title', 'updated_at'] as const
const COL_RANGE = 'A2:D'

export interface PatternNoteMeta { key: string; driveId: string; title: string; updatedAt: string }

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

// Standalone HTML wrapper (same shape as adsRepo's note pages so the rendered
// note looks identical to a Browse note).
function wrapNoteHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pattern note</title>
<style>
  html,body{margin:0;padding:16px;background:#fff;color:#1a1a2e;
    font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  img{max-width:100%;height:auto;}
  pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;padding:10px;border-radius:6px;border:1px solid #e1e4e8;}
  code{background:#f6f8fa;padding:1px 5px;border-radius:3px;}
</style></head>
<body>${body}</body></html>`
}

const fileSafe = (key: string): string =>
  key.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'note'

// In-memory index of which keys have a note (key → meta). Loaded once.
let _index: Map<string, PatternNoteMeta> | null = null
export function getCachedNoteIndex(): Map<string, PatternNoteMeta> | null { return _index }

export async function loadNoteIndex(): Promise<Map<string, PatternNoteMeta>> {
  await ensureTab()
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!${COL_RANGE}`)}`, { headers: auth() },
  )
  const data = res.ok ? await res.json() as { values?: string[][] } : { values: [] }
  const map = new Map<string, PatternNoteMeta>()
  for (const r of (data.values ?? [])) {
    if (r[0]) map.set(r[0], { key: r[0], driveId: r[1] ?? '', title: r[2] ?? '', updatedAt: r[3] ?? '' })
  }
  _index = map
  return map
}

// Fetch the latest raw note HTML for a Drive file. Cache-busted + no-store:
// the SAME note is reopened from several navigation paths (e.g. a micro shared
// across DS/Topic) after in-place edits, and the Drive media URL is identical
// across edits — without this the browser can return a stale cached body
// ("old notes"). Kept local so Browse's shared fetchDriveFile is untouched.
async function fetchNoteBody(driveId: string): Promise<string> {
  const token = GAuth.getToken()
  if (!token) throw new Error('Not authenticated')
  const res = await GAuth.fetch(`${DRIVE_API_PREFIX}${driveId}?alt=media&_=${Date.now()}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Drive fetch failed: ${res.status}`)
  return res.text()
}

// Fetch the raw note HTML document for a key (or null if no note exists).
export async function getPatternNote(key: string): Promise<{ meta: PatternNoteMeta; raw: string } | null> {
  const idx = _index ?? await loadNoteIndex()
  const meta = idx.get(key)
  if (!meta || !meta.driveId) return null
  const raw = await fetchNoteBody(meta.driveId)   // cache-busted → always latest
  return { meta, raw }
}

async function findRowNum(key: string): Promise<number> {
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A2:A`)}`, { headers: auth() },
  )
  if (!res.ok) return -1
  const data = await res.json() as { values?: string[][] }
  const idx = (data.values ?? []).findIndex(r => r[0] === key)
  return idx < 0 ? -1 : idx + 2   // +1 header, +1 to 1-based
}

// Create or overwrite the note for `key`. `bodyHtml` should already have its
// images uploaded + be sanitised by the caller. Returns the updated meta.
export async function savePatternNote(key: string, title: string, bodyHtml: string): Promise<PatternNoteMeta> {
  await ensureTab()
  const token = GAuth.getToken()
  if (!token) throw new Error('Not authenticated')
  const blob = new Blob([wrapNoteHtml(bodyHtml)], { type: 'text/html' })

  let driveId = _index?.get(key)?.driveId || ''
  if (driveId) {
    await updateDriveFileContent(token, driveId, blob)
  } else {
    const folderId = await getOrCreateFolder(token, NOTES_FOLDER)
    driveId = (await uploadFileToDrive(token, folderId, blob, `${fileSafe(key)}.html`, 'text/html')).id
  }
  // Stamp time on the client; the sheet just records it.
  const updatedAt = (() => { try { return new Date().toISOString() } catch { return '' } })()
  const rowNum = await findRowNum(key)
  const values = [[key, driveId, title, updatedAt]]
  if (rowNum < 0) {
    await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', headers: auth(), body: JSON.stringify({ values }) },
    )
  } else {
    await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A${rowNum}:D${rowNum}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values }) },
    )
  }
  const meta: PatternNoteMeta = { key, driveId, title, updatedAt }
  if (!_index) _index = new Map()
  _index.set(key, meta)
  return meta
}

// Delete a key's note: remove the Drive file + clear the sheet row.
export async function deletePatternNote(key: string): Promise<void> {
  const token = GAuth.getToken()
  if (!token) throw new Error('Not authenticated')
  const meta = _index?.get(key)
  if (meta?.driveId) { try { await deleteDriveFile(token, meta.driveId) } catch { /* ignore */ } }
  const rowNum = await findRowNum(key)
  if (rowNum >= 0) {
    await GAuth.fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A${rowNum}:D${rowNum}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [['', '', '', '']] }) },
    )
  }
  _index?.delete(key)
}
