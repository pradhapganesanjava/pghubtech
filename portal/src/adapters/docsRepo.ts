// Docs sheet adapter — one row per uploaded doc. The Drive file ID is the
// primary key; the row also stores a user-friendly alias and a comma-separated
// tag list for grouping in the UI.

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const TAB  = 'Docs'

const HEADERS = [
  'id',          // Drive file ID
  'alias',       // user-friendly display name
  'filename',    // original filename
  'mime',        // MIME type
  'size',        // bytes
  'tags',        // comma-separated tag paths (e.g. "react::hooks, frontend")
  'created_at',  // ISO timestamp
] as const

const COL_RANGE = `A2:G`   // first row is the header

export interface DocRecord {
  id:        string
  alias:     string
  filename:  string
  mime:      string
  size:      number
  tags:      string[]
  createdAt: string
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
        { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [HEADERS as unknown as string[]] }) }
      )
    }
    _tabEnsured = true
  })().finally(() => { _tabPending = null })
  return _tabPending
}

function rowToRecord(r: string[]): DocRecord | null {
  if (!r[0]) return null
  return {
    id:        r[0],
    alias:     r[1] ?? '',
    filename:  r[2] ?? '',
    mime:      r[3] ?? 'application/octet-stream',
    size:      parseInt(r[4] ?? '0', 10) || 0,
    tags:      (r[5] ?? '').split(',').map(t => t.trim()).filter(Boolean),
    createdAt: r[6] ?? '',
  }
}

function recordToRow(d: DocRecord): string[] {
  return [
    d.id,
    d.alias,
    d.filename,
    d.mime,
    String(d.size),
    d.tags.join(', '),
    d.createdAt,
  ]
}

export async function loadDocs(): Promise<DocRecord[]> {
  await ensureTab()
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!' + COL_RANGE)}`,
    { headers: auth() },
  )
  if (!res.ok) throw new Error(`Failed to load Docs: ${res.status}`)
  const data = await res.json() as { values?: string[][] }
  return (data.values ?? []).map(rowToRecord).filter((d): d is DocRecord => d != null)
}

async function findRowNum(id: string): Promise<number> {
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A:A')}`,
    { headers: auth() },
  )
  if (!res.ok) throw new Error(`Failed to scan Docs: ${res.status}`)
  const data = await res.json() as { values?: string[][] }
  const idx  = (data.values ?? []).findIndex(r => r[0] === id)
  return idx < 0 ? -1 : idx + 1
}

export async function appendDoc(doc: DocRecord): Promise<void> {
  await ensureTab()
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A:G')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method:  'POST',
      headers: auth(),
      body:    JSON.stringify({ values: [recordToRow(doc)] }),
    },
  )
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Failed to append doc row: ${res.status} ${err.slice(0, 160)}`)
  }
}

export async function updateDoc(doc: DocRecord): Promise<void> {
  await ensureTab()
  const rowNum = await findRowNum(doc.id)
  if (rowNum < 0) throw new Error('Doc row not found')
  const range = `${TAB}!A${rowNum}:G${rowNum}`
  const res = await GAuth.fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method:  'PUT',
      headers: auth(),
      body:    JSON.stringify({ values: [recordToRow(doc)] }),
    },
  )
  if (!res.ok) throw new Error(`Failed to update doc row: ${res.status}`)
}

export async function deleteDocRow(id: string): Promise<void> {
  await ensureTab()
  // Resolve the sheet's numeric ID (for batchUpdate) and the row number.
  const [meta, rowNum] = await Promise.all([
    GAuth.fetch(`${BASE}/${sid()}?fields=sheets.properties(sheetId,title)`, { headers: auth() }).then(r => r.json()),
    findRowNum(id),
  ]) as [{ sheets?: { properties?: { sheetId: number; title: string } }[] }, number]

  if (rowNum < 0) return  // already gone
  const sheet = (meta.sheets ?? []).find(s => s.properties?.title === TAB)?.properties
  if (!sheet) throw new Error('Docs tab not found')

  const res = await GAuth.fetch(`${BASE}/${sid()}:batchUpdate`, {
    method:  'POST',
    headers: auth(),
    body:    JSON.stringify({
      requests: [{
        deleteDimension: {
          range: {
            sheetId:    sheet.sheetId,
            dimension:  'ROWS',
            startIndex: rowNum - 1,
            endIndex:   rowNum,
          },
        },
      }],
    }),
  })
  if (!res.ok) throw new Error(`Failed to delete doc row: ${res.status}`)
}
