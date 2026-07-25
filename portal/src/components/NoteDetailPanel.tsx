import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import type { AnkiNote, AnkiTemplate, AnkiField } from '../adapters/ankiRepo'
import { saveAnkiNote } from '../adapters/ankiRepo'
import type { SRSRecord } from '../adapters/srsRepo'
import { GAuth } from '../lib/gauth'
import { inlineImagesToDataUri, blobToDataUri } from '../lib/driveImages'
import { resolveDriveImagesInHtml as resolveDriveImages } from '../lib/drive'
import { sanitizeHtml } from '../lib/sanitize'
import RichEditor from './RichEditor'
import { useToast } from './Toast'

function blobUrlsToDrive(html: string, blobToDrive: Map<string, string>): string {
  if (!blobToDrive.size) return html
  let out = html
  blobToDrive.forEach((driveUrl, blobUrl) => {
    if (out.includes(blobUrl)) out = out.replaceAll(blobUrl, driveUrl)
  })
  return out
}

type HtmlEditMode = 'rich' | 'html' | 'preview'

interface Props {
  note:           AnkiNote
  template:       AnkiTemplate
  rec:            SRSRecord | undefined
  lastSeen:       string
  onClose:        () => void
  onNoteSaved:    (note: AnkiNote) => void
  // All tags currently in use across notes, for the edit-mode tag suggestions.
  existingTags?:   string[]
  // When provided, the panel renders an ⤢/⤡ expand button next to ✎/✕
  // and treats double-click on its header as a toggle. Owned by the parent
  // view (BrowseView) which decides whether the cards list is hidden.
  expanded?:       boolean
  onToggleExpand?: () => void
}

// ── View mode: single field renderer (always renders as HTML) ────────────────

function ViewField({ field, value }: { field: AnkiField; value: string }) {
  if (!value) return <div className="section-empty-val">—</div>
  return (
    <div className="detail-field-wrap">
      <div className="section-hd">{field.label}</div>
      <div className="section-html-body" dangerouslySetInnerHTML={{ __html: sanitizeHtml(value) }} />
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
  onPasteImage,
}: {
  field:    AnkiField
  value:    string
  onChange: (v: string) => void
  onPasteImage?: (blob: Blob) => Promise<string>
}) {
  const [mode, setMode] = useState<HtmlEditMode>('rich')
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
            {(['rich', 'html', 'preview'] as HtmlEditMode[]).map(m => (
              <button
                key={m}
                className={`rf-html-tab${mode === m ? ' active' : ''}`}
                onClick={() => setMode(m)}
              >
                {m === 'rich' ? 'Rich' : m === 'html' ? 'HTML' : 'Preview'}
              </button>
            ))}
          </div>
        </div>
        <div className="rf-html-body">
          {mode === 'rich' && (
            <RichEditor value={value} onChange={onChange} onPasteImage={onPasteImage} />
          )}
          {mode === 'html' && (
            <textarea
              className="rf-textarea rf-html-editor"
              value={value}
              rows={8}
              spellCheck={false}
              onChange={e => onChange(e.target.value)}
            />
          )}
          {mode === 'preview' && (
            <div
              className="rf-html-preview section-html-body"
              dangerouslySetInnerHTML={{
                __html: value ? sanitizeHtml(value) : '<em style="opacity:.45">No content</em>',
              }}
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
  existingTags = [],
  expanded, onToggleExpand,
}: Props) {
  const { toast } = useToast()
  const [editMode, setEditMode] = useState(false)
  const [editFields, setEditFields] = useState<Record<string, string>>({})
  const [editTags, setEditTags] = useState<string[]>([])
  const [draftTag, setDraftTag] = useState('')
  const [saving, setSaving] = useState(false)
  const [resolvedFields, setResolvedFields] = useState<Record<string, string> | null>(null)
  const blobUrlsRef    = useRef<string[]>([])
  const blobToDriveRef = useRef<Map<string, string>>(new Map())

  // Refs that mirror the in-flight edit so we can save the OLD note even after
  // the parent has swapped `note`/`template` props on us.
  const editingNoteRef     = useRef<AnkiNote | null>(null)
  const editingTemplateRef = useRef<AnkiTemplate | null>(null)
  const editFieldsRef      = useRef<Record<string, string>>({})
  const editTagsRef        = useRef<string[]>([])
  const onNoteSavedRef     = useRef(onNoteSaved)
  useEffect(() => { editFieldsRef.current  = editFields  }, [editFields])
  useEffect(() => { editTagsRef.current    = editTags   }, [editTags])
  useEffect(() => { onNoteSavedRef.current = onNoteSaved }, [onNoteSaved])

  const sortedFields = [...template.fields].sort((a, b) => a.order - b.order)

  useEffect(() => {
    setResolvedFields(null)
    const token = GAuth.getToken()
    if (!token) return
    // Reset the *shared* refs that paste will also write into. Using the live
    // refs (instead of scratch locals + replace at the end) avoids clobbering
    // entries that the paste handler adds while the resolve is still running.
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current    = []
    blobToDriveRef.current = new Map()
    const sharedBlobUrls = blobUrlsRef.current
    const sharedMap      = blobToDriveRef.current
    let cancelled = false
    Promise.all(
      sortedFields.map(async f => {
        const val = note.fields[f.key] ?? ''
        const resolved = await resolveDriveImages(val, token, sharedBlobUrls, sharedMap)
        return [f.key, resolved] as [string, string]
      })
    ).then(pairs => {
      if (cancelled) { sharedBlobUrls.forEach(u => URL.revokeObjectURL(u)); return }
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
    // Prefer resolved (blob:URL) fields so <img> tags render inside the rich
    // editor; fall back to the raw note fields if resolution hasn't completed.
    const source = resolvedFields ?? note.fields
    const init: Record<string, string> = {}
    sortedFields.forEach(f => { init[f.key] = source[f.key] ?? '' })
    editingNoteRef.current     = note
    editingTemplateRef.current = template
    editFieldsRef.current      = init
    editTagsRef.current        = note.tags
    setEditFields(init)
    setEditTags(note.tags)
    setDraftTag('')
    setEditMode(true)
  }

  function addTag(t: string) {
    const clean = t.trim()
    if (!clean) { setDraftTag(''); return }
    setEditTags(prev => prev.includes(clean) ? prev : [...prev, clean])
    setDraftTag('')
  }

  function removeTag(t: string) {
    setEditTags(prev => prev.filter(x => x !== t))
  }

  // Flush any unconfirmed draft tag so it isn't lost on save.
  function resolvedTags(tags: string[], draft: string): string[] {
    const clean = draft.trim()
    if (!clean || tags.includes(clean)) return tags
    return [...tags, clean]
  }

  const tagSuggestions = existingTags.filter(
    t => !editTags.includes(t) && (!draftTag || t.toLowerCase().includes(draftTag.toLowerCase()))
  ).slice(0, 10)

  // Inline pasted images as self-contained data: URIs so the saved HTML loads
  // without the portal's OAuth token (e.g. when copied into Anki). The
  // blobToDrive map is still populated by resolveDriveImages for images that
  // already live on Drive from before this change.
  function handlePasteImage(blob: Blob): Promise<string> {
    return blobToDataUri(blob)
  }

  // Prep field HTML for the sheet:
  //   1. Rewrite resolved blob: URLs back to their pre-existing Drive URLs
  //      (images that were already Drive-hosted before the inline-image change).
  //   2. Inline any leftover blob: images as data: URIs; throw on failure so we
  //      never silently store an unloadable URL.
  //   3. Sanitise — strips event-handler attrs / javascript: hrefs / scripts
  //      so untrusted content already in the sheet (e.g. migrated Anki decks)
  //      gets cleaned on first save.
  async function normalizeFieldsForSave(
    fields: Record<string, string>,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(fields)) {
      let html = blobUrlsToDrive(v, blobToDriveRef.current)
      html = await inlineImagesToDataUri(html)
      html = sanitizeHtml(html)
      out[k] = html
    }
    return out
  }

  function clearEditState() {
    editingNoteRef.current     = null
    editingTemplateRef.current = null
    editFieldsRef.current      = {}
    editTagsRef.current        = []
    setEditMode(false)
    setEditFields({})
    setEditTags([])
    setDraftTag('')
  }

  function cancelEdit() {
    clearEditState()
  }

  function isDirty(orig: AnkiNote, fields: Record<string, string>, tags: string[]): boolean {
    const keys = new Set([...Object.keys(orig.fields), ...Object.keys(fields)])
    for (const k of keys) {
      if ((orig.fields[k] ?? '') !== (fields[k] ?? '')) return true
    }
    if (orig.tags.length !== tags.length || orig.tags.some((t, i) => t !== tags[i])) return true
    return false
  }

  async function handleSave() {
    const editingNote = editingNoteRef.current ?? note
    const editingTmpl = editingTemplateRef.current ?? template
    setSaving(true)
    try {
      const fields  = await normalizeFieldsForSave(editFieldsRef.current)
      const tags    = resolvedTags(editTagsRef.current, draftTag)
      const updated: AnkiNote = { ...editingNote, fields, tags }
      await saveAnkiNote(updated, editingTmpl)
      onNoteSavedRef.current(updated)
      clearEditState()
      toast('Card updated', 'success')
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  // Background save (after user picked "save" on the unsaved-changes prompt
  // for a note we are no longer viewing). Doesn't touch local edit state.
  function backgroundSave(orig: AnkiNote, tmpl: AnkiTemplate, fields: Record<string, string>, tags: string[]) {
    ;(async () => {
      try {
        const normalized = await normalizeFieldsForSave(fields)
        const updated: AnkiNote = { ...orig, fields: normalized, tags }
        await saveAnkiNote(updated, tmpl)
        onNoteSavedRef.current(updated)
        toast('Card saved', 'success')
      } catch (e) {
        toast(`Save failed: ${(e as Error).message}`, 'error')
      }
    })()
  }

  // Selecting a different note while editing → prompt to save if dirty,
  // then drop edit state so the new note shows in view mode.
  useLayoutEffect(() => {
    const prev = editingNoteRef.current
    if (!prev || prev.noteId === note.noteId) return
    const tmpl   = editingTemplateRef.current
    const fields = editFieldsRef.current
    const tags   = editTagsRef.current
    if (tmpl && isDirty(prev, fields, tags)) {
      const yes = window.confirm(
        `You have unsaved changes on the previous card. Save them before switching?`
      )
      if (yes) backgroundSave(prev, tmpl, fields, tags)
    }
    clearEditState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.noteId])

  function handleClose() {
    const editingNote = editingNoteRef.current
    const editingTmpl = editingTemplateRef.current
    if (!editingNote || !editingTmpl || !isDirty(editingNote, editFieldsRef.current, editTagsRef.current)) {
      clearEditState()
      onClose()
      return
    }
    const yes = window.confirm('You have unsaved changes. Save them before closing?')
    if (yes) {
      backgroundSave(editingNote, editingTmpl, editFieldsRef.current, editTagsRef.current)
    }
    clearEditState()
    onClose()
  }

  // ── View mode ───────────────────────────────────────────────────────────────
  if (!editMode) {
    const vf = resolvedFields ?? note.fields
    return (
      <>
        <div
          className="col-hd doc-detail-hd"
          style={{ padding: '10px 12px', flexShrink: 0 }}
          onDoubleClick={onToggleExpand}
          title={onToggleExpand ? 'Double-click to expand / restore' : undefined}
        >
          <span>
            Detail
            {lastSeen && (
              <span style={{ fontWeight: 400, marginLeft: 8, textTransform: 'none', fontSize: 11 }}>
                · reviewed {lastSeen}
              </span>
            )}
          </span>
          <div
            style={{ display: 'flex', gap: 6, alignItems: 'center' }}
            onDoubleClick={e => e.stopPropagation()}
          >
            <button className="bci-edit-btn bci-edit-btn-hd" onClick={startEdit} title="Edit card">✎</button>
            {onToggleExpand && (
              <button
                className={`bci-edit-btn bci-edit-btn-hd${expanded ? ' active' : ''}`}
                onClick={onToggleExpand}
                title={expanded ? 'Show list' : 'Expand viewer'}
              >{expanded ? '⤡' : '⤢'}</button>
            )}
            <button className="detail-close-btn" onClick={handleClose}>✕</button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', maxHeight: 'calc(100vh - 56px - 50px)' }}>
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
      <div
        className="col-hd doc-detail-hd"
        style={{ padding: '10px 12px', flexShrink: 0 }}
        onDoubleClick={onToggleExpand}
        title={onToggleExpand ? 'Double-click to expand / restore' : undefined}
      >
        <span>Edit Card</span>
        <div
          style={{ display: 'flex', gap: 6, alignItems: 'center' }}
          onDoubleClick={e => e.stopPropagation()}
        >
          {onToggleExpand && (
            <button
              className={`bci-edit-btn bci-edit-btn-hd${expanded ? ' active' : ''}`}
              onClick={onToggleExpand}
              title={expanded ? 'Show list' : 'Expand viewer'}
            >{expanded ? '⤡' : '⤢'}</button>
          )}
          <button className="detail-close-btn" onClick={handleClose} title="Close">✕</button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', maxHeight: 'calc(100vh - 56px - 50px)', padding: '0 4px 12px' }}>
        <div className="record-form" style={{ padding: '8px 8px 0' }}>
          {sortedFields.map(f => (
            <EditField
              key={f.key}
              field={f}
              value={editFields[f.key] ?? ''}
              onChange={v => setEditFields(prev => ({ ...prev, [f.key]: v }))}
              onPasteImage={handlePasteImage}
            />
          ))}

          {/* Tags — chip input with live suggestions */}
          <div className="rf-row rf-row-col">
            <label className="rf-label">Tags</label>
            <div className="doc-tag-input-wrap">
              {editTags.map(t => (
                <span key={t} className="doc-tag-chip">
                  {t}
                  <button type="button" onClick={() => removeTag(t)} disabled={saving}>×</button>
                </span>
              ))}
              <input
                className="doc-tag-input"
                value={draftTag}
                onChange={e => setDraftTag(e.target.value)}
                onBlur={() => addTag(draftTag)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(draftTag) }
                  else if (e.key === 'Backspace' && !draftTag && editTags.length) removeTag(editTags[editTags.length - 1])
                }}
                placeholder={editTags.length ? '' : 'type to search or add…'}
                disabled={saving}
              />
            </div>
            {tagSuggestions.length > 0 && (
              <div className="doc-tag-suggestions">
                {tagSuggestions.map(s => (
                  <button
                    key={s}
                    type="button"
                    className="doc-tag-suggestion"
                    onMouseDown={e => { e.preventDefault(); addTag(s) }}
                    disabled={saving}
                  >+ {s}</button>
                ))}
              </div>
            )}
          </div>

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
