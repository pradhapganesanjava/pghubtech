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
