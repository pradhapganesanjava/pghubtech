import { useState, useEffect, useRef } from 'react'
import type { AnkiNote, AnkiTemplate, AnkiField } from '../adapters/ankiRepo'
import { saveAnkiNote } from '../adapters/ankiRepo'
import type { SRSRecord } from '../adapters/srsRepo'
import { GAuth } from '../lib/gauth'
import { useToast } from './Toast'

const DRIVE_API_RE = /https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[A-Za-z0-9_-]+\?alt=media/g

async function resolveDriveImages(
  html: string,
  token: string,
  blobUrls: string[],
): Promise<string> {
  const matches = [...html.matchAll(DRIVE_API_RE)]
  if (!matches.length) return html
  let out = html
  for (const [url] of matches) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) continue
      const blobUrl = URL.createObjectURL(await res.blob())
      blobUrls.push(blobUrl)
      out = out.replaceAll(url, blobUrl)
    } catch { /* keep original src */ }
  }
  return out
}

type HtmlEditMode = 'edit' | 'preview' | 'split'

interface Props {
  note:         AnkiNote
  template:     AnkiTemplate
  rec:          SRSRecord | undefined
  lastSeen:     string
  onClose:      () => void
  onNoteSaved:  (note: AnkiNote) => void
}

// ── View mode: single field renderer (always renders as HTML) ────────────────

function ViewField({ field, value }: { field: AnkiField; value: string }) {
  if (!value) return <div className="section-empty-val">—</div>
  return (
    <div className="detail-field-wrap">
      <div className="section-hd">{field.label}</div>
      <div className="section-html-body" dangerouslySetInnerHTML={{ __html: value }} />
    </div>
  )
}

function looksLikeHtml(v: string): boolean {
  return /<[a-z]/i.test(v)
}

// ── Edit mode: single field editor ───────────────────────────────────────────

function EditField({
  field,
  value,
  onChange,
}: {
  field:    AnkiField
  value:    string
  onChange: (v: string) => void
}) {
  const [mode, setMode] = useState<HtmlEditMode>('preview')
  const isHtml = field.type === 'html' || looksLikeHtml(value)

  if (field.type === 'select') {
    const opts = field.options ? field.options.split(',').map(o => o.trim()).filter(Boolean) : []
    return (
      <div className="rf-row">
        <label className="rf-label">{field.label}</label>
        <select className="rf-select" value={value} onChange={e => onChange(e.target.value)}>
          <option value="">—</option>
          {opts.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    )
  }

  if (isHtml) {
    return (
      <div className="rf-row rf-row-col rf-html-field">
        <div className="rf-html-hd">
          <label className="rf-label">{field.label}</label>
          <div className="rf-html-tabs">
            {(['edit', 'preview', 'split'] as HtmlEditMode[]).map(m => (
              <button
                key={m}
                className={`rf-html-tab${mode === m ? ' active' : ''}`}
                onClick={() => setMode(m)}
              >
                {m === 'edit' ? 'HTML' : m === 'preview' ? 'Preview' : 'Split'}
              </button>
            ))}
          </div>
        </div>
        <div className={`rf-html-body${mode === 'split' ? ' split' : ''}`}>
          {(mode === 'edit' || mode === 'split') && (
            <textarea
              className="rf-textarea rf-html-editor"
              value={value}
              rows={8}
              spellCheck={false}
              onChange={e => onChange(e.target.value)}
            />
          )}
          {(mode === 'preview' || mode === 'split') && (
            <div
              className="rf-html-preview section-html-body"
              dangerouslySetInnerHTML={{ __html: value || '<em style="opacity:.45">No content</em>' }}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="rf-row">
      <label className="rf-label">{field.label}</label>
      <input
        type="text"
        className="rf-input"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NoteDetailPanel({
  note, template, rec, lastSeen, onClose, onNoteSaved,
}: Props) {
  const { toast } = useToast()
  const [editMode, setEditMode] = useState(false)
  const [editFields, setEditFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [resolvedFields, setResolvedFields] = useState<Record<string, string> | null>(null)
  const blobUrlsRef = useRef<string[]>([])

  const sortedFields = [...template.fields].sort((a, b) => a.order - b.order)

  useEffect(() => {
    setResolvedFields(null)
    const token = GAuth.getToken()
    if (!token) return
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []
    let cancelled = false
    const newBlobUrls: string[] = []
    Promise.all(
      sortedFields.map(async f => {
        const val = note.fields[f.key] ?? ''
        const resolved = await resolveDriveImages(val, token, newBlobUrls)
        return [f.key, resolved] as [string, string]
      })
    ).then(pairs => {
      if (cancelled) { newBlobUrls.forEach(u => URL.revokeObjectURL(u)); return }
      blobUrlsRef.current = newBlobUrls
      const map: Record<string, string> = {}
      pairs.forEach(([k, v]) => { map[k] = v })
      setResolvedFields(map)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [note.noteId]) // eslint-disable-line react-hooks/exhaustive-deps
  const frontFields  = sortedFields.filter(f => f.isFront)
  const backFields   = sortedFields.filter(f => f.isBack && !f.isFront)
  const extraFields  = sortedFields.filter(f => !f.isFront && !f.isBack)

  function startEdit() {
    const init: Record<string, string> = {}
    sortedFields.forEach(f => { init[f.key] = note.fields[f.key] ?? '' })
    setEditFields(init)
    setEditMode(true)
  }

  function cancelEdit() {
    setEditMode(false)
    setEditFields({})
  }

  async function handleSave() {
    setSaving(true)
    try {
      const updated: AnkiNote = { ...note, fields: { ...editFields } }
      await saveAnkiNote(updated, template)
      onNoteSaved(updated)
      setEditMode(false)
      toast('Card updated', 'success')
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  // ── View mode ───────────────────────────────────────────────────────────────
  if (!editMode) {
    const vf = resolvedFields ?? note.fields
    return (
      <>
        <div className="col-hd" style={{ padding: '10px 12px', flexShrink: 0 }}>
          <span>
            Detail
            {lastSeen && (
              <span style={{ fontWeight: 400, marginLeft: 8, textTransform: 'none', fontSize: 11 }}>
                · reviewed {lastSeen}
              </span>
            )}
          </span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="bci-edit-btn bci-edit-btn-hd" onClick={startEdit} title="Edit card">✎</button>
            <button className="detail-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <NoteMetaRow note={note} />

          {frontFields.length > 0 && (
            <>
              <div className="detail-section-hd">Question</div>
              <div className="detail-section-body">
                {frontFields.map(f => (
                  <ViewField key={f.key} field={f} value={vf[f.key] ?? ''} />
                ))}
              </div>
            </>
          )}

          {backFields.length > 0 && (
            <>
              <div className="detail-qa-divider" />
              <div className="detail-section-hd">Answer</div>
              <div className="detail-section-body">
                {backFields.map(f => (
                  <ViewField key={f.key} field={f} value={vf[f.key] ?? ''} />
                ))}
              </div>
            </>
          )}

          {extraFields.filter(f => vf[f.key]).length > 0 && (
            <>
              <div className="detail-qa-divider" />
              <div className="detail-section-hd">Extra</div>
              <div className="detail-section-body">
                {extraFields.filter(f => vf[f.key]).map(f => (
                  <ViewField key={f.key} field={f} value={vf[f.key] ?? ''} />
                ))}
              </div>
            </>
          )}
        </div>
      </>
    )
  }

  // ── Edit mode ───────────────────────────────────────────────────────────────
  return (
    <>
      <div className="col-hd" style={{ padding: '10px 12px', flexShrink: 0 }}>
        <span>Edit Card</span>
        <button className="detail-close-btn" onClick={cancelEdit} title="Cancel">✕</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 4px 12px' }}>
        <div className="record-form" style={{ padding: '8px 8px 0' }}>
          {sortedFields.map(f => (
            <EditField
              key={f.key}
              field={f}
              value={editFields[f.key] ?? ''}
              onChange={v => setEditFields(prev => ({ ...prev, [f.key]: v }))}
            />
          ))}

          <div className="rf-actions">
            <button className="rf-btn-cancel" onClick={cancelEdit} disabled={saving}>Cancel</button>
            <button className="rf-btn-save" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function NoteMetaRow({ note }: { note: AnkiNote }) {
  if (!note.deck && !note.tags.length) return null
  return (
    <div className="card-meta-row" style={{ padding: '8px 12px 0' }}>
      {note.deck && <span className="deck-badge">{note.deck.split('::').pop()}</span>}
      {note.tags.map(t => <span key={t} className="tag">{t.split('::').pop()}</span>)}
    </div>
  )
}
