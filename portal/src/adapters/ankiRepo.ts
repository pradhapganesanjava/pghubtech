import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'

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
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(err.error?.message ?? `HTTP ${res.status}`)
  }
  const data = await res.json() as { values?: string[][] }
  return data.values ?? []
}

async function setRange(range: string, values: string[][]): Promise<void> {
  const url = `${BASE}/${sid()}/values/${encodeURIComponent(range)}?valueInputOption=RAW`
  const res = await fetch(url, {
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

  return rows
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
  const colA = await getRange(`${template.id}!A:A`)
  const rowIdx = colA.findIndex(r => r[0] === note.noteId)
  if (rowIdx < 0) throw new Error('Note not found in sheet')
  const rowNum = rowIdx + 1
  const sortedFields = [...template.fields].sort((a, b) => a.order - b.order)
  const fieldValues = sortedFields.map(f => note.fields[f.key] ?? '')
  const tags = note.tags.join(', ')
  const row = [note.noteId, note.deck, note.ankiMod, ...fieldValues, tags]
  const lastCol = colToLetter(row.length)
  await setRange(`${template.id}!A${rowNum}:${lastCol}${rowNum}`, [row])
}

