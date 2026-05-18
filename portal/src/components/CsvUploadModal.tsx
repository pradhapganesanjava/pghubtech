// Bulk-import Anki notes from a CSV file.
// Left: template fields to map. Right: CSV column dropdowns.
// Every data row in the CSV becomes one note after import.

import { useEffect, useRef, useState } from 'react'
import type { AnkiNote, AnkiTemplate } from '../adapters/ankiRepo'
import { appendAnkiNotesBulk } from '../adapters/ankiRepo'
import { useToast } from './Toast'

interface Props {
  open:          boolean
  onClose:       () => void
  templates:     Map<string, AnkiTemplate>
  existingDecks: string[]
  onImportDone:  (notes: AnkiNote[]) => void
}

// RFC-4180 CSV parser — character-by-character so quoted fields that contain
// embedded newlines (\n or \r\n) are kept as one cell, not split into rows.
function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let cellQuoted = false   // tracks whether this cell opened with a "
  let i = 0
  const n = text.length

  const commitCell = () => {
    // Unquoted cells are trimmed; quoted cells preserve internal whitespace.
    row.push(cellQuoted ? cell : cell.trim())
    cell = ''; cellQuoted = false
  }
  const commitRow = () => {
    commitCell()
    if (row.some(c => c.trim())) rows.push(row)
    row = []
  }

  while (i < n) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') { cell += '"'; i += 2 } // escaped ""
        else { quoted = false; i++ }                                    // closing quote
      } else { cell += ch; i++ }                                        // content (inc. \n)
    } else {
      if      (ch === '"')  { quoted = true; cellQuoted = true; i++ }
      else if (ch === ',')  { commitCell(); i++ }
      else if (ch === '\r') {
        if (i + 1 < n && text[i + 1] === '\n') i++ // consume \r of \r\n
        commitRow(); i++
      }
      else if (ch === '\n') { commitRow(); i++ }
      else                  { cell += ch; i++ }
    }
  }
  // Final row (file may not end with newline)
  if (cell.trim() || row.length > 0) commitRow()

  return rows
}

// Special synthetic keys for the non-field columns
const DECK_KEY = '__deck__'
const TAGS_KEY = '__tags__'

export default function CsvUploadModal({ open, onClose, templates, existingDecks, onImportDone }: Props) {
  const { toast } = useToast()
  const fileRef   = useRef<HTMLInputElement>(null)
  const tplList   = [...templates.values()]

  const [tplId,        setTplId]        = useState<string>('')
  const [csvRows,      setCsvRows]      = useState<string[][]>([])
  const [fileName,     setFileName]     = useState<string>('')
  // mapping: field key → csv column index (-1 = skip)
  const [mapping,      setMapping]      = useState<Record<string, number>>({})
  const [defaultDeck,  setDefaultDeck]  = useState<string>('')
  const [importing,    setImporting]    = useState(false)
  const [doneCount,    setDoneCount]    = useState(0)
  const [error,        setError]        = useState<string>('')

  const selectedTemplate = templates.get(tplId)
  const headers  = csvRows[0] ?? []
  const firstRow = csvRows[1] ?? []
  const dataRows = csvRows.slice(1).filter(r => r.some(c => c))

  // Seed first template
  useEffect(() => {
    if (!open) return
    if (tplList.length > 0 && !tplId) setTplId(tplList[0].id)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-build mapping whenever template or CSV headers change
  useEffect(() => {
    const init: Record<string, number> = { [DECK_KEY]: -1, [TAGS_KEY]: -1 }
    selectedTemplate?.fields.forEach(f => { init[f.key] = -1 })
    // Auto-match by header name similarity
    if (headers.length > 0) {
      for (const key of Object.keys(init)) {
        const probe = key.startsWith('__') ? key.replace(/__/g, '') : key
        const idx   = headers.findIndex(h =>
          h.trim().toLowerCase().replace(/[^a-z0-9]/g, '') === probe.toLowerCase().replace(/[^a-z0-9]/g, '')
        )
        if (idx >= 0) init[key] = idx
      }
    }
    setMapping(init)
  }, [tplId, headers.join('\x00')]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear state on close
  useEffect(() => {
    if (!open) {
      setCsvRows([]); setFileName(''); setMapping({}); setError('')
      setImporting(false); setDoneCount(0); setDefaultDeck('')
    }
  }, [open])

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name); setError('')
    const reader = new FileReader()
    reader.onload = ev => {
      const rows = parseCSV(ev.target?.result as string)
      if (rows.length === 0) { setError('CSV appears empty.'); return }
      if (rows.length === 1) { setError('CSV has only a header row — no data rows found.'); return }
      setCsvRows(rows)
    }
    reader.readAsText(file)
    // Reset so re-picking the same file fires onChange again
    e.target.value = ''
  }

  async function handleImport() {
    if (!selectedTemplate) { setError('Pick a template.'); return }
    if (dataRows.length === 0) { setError('No data rows to import.'); return }
    const deckColIdx = mapping[DECK_KEY] ?? -1
    if (deckColIdx < 0 && !defaultDeck.trim()) {
      setError('Map a Deck column or enter a default deck name below.')
      return
    }
    setImporting(true); setError(''); setDoneCount(0)
    try {
      // Build all notes locally first — zero API calls at this stage.
      const notes: AnkiNote[] = dataRows.map(row => {
        const fields: Record<string, string> = {}
        selectedTemplate.fields.forEach(f => {
          const ci = mapping[f.key] ?? -1
          fields[f.key] = ci >= 0 ? (row[ci] ?? '').trim() : ''
        })
        const deck   = deckColIdx >= 0 ? ((row[deckColIdx] ?? '').trim() || defaultDeck.trim()) : defaultDeck.trim()
        const tagsCi = mapping[TAGS_KEY] ?? -1
        const tags   = tagsCi >= 0
          ? (row[tagsCi] ?? '').split(',').map(t => t.trim()).filter(Boolean)
          : []
        return {
          noteId:     `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          deck:       deck || 'Imported',
          ankiMod:    String(Date.now()),
          templateId: selectedTemplate.id,
          fields,
          tags,
        }
      })

      // Chunked bulk insert — 50 rows per API call to avoid connection
      // timeouts on large payloads and stay within write-rate limits.
      await appendAnkiNotesBulk(notes, selectedTemplate, (done) => setDoneCount(done))
      setDoneCount(notes.length)
      toast(`Imported ${notes.length} note${notes.length === 1 ? '' : 's'}`, 'success')
      onImportDone(notes)
      onClose()
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`)
    } finally {
      setImporting(false)
    }
  }

  if (!open) return null

  // Fields listed in the left column (special rows first, then template fields)
  const mappableFields = [
    { key: DECK_KEY, label: 'Deck',   note: 'determines which deck the card goes into' },
    { key: TAGS_KEY, label: 'Tags',   note: 'comma-separated' },
    ...(selectedTemplate?.fields.map(f => ({ key: f.key, label: f.label, note: '' })) ?? []),
  ]

  const deckColIdx = mapping[DECK_KEY] ?? -1

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card csv-modal" onMouseDown={e => e.stopPropagation()}>

        {/* Header */}
        <div className="anki-gen-hd">
          <span className="anki-gen-title">Upload CSV</span>
          <button className="ai-icon-btn" onClick={onClose} title="Close">✕</button>
        </div>

        {/* Template + file row */}
        <div className="csv-top-bar">
          <label className="anote-lbl csv-top-field">
            Template
            <select value={tplId} onChange={e => setTplId(e.target.value)} disabled={importing}>
              {tplList.length === 0
                ? <option value="">No templates configured</option>
                : tplList.map(t => <option key={t.id} value={t.id}>{t.displayName}</option>)}
            </select>
          </label>

          <label className="anote-lbl csv-top-field">
            CSV File
            <div className="csv-file-row">
              <button
                className="rf-btn-cancel csv-choose-btn"
                onClick={() => fileRef.current?.click()}
                disabled={importing}
                type="button"
              >Choose file</button>
              <span className="csv-file-name">{fileName || 'No file chosen'}</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={handleFile}
            />
          </label>
        </div>

        {/* Column mapper — only shown once a CSV is parsed */}
        {csvRows.length > 0 && selectedTemplate && (
          <div className="csv-mapper-wrap">
            <div className="csv-mapper-header-row">
              <span className="csv-mapper-col-l">Template Field</span>
              <span className="csv-mapper-col-r">CSV Column</span>
            </div>

            <div className="csv-mapper-list">
              {mappableFields.map(f => (
                <div key={f.key} className="csv-mapper-item">
                  <div className="csv-field-label">
                    <span className="csv-field-name">{f.label}</span>
                    {f.note && <span className="csv-field-note">{f.note}</span>}
                  </div>
                  <select
                    className="csv-col-select"
                    value={mapping[f.key] ?? -1}
                    onChange={e => setMapping(prev => ({ ...prev, [f.key]: Number(e.target.value) }))}
                    disabled={importing}
                  >
                    <option value={-1}>(skip)</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>
                        [{i}] {h || '(blank)'}
                        {firstRow[i] ? ` · ${firstRow[i].slice(0, 28)}${firstRow[i].length > 28 ? '…' : ''}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {/* Default deck fallback when Deck column is not mapped */}
            {deckColIdx < 0 && (
              <label className="anote-lbl" style={{ marginTop: 8 }}>
                Default Deck <span className="csv-field-note">(required when Deck column is skipped)</span>
                <input
                  className="rf-input"
                  value={defaultDeck}
                  onChange={e => setDefaultDeck(e.target.value)}
                  list="csv-deck-list"
                  placeholder="e.g. Programming::JS"
                  disabled={importing}
                />
                <datalist id="csv-deck-list">
                  {existingDecks.map(d => <option key={d} value={d} />)}
                </datalist>
              </label>
            )}

            <div className="csv-preview-count">
              {dataRows.length} row{dataRows.length === 1 ? '' : 's'} ready to import
              {importing && ` — ${doneCount} / ${dataRows.length} inserted`}
            </div>
          </div>
        )}

        {error && <div className="login-error">{error}</div>}

        {/* Footer */}
        <div className="anki-gen-actions">
          <button className="rf-btn-cancel" onClick={onClose} disabled={importing}>Cancel</button>
          <button
            className="mgmt-save-btn"
            onClick={handleImport}
            disabled={importing || dataRows.length === 0 || !tplId}
          >
            {importing
              ? `Importing… ${doneCount} / ${dataRows.length}`
              : `Import ${dataRows.length > 0 ? dataRows.length : ''} note${dataRows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
