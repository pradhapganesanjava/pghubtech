import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'
import { isFieldRef, resolveField, reconcileField, deleteFieldRef } from '../lib/driveFields'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

export interface AnkiField {
  key: string
  label: string
  type: string
  isFront: boolean
  isBack: boolean
  order: number
  options: string
}

export interface AnkiTemplate {
  id: string
  displayName: string
  fields: AnkiField[]
}

export interface AnkiNote {
  noteId: string
  deck: string
  ankiMod: string
  templateId: string
  fields: Record<string, string>
  tags: string[]
}

function authHeaders(): Record<string, string> {
  const token = GAuth.getToken()
  if (!token) throw new Error('Not authenticated')
  return { Authorization: `Bearer ${token}` }
}

function sid(): string {
  const id = Config.sheetId
  if (!id) throw new Error('Sheet ID not configured')
  return id
}

async function getRange(range: string): Promise<string[][]> {
  const url = `${BASE}/${sid()}/values/${encodeURIComponent(range)}`
  const res = await GAuth.fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(err.error?.message ?? `HTTP ${res.status}`)
  }
  const data = await res.json() as { values?: string[][] }
  return data.values ?? []
}

async function setRange(range: string, values: string[][]): Promise<void> {
  const url = `${BASE}/${sid()}/values/${encodeURIComponent(range)}?valueInputOption=RAW`
  const res = await GAuth.fetch(url, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(err.error?.message ?? `HTTP ${res.status}`)
  }
}

function colToLetter(n: number): string {
  let s = ''
  while (n > 0) {
    n--
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26)
  }
  return s
}

// Map field values to cell-safe values before writing a row: any value that
// exceeds Sheets' 50k-per-cell cap is offloaded to Drive and replaced with a
// pointer (see lib/driveFields). `prev` (same field order) lets an edit reuse
// or clean up the previously-offloaded Drive file instead of orphaning it.
// Without a token we can't offload — pass values through and let Sheets reject
// an oversized cell with its own error.
async function toCellValues(values: string[], prev: string[] = []): Promise<string[]> {
  const token = GAuth.getToken()
  if (!token) return values
  return Promise.all(values.map((v, i) => reconcileField(v, prev[i] ?? '', token)))
}

// ── In-memory caches (survive React Strict Mode double-invoke) ────────────────

let _templateCache:   Map<string, AnkiTemplate> | null = null
let _templatePending: Promise<Map<string, AnkiTemplate>> | null = null

let _notesCache:   AnkiNote[] | null = null
let _notesPending: Promise<AnkiNote[]> | null = null

export function invalidateAnkiCache() {
  _templateCache = null
  _templatePending = null
  _notesCache = null
  _notesPending = null
}

async function fetchTemplates(): Promise<Map<string, AnkiTemplate>> {
  const rows = await getRange('Templates!A:J')
  if (!rows.length) return new Map()

  const h = rows[0]
  const col = (k: string) => h.indexOf(k)

  const map = new Map<string, AnkiTemplate>()
  for (const row of rows.slice(1)) {
    const id = row[col('template_id')]
    if (!id) continue
    if (!map.has(id)) {
      map.set(id, { id, displayName: row[col('template_name')] ?? id, fields: [] })
    }
    const key = row[col('field_key')]
    if (!key || key === 'tags') continue
    map.get(id)!.fields.push({
      key,
      label:   row[col('field_label')] ?? key,
      type:    row[col('field_type')] ?? 'text',
      isFront: row[col('is_front')] === 'TRUE',
      isBack:  row[col('is_back')]  === 'TRUE',
      order:   parseInt(row[col('field_order')] ?? '0', 10),
      options: row[col('options')] ?? '',
    })
  }

  for (const tmpl of map.values()) {
    tmpl.fields.sort((a, b) => a.order - b.order)
  }

  return map
}

export function loadAnkiTemplates(): Promise<Map<string, AnkiTemplate>> {
  if (_templateCache) return Promise.resolve(_templateCache)
  if (_templatePending) return _templatePending
  _templatePending = fetchTemplates()
    .then(map => { _templateCache = map; _templatePending = null; return map })
    .catch(e  => { _templatePending = null; throw e })
  return _templatePending
}

export async function loadAnkiNotes(
  templateId: string,
  fields: AnkiField[],
): Promise<AnkiNote[]> {
  const lastCol = colToLetter(3 + fields.length + 1) // +1 for tags col
  const rows = await getRange(`${templateId}!A2:${lastCol}`)

  const notes = rows
    .filter(r => r[0])
    .map(r => {
      const fieldMap: Record<string, string> = {}
      fields.forEach((f, i) => { fieldMap[f.key] = r[3 + i] ?? '' })
      const tagsRaw = r[3 + fields.length] ?? ''
      return {
        noteId:     r[0],
        deck:       r[1] ?? '',
        ankiMod:    r[2] ?? '',
        templateId,
        fields:     fieldMap,
        tags:       tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
      }
    })

  // Resolve any fields that were offloaded to Drive (oversized for a cell).
  // Only fields holding a pointer trigger a fetch; everything else is untouched.
  const token = GAuth.getToken()
  if (token) {
    await Promise.all(
      notes.flatMap(note =>
        Object.keys(note.fields)
          .filter(k => isFieldRef(note.fields[k]))
          .map(async k => {
            try { note.fields[k] = await resolveField(note.fields[k], token) }
            catch { /* leave the pointer; a later load can resolve it */ }
          })
      )
    )
  }

  return notes
}

export async function loadAllNotes(
  templates: Map<string, AnkiTemplate>,
): Promise<AnkiNote[]> {
  if (_notesCache) return _notesCache
  if (_notesPending) return _notesPending
  _notesPending = Promise.all(
    [...templates.entries()].map(([id, tmpl]) => loadAnkiNotes(id, tmpl.fields))
  )
    .then(results => { const notes = results.flat(); _notesCache = notes; _notesPending = null; return notes })
    .catch(e => { _notesPending = null; throw e })
  return _notesPending
}

export async function saveAnkiTemplate(template: AnkiTemplate): Promise<void> {
  _templateCache = null  // invalidate so next load reflects changes
  const all = await getRange('Templates!A:J')
  if (!all.length) return
  const header = all[0]
  const col = (k: string) => header.indexOf(k)
  const cName  = col('template_name')
  const cKey   = col('field_key')
  const cLabel = col('field_label')
  const cType  = col('field_type')
  const cFront = col('is_front')
  const cBack  = col('is_back')
  const cOrder = col('field_order')

  const fieldRows = new Map<string, number>()
  for (let i = 1; i < all.length; i++) {
    if (all[i][col('template_id')] === template.id) {
      fieldRows.set(all[i][cKey] ?? '', i + 1)
    }
  }

  await Promise.all(
    template.fields.map(f => {
      const rowNum = fieldRows.get(f.key)
      if (!rowNum) return Promise.resolve()
      const row = [...(all[rowNum - 1] ?? [])]
      while (row.length <= Math.max(cName, cLabel, cType, cFront, cBack, cOrder)) row.push('')
      row[cName]  = template.displayName
      row[cLabel] = f.label
      row[cType]  = f.type
      row[cFront] = f.isFront ? 'TRUE' : 'FALSE'
      row[cBack]  = f.isBack  ? 'TRUE' : 'FALSE'
      row[cOrder] = String(f.order)
      return setRange(`Templates!A${rowNum}:${colToLetter(row.length)}${rowNum}`, [row])
    })
  )
}

export async function saveAnkiNote(note: AnkiNote, template: AnkiTemplate): Promise<void> {
  _notesCache = null  // invalidate so next load picks up the change
  const sortedFields = [...template.fields].sort((a, b) => a.order - b.order)
  const lastCol = colToLetter(3 + sortedFields.length + 1)
  // Read the full existing row (not just column A) so toCellValues can reuse or
  // clean up any Drive-offloaded field files for this note.
  const rows = await getRange(`${template.id}!A2:${lastCol}`)
  const rowIdx = rows.findIndex(r => r[0] === note.noteId)
  if (rowIdx < 0) throw new Error('Note not found in sheet')
  const rowNum = rowIdx + 2  // +1 for header row, +1 for 1-based row numbers
  const prevFieldValues = sortedFields.map((_, i) => rows[rowIdx][3 + i] ?? '')
  const fieldValues = await toCellValues(sortedFields.map(f => note.fields[f.key] ?? ''), prevFieldValues)
  const row = [note.noteId, note.deck, note.ankiMod, ...fieldValues, note.tags.join(', ')]
  await setRange(`${template.id}!A${rowNum}:${colToLetter(row.length)}${rowNum}`, [row])
}

// Append a brand-new note to the template tab. Used by the AI chat panels'
// "Generate Anki cards" flow.
export async function appendAnkiNote(note: AnkiNote, template: AnkiTemplate): Promise<void> {
  _notesCache = null
  const sortedFields = [...template.fields].sort((a, b) => a.order - b.order)
  const fieldValues  = await toCellValues(sortedFields.map(f => note.fields[f.key] ?? ''))
  const row          = [note.noteId, note.deck, note.ankiMod, ...fieldValues, note.tags.join(', ')]
  const lastCol      = colToLetter(row.length)
  const url = `${BASE}/${sid()}/values/${encodeURIComponent(`${template.id}!A:${lastCol}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`
  const res = await GAuth.fetch(url, {
    method:  'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values: [row] }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(err.error?.message ?? `HTTP ${res.status}`)
  }
}

// Delete many notes in one batchUpdate per template tab.
// Reads column A of each affected tab to locate row indices, then deletes
// them in descending order (bottom-up) so earlier indices stay valid.
export async function deleteAnkiNotes(notes: AnkiNote[]): Promise<void> {
  if (notes.length === 0) return
  _notesCache = null
  const id = sid()

  // Group noteIds by their template tab
  const byTemplate = new Map<string, Set<string>>()
  for (const n of notes) {
    const s = byTemplate.get(n.templateId) ?? new Set<string>()
    s.add(n.noteId)
    byTemplate.set(n.templateId, s)
  }

  // Fetch spreadsheet metadata to get numeric sheetId per tab title
  const metaRes = await GAuth.fetch(
    `${BASE}/${id}?fields=sheets.properties(sheetId,title)`,
    { headers: authHeaders() },
  )
  if (!metaRes.ok) {
    const err = await metaRes.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(err.error?.message ?? `Metadata fetch failed: ${metaRes.status}`)
  }
  const meta = await metaRes.json() as {
    sheets: { properties: { sheetId: number; title: string } }[]
  }
  const sheetIdByTitle = new Map(
    meta.sheets.map(s => [s.properties.title, s.properties.sheetId]),
  )

  // Build all deleteDimension requests (descending within each tab)
  const requests: object[] = []
  const token = GAuth.getToken()
  const refCleanup: Promise<void>[] = []
  for (const [templateId, targetIds] of byTemplate) {
    const sheetId = sheetIdByTitle.get(templateId)
    if (sheetId === undefined) continue

    // Read the whole tab (all columns) so we can both locate target rows and
    // clean up any Drive-offloaded field files those rows reference.
    const sheetRows = await getRange(templateId)
    const indices: number[] = []
    sheetRows.forEach((row, i) => {
      if (i === 0) return          // header row
      if (!targetIds.has(row[0])) return
      indices.push(i)
      if (token) {
        for (const cell of row) {
          if (isFieldRef(cell)) refCleanup.push(deleteFieldRef(cell, token))
        }
      }
    })

    // Process bottom-up so earlier indices aren't shifted by prior deletions
    indices.sort((a, b) => b - a)
    for (const idx of indices) {
      requests.push({
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
        },
      })
    }
  }

  // Drive cleanup is best-effort and independent of the row deletion.
  await Promise.all(refCleanup)

  if (requests.length === 0) return

  const batchRes = await GAuth.fetch(`${BASE}/${id}:batchUpdate`, {
    method:  'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body:    JSON.stringify({ requests }),
  })
  if (!batchRes.ok) {
    const err = await batchRes.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(err.error?.message ?? `Delete failed: ${batchRes.status}`)
  }
}

// Bulk-append notes in chunks to avoid browser connection timeouts on large
// payloads and stay within Sheets API write-rate limits.
// Each chunk is one API call; 50 rows × ~1 KB avg ≈ 50 KB per request.
const BULK_CHUNK_SIZE = 50

export async function appendAnkiNotesBulk(
  notes:       AnkiNote[],
  template:    AnkiTemplate,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (notes.length === 0) return
  _notesCache = null
  const sortedFields = [...template.fields].sort((a, b) => a.order - b.order)
  const allRows = await Promise.all(notes.map(async note => {
    const fieldValues = await toCellValues(sortedFields.map(f => note.fields[f.key] ?? ''))
    return [note.noteId, note.deck, note.ankiMod, ...fieldValues, note.tags.join(', ')]
  }))
  const lastCol = colToLetter(allRows[0].length)
  const url = `${BASE}/${sid()}/values/${encodeURIComponent(`${template.id}!A:${lastCol}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`

  let sent = 0
  for (let i = 0; i < allRows.length; i += BULK_CHUNK_SIZE) {
    const chunk = allRows.slice(i, i + BULK_CHUNK_SIZE)
    const res = await GAuth.fetch(url, {
      method:  'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: chunk }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(err.error?.message ?? `HTTP ${res.status}`)
    }
    sent += chunk.length
    onProgress?.(sent, notes.length)
  }
}

