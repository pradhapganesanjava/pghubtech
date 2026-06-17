// Notes feature — Notion-style unified tree.
//
//   Drive folder           PGHubTechNotes/
//     ├─ Note A.gsheet        ← one Sheet per note
//     │     └─ nodes tab        cols: id, parent_id, title, content,
//     │                                position, tags, created_at, updated_at
//     └─ Note B.gsheet
//
// Every node — whether the user thinks of it as a section, a page, or a
// sub-page — is a row in the same table. The only thing that distinguishes
// "section-like" from "page-like" is whether `content` is empty.
//
// Why this shape: see the design discussion. Single set of operations,
// atomic move/rename via parent_id, no `::` delimiter to escape, no Sheets
// tab limit to bump into.

import { GAuth } from '../lib/gauth'
import {
  getOrCreateFolder,
  deleteDriveFile,
} from '../lib/drive'

const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3/files'
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

export const NOTES_FOLDER = 'PGHubTechNotes'

const NODES_TAB = 'nodes'
// `kind` is appended at the end so existing rows from earlier schema
// versions still load (missing kind defaults to 'section' in rowToNode).
const NODES_HEADERS = [
  'id', 'parent_id', 'title', 'content', 'position', 'tags',
  'created_at', 'updated_at', 'kind',
] as const

// Google Sheets caps a single cell at 50 000 characters. `content` (sanitised
// HTML) can blow past that, so we split it: the first chunk stays in the
// `content` column (D), the rest spill into overflow columns (J onward) and
// are re-joined on read. Leave headroom under the hard 50k limit.
const MAX_CELL  = 49000
// A:Z — 9 base columns + up to 17 content-overflow columns (≈ 882k chars).
// Writing the full width every save also clears stale overflow cells left
// behind when a note shrinks back below the cell limit.
const ROW_WIDTH = 26

// ── Types ────────────────────────────────────────────────────────────────────

export interface Note {
  id:           string
  name:         string
  modifiedTime: string
}

export type NodeKind = 'section' | 'page'

export interface NoteNode {
  id:        string
  parentId:  string   // '' for top-level
  title:     string
  content:   string   // sanitised HTML
  position:  number
  tags:      string[] // reserved for future filter axis
  createdAt: string
  updatedAt: string
  // 'section' = container; can hold sections + pages.
  // 'page'    = leaf-with-content; can hold only sub-pages.
  kind:      NodeKind
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

function authHeaders(json = false): Record<string, string> {
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

function uuid(): string {
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ── Notes (Drive level) ──────────────────────────────────────────────────────

export async function listNotes(): Promise<Note[]> {
  const token  = GAuth.getToken()
  if (!token) throw new Error('Not authenticated')
  const folder = await getOrCreateFolder(token, NOTES_FOLDER)
  const q   = `'${folder}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`
  const url = `${DRIVE_BASE}?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&orderBy=name&pageSize=200`
  const res  = await GAuth.fetch(url, { headers: authHeaders() })
  const data = await expectOk(res, 'List notes') as { files?: Note[] }
  return data.files ?? []
}

export async function createNote(name: string): Promise<Note> {
  const token  = GAuth.getToken()
  if (!token) throw new Error('Not authenticated')
  const folder = await getOrCreateFolder(token, NOTES_FOLDER)

  const cr = await GAuth.fetch(SHEETS_BASE, {
    method:  'POST',
    headers: authHeaders(true),
    body:    JSON.stringify({
      properties: { title: name.trim() || 'Untitled Note' },
      sheets:     [{ properties: { title: NODES_TAB } }],
    }),
  })
  const created = await expectOk(cr, 'Create note') as { spreadsheetId: string }
  const spreadsheetId = created.spreadsheetId

  // Move into the PGHubTechNotes folder.
  await GAuth.fetch(`${DRIVE_BASE}/${spreadsheetId}?addParents=${folder}&removeParents=root&fields=id`, {
    method:  'PATCH',
    headers: authHeaders(true),
  }).then(r => expectOk(r, 'Move note to folder'))

  // Header row + a starter top-level node so the user has something to rename.
  await writeRange(spreadsheetId, `${NODES_TAB}!A1:I1`, [NODES_HEADERS as unknown as string[]])
  const now    = new Date().toISOString()
  const seedId = uuid()
  await writeRange(spreadsheetId, `${NODES_TAB}!A2:I2`, [[
    seedId, '', 'Section 1', '', '0', '', now, now, 'section',
  ]])
  _nodesTabEnsured.add(spreadsheetId)

  return {
    id:           spreadsheetId,
    name:         name.trim() || 'Untitled Note',
    modifiedTime: now,
  }
}

export async function renameNote(noteId: string, newName: string): Promise<void> {
  await GAuth.fetch(`${DRIVE_BASE}/${noteId}?fields=id,name`, {
    method:  'PATCH',
    headers: authHeaders(true),
    body:    JSON.stringify({ name: newName.trim() }),
  }).then(r => expectOk(r, 'Rename note'))
}

export async function deleteNote(noteId: string): Promise<void> {
  const token = GAuth.getToken()
  if (!token) throw new Error('Not authenticated')
  await deleteDriveFile(token, noteId)
}

// ── Nodes (one tab, parent_id tree) ─────────────────────────────────────────

const _nodesTabEnsured = new Set<string>()

// Notes created with an older schema (or hand-made Sheets in the folder)
// won't have a `nodes` tab yet. Create it lazily so opening any note Just
// Works. Idempotent + cached per noteId so we don't re-check on every call.
async function ensureNodesTab(noteId: string): Promise<void> {
  if (_nodesTabEnsured.has(noteId)) return
  const r = await GAuth.fetch(`${SHEETS_BASE}/${noteId}?fields=sheets.properties.title`, {
    headers: authHeaders(),
  })
  if (!r.ok) {
    // Not catastrophic — let the caller fail with a useful error from its own
    // call. Don't cache a false positive.
    return
  }
  const data = await r.json() as { sheets?: { properties?: { title?: string } }[] }
  const tabs = (data.sheets ?? []).map(s => s.properties?.title ?? '')
  if (!tabs.includes(NODES_TAB)) {
    await GAuth.fetch(`${SHEETS_BASE}/${noteId}:batchUpdate`, {
      method:  'POST',
      headers: authHeaders(true),
      body:    JSON.stringify({
        requests: [{ addSheet: { properties: { title: NODES_TAB } } }],
      }),
    }).then(r2 => expectOk(r2, 'Add nodes tab'))
    await writeRange(noteId, `${NODES_TAB}!A1:I1`, [NODES_HEADERS as unknown as string[]])
  }
  _nodesTabEnsured.add(noteId)
}

export async function loadNodes(noteId: string): Promise<NoteNode[]> {
  await ensureNodesTab(noteId)
  const r = await GAuth.fetch(
    `${SHEETS_BASE}/${noteId}/values/${encodeURIComponent(`${NODES_TAB}!A2:Z`)}`,
    { headers: authHeaders() },
  )
  const d = await r.json() as { values?: string[][] }
  return (d.values ?? [])
    .map(row => rowToNode(row))
    .filter((n): n is NoteNode => n !== null)
}

export async function addNode(
  noteId:   string,
  parentId: string,
  title:    string,
  kind:     NodeKind = 'section',
  content   = '',
): Promise<NoteNode> {
  await ensureNodesTab(noteId)
  const now = new Date().toISOString()
  const id  = uuid()
  // Position = max position among existing siblings + 1.
  const all = await loadNodes(noteId)
  const siblings = all.filter(n => n.parentId === parentId)
  const position = siblings.length === 0 ? 0 : Math.max(...siblings.map(n => n.position)) + 1
  const node: NoteNode = {
    id, parentId,
    title:     title.trim() || 'Untitled',
    content,
    position,
    tags:      [],
    createdAt: now,
    updatedAt: now,
    kind,
  }
  await GAuth.fetch(
    `${SHEETS_BASE}/${noteId}/values/${encodeURIComponent(`${NODES_TAB}!A:Z`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method:  'POST',
      headers: authHeaders(true),
      body:    JSON.stringify({ values: [nodeToRow(node)] }),
    },
  ).then(r2 => expectOk(r2, 'Append node'))
  return node
}

export async function updateNode(noteId: string, node: NoteNode): Promise<void> {
  await ensureNodesTab(noteId)
  const rowIdx = await findNodeRow(noteId, node.id)
  if (rowIdx < 0) throw new Error('Node row not found')
  const updated = { ...node, updatedAt: new Date().toISOString() }
  await writeRange(
    noteId,
    `${NODES_TAB}!A${rowIdx}:Z${rowIdx}`,
    [nodeToRow(updated)],
  )
}

// Move = single-cell update of parent_id (+ optional position).
export async function moveNode(
  noteId:      string,
  id:          string,
  newParentId: string,
  newPosition?: number,
): Promise<void> {
  const all  = await loadNodes(noteId)
  const me   = all.find(n => n.id === id)
  if (!me) throw new Error('Node not found')
  if (newParentId !== me.parentId || (newPosition !== undefined && newPosition !== me.position)) {
    const updated: NoteNode = {
      ...me,
      parentId: newParentId,
      position: newPosition ?? me.position,
    }
    await updateNode(noteId, updated)
  }
}

// Delete = recursively remove a node + every descendant. Done in one
// batchUpdate so the spreadsheet stays consistent.
export async function deleteNode(noteId: string, id: string): Promise<void> {
  await ensureNodesTab(noteId)
  const all = await loadNodes(noteId)
  const targets = collectDescendants(all, id)
  if (targets.size === 0) return

  const sheetId = await findNodesSheetId(noteId)
  // Find row indices for every target. loadNodes preserves sheet order, but
  // deletions need 0-based indices into the actual sheet — do a single read
  // of column A and map id → row.
  const a = await GAuth.fetch(
    `${SHEETS_BASE}/${noteId}/values/${encodeURIComponent(`${NODES_TAB}!A:A`)}`,
    { headers: authHeaders() },
  )
  const aData = await a.json() as { values?: string[][] }
  const rows = aData.values ?? []
  const indices: number[] = []
  rows.forEach((r, i) => { if (i > 0 && targets.has(r[0])) indices.push(i) })
  if (indices.length === 0) return

  // Delete from the bottom up so earlier indices stay valid.
  indices.sort((x, y) => y - x)
  const requests = indices.map(idx => ({
    deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
    },
  }))
  await GAuth.fetch(`${SHEETS_BASE}/${noteId}:batchUpdate`, {
    method:  'POST',
    headers: authHeaders(true),
    body:    JSON.stringify({ requests }),
  }).then(r => expectOk(r, 'Delete nodes'))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToNode(r: string[]): NoteNode | null {
  if (!r[0]) return null
  const rawKind = (r[8] ?? '').trim().toLowerCase()
  // content = column D + any overflow columns (J onward), concatenated back.
  return {
    id:        r[0],
    parentId:  r[1] ?? '',
    title:     r[2] ?? '',
    content:   (r[3] ?? '') + r.slice(9).join(''),
    position:  parseInt(r[4] ?? '0', 10) || 0,
    tags:      (r[5] ?? '').split(',').map(t => t.trim()).filter(Boolean),
    createdAt: r[6] ?? '',
    updatedAt: r[7] ?? '',
    kind:      rawKind === 'page' ? 'page' : 'section',
  }
}

function nodeToRow(n: NoteNode): string[] {
  const chunks = splitCell(n.content)
  // Content cells available: column D + (ROW_WIDTH - 9) overflow columns.
  if (chunks.length > ROW_WIDTH - 8) {
    throw new Error(
      `Note content too large (${n.content.length} chars; max ~${MAX_CELL * (ROW_WIDTH - 8)})`,
    )
  }
  const row = [
    n.id,
    n.parentId,
    n.title,
    chunks[0] ?? '',
    String(n.position),
    n.tags.join(', '),
    n.createdAt,
    n.updatedAt,
    n.kind,
    ...chunks.slice(1),
  ]
  // Pad to full width so stale overflow cells from a previous, larger save
  // are overwritten with blanks rather than left to corrupt the next read.
  while (row.length < ROW_WIDTH) row.push('')
  return row
}

// Split a string into ≤MAX_CELL chunks. Slicing by UTF-16 code unit may cut a
// surrogate pair across cells, but plain concatenation on read reassembles the
// exact original string, so it's lossless.
function splitCell(s: string): string[] {
  if (s.length <= MAX_CELL) return [s]
  const out: string[] = []
  for (let i = 0; i < s.length; i += MAX_CELL) out.push(s.slice(i, i + MAX_CELL))
  return out
}

function collectDescendants(all: NoteNode[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  all.forEach(n => {
    const list = childrenOf.get(n.parentId) ?? []
    list.push(n.id)
    childrenOf.set(n.parentId, list)
  })
  const out = new Set<string>()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    const kids = childrenOf.get(id) ?? []
    kids.forEach(k => stack.push(k))
  }
  return out
}

async function findNodeRow(noteId: string, id: string): Promise<number> {
  const r = await GAuth.fetch(
    `${SHEETS_BASE}/${noteId}/values/${encodeURIComponent(`${NODES_TAB}!A:A`)}`,
    { headers: authHeaders() },
  )
  const d = await r.json() as { values?: string[][] }
  const rows = d.values ?? []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === id) return i + 1   // 1-based for A1 ranges
  }
  return -1
}

async function findNodesSheetId(noteId: string): Promise<number> {
  const meta = await GAuth.fetch(`${SHEETS_BASE}/${noteId}?fields=sheets.properties(sheetId,title)`, {
    headers: authHeaders(),
  })
  const data = await meta.json() as { sheets: { properties: { sheetId: number; title: string } }[] }
  const props = data.sheets.find(s => s.properties.title === NODES_TAB)?.properties
  if (!props) throw new Error(`'${NODES_TAB}' tab not found`)
  return props.sheetId
}

async function writeRange(noteId: string, range: string, values: string[][]): Promise<void> {
  await GAuth.fetch(
    `${SHEETS_BASE}/${noteId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method:  'PUT',
      headers: authHeaders(true),
      body:    JSON.stringify({ values }),
    },
  ).then(r => expectOk(r, `Write ${range}`))
}
