// Modal for manually adding a single new Anki note.
// Front/Back (and html-typed) fields get the same Rich / HTML / Preview
// tab editor that the Browse edit panel uses. Other fields get plain inputs.

import { useEffect, useState } from 'react'
import type { AnkiField, AnkiNote, AnkiTemplate } from '../adapters/ankiRepo'
import { appendAnkiNote } from '../adapters/ankiRepo'
import { generateAnkiNoteForTemplate } from '../lib/ankiNoteGen'
import { LLM } from '../lib/llm'
import { sanitizeHtml } from '../lib/sanitize'
import { GAuth } from '../lib/gauth'
import {
  uploadInlineImages, uploadImageBlob, inferFilename, getOrCreateImageFolder,
} from '../lib/driveImages'
import RichEditor from './RichEditor'
import { useToast } from './Toast'

// Google Sheets caps any single cell at 50,000 characters. Embedding a
// pasted image as a base64 data: URL blows past that very quickly, so we
// (a) upload pasted images to Drive at paste time, (b) sweep the field on
// save in case a blob:/data: URL slipped in via HTML paste, and (c)
// pre-flight the cell-size limit and surface a clear error if anything is
// still too long — without losing the user's typed content.
const SHEETS_CELL_LIMIT = 50_000

type EditMode = 'rich' | 'html' | 'preview'

// Mirrors the EditField logic from NoteDetailPanel — Rich/HTML/Preview tabs
// for every field that is Front, Back, or explicitly typed as html.
function FieldEditor({
  field,
  value,
  onChange,
  disabled,
  onPasteImage,
}: {
  field:    AnkiField
  value:    string
  onChange: (v: string) => void
  disabled: boolean
  onPasteImage?: (blob: Blob) => Promise<string>
}) {
  const [mode, setMode] = useState<EditMode>('rich')
  const isRich = field.type === 'html' || field.isFront || field.isBack

  if (field.type === 'select') {
    const opts = field.options ? field.options.split(',').map(o => o.trim()).filter(Boolean) : []
    return (
      <div className="anote-field-row">
        <label className="anote-lbl">{field.label}</label>
        <select
          className="anote-select"
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
        >
          <option value="">—</option>
          {opts.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    )
  }

  if (isRich) {
    return (
      <div className="anote-field-row rf-row-col rf-html-field">
        <div className="rf-html-hd">
          <label className="anote-lbl" style={{ marginBottom: 0 }}>{field.label}</label>
          <div className="rf-html-tabs">
            {(['rich', 'html', 'preview'] as EditMode[]).map(m => (
              <button
                key={m}
                type="button"
                className={`rf-html-tab${mode === m ? ' active' : ''}`}
                onClick={() => setMode(m)}
                disabled={disabled}
              >
                {m === 'rich' ? 'Rich' : m === 'html' ? 'HTML' : 'Preview'}
              </button>
            ))}
          </div>
        </div>
        <div className="rf-html-body anote-editor-body">
          {mode === 'rich' && (
            <RichEditor value={value} onChange={onChange} onPasteImage={onPasteImage} />
          )}
          {mode === 'html' && (
            <textarea
              className="rf-textarea rf-html-editor"
              value={value}
              rows={6}
              spellCheck={false}
              onChange={e => onChange(e.target.value)}
              disabled={disabled}
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
    <div className="anote-field-row">
      <label className="anote-lbl">{field.label}</label>
      <input
        className="rf-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

interface Props {
  open:          boolean
  onClose:       () => void
  templates:     Map<string, AnkiTemplate>
  existingDecks: string[]
  existingTags:  string[]
  onNoteAdded:   (note: AnkiNote) => void
  defaultDeck?:  string  // optional pre-fill for the Deck field (used by sidebar "+ Deck" affordance)
}

export default function AddNoteModal({ open, onClose, templates, existingDecks, existingTags, onNoteAdded, defaultDeck }: Props) {
  const { toast } = useToast()
  const tplList = [...templates.values()]

  const [tplId,     setTplId]     = useState<string>('')
  const [deck,      setDeck]      = useState<string>('')
  const [tags,      setTags]      = useState<string[]>([])
  const [draftTag,  setDraftTag]  = useState<string>('')
  const [fields,    setFields]    = useState<Record<string, string>>({})
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string>('')
  const [aiPrompt,  setAiPrompt]  = useState<string>('')
  const [aiBusy,    setAiBusy]    = useState(false)
  const [aiError,   setAiError]   = useState<string>('')

  const selectedTemplate = templates.get(tplId)

  useEffect(() => {
    if (!open) return
    if (tplList.length > 0 && !tplId) setTplId(tplList[0].id)
    // Pre-fill the Deck field when the caller passed one (e.g. sidebar "+ Deck").
    if (defaultDeck) setDeck(defaultDeck)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset fields whenever template changes
  useEffect(() => {
    if (!selectedTemplate) return
    const init: Record<string, string> = {}
    selectedTemplate.fields.forEach(f => { init[f.key] = '' })
    setFields(init)
  }, [tplId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) {
      setError(''); setSaving(false); setFields({}); setDeck(''); setTags([]); setDraftTag('')
      setAiPrompt(''); setAiBusy(false); setAiError('')
    }
  }, [open])

  async function handleAiGenerate() {
    if (aiBusy) return
    if (!selectedTemplate) { setAiError('Pick a template first.'); return }
    const prompt = aiPrompt.trim()
    if (!prompt) { setAiError('Type what you want the card to cover.'); return }
    if (!LLM.isConfigured()) {
      setAiError('Azure OpenAI is not configured — open Settings to add the endpoint and API key.')
      return
    }
    setAiBusy(true); setAiError('')
    try {
      const draft = await generateAnkiNoteForTemplate(selectedTemplate, prompt)
      if (!draft) { setAiError("AI didn't return a usable card. Try a more specific prompt."); return }
      // Merge generated fields over the existing state, keeping the template's
      // full key set so optional fields stay defined (just blank).
      setFields(prev => ({ ...prev, ...draft.fields }))
      // Merge tags, dedup-preserving existing order.
      if (draft.tags.length > 0) {
        setTags(prev => {
          const seen = new Set(prev)
          const merged = [...prev]
          for (const t of draft.tags) if (t && !seen.has(t)) { seen.add(t); merged.push(t) }
          return merged
        })
      }
    } catch (e) {
      setAiError((e as Error).message)
    } finally {
      setAiBusy(false)
    }
  }

  function addTag(t: string) {
    const clean = t.trim()
    if (!clean || tags.includes(clean)) return
    setTags(prev => [...prev, clean])
    setDraftTag('')
  }

  function removeTag(t: string) {
    setTags(prev => prev.filter(x => x !== t))
  }

  // Flush any unconfirmed draft tag at save time
  function resolvedTags(): string[] {
    const draft = draftTag.trim()
    if (!draft || tags.includes(draft)) return tags
    return [...tags, draft]
  }

  const tagSuggestions = existingTags.filter(
    t => !tags.includes(t) && (!draftTag || t.toLowerCase().includes(draftTag.toLowerCase()))
  ).slice(0, 10)

  // Upload a pasted-image blob to Drive and return the Drive URL — used by
  // RichEditor's onPasteImage so the inserted <img> never carries a giant
  // base64 data: URL (which would bloat the cell past Sheets' 50k limit).
  async function pasteImageToDrive(blob: Blob): Promise<string> {
    const token = GAuth.getToken()
    if (!token) throw new Error('Not signed in — sign in first')
    const folderId = await getOrCreateImageFolder(token)
    return uploadImageBlob(token, folderId, blob, inferFilename(blob))
  }

  async function handleSave() {
    if (!selectedTemplate) { setError('Pick a template.'); return }
    if (!deck.trim())       { setError('Enter a deck name.'); return }
    setSaving(true); setError('')
    try {
      // Pre-flight #1: sweep any blob:/data:image/ URLs that slipped past
      // the paste handler (e.g. user pasted HTML from another tab) and
      // upload them to Drive in place. Without this they'd either explode
      // the cell size (data:) or break on reload (blob:).
      const token = GAuth.getToken()
      let processedFields = fields
      if (token) {
        const next: Record<string, string> = { ...fields }
        let touched = false
        for (const f of selectedTemplate.fields) {
          const v = next[f.key]
          if (!v) continue
          if (!(f.type === 'html' || f.isFront || f.isBack)) continue
          if (!/<img[^>]+src="(?:data:image\/|blob:)/i.test(v)) continue
          next[f.key] = await uploadInlineImages(v, token)
          touched = true
        }
        if (touched) {
          processedFields = next
          // Reflect the upload in the open modal so the user sees the
          // Drive-hosted URLs (helps if the next pre-flight check below
          // still flags an oversized field — they can edit knowingly).
          setFields(next)
        }
      }

      // Pre-flight #2: Sheets caps each cell at 50,000 characters. Refuse
      // the save (without losing typed content) and tell the user which
      // field is too long and by how much.
      for (const f of selectedTemplate.fields) {
        const v = processedFields[f.key] ?? ''
        if (v.length > SHEETS_CELL_LIMIT) {
          throw new Error(
            `Field "${f.label}" is ${v.length.toLocaleString()} characters — ` +
            `Google Sheets caps each cell at ${SHEETS_CELL_LIMIT.toLocaleString()}. ` +
            `Trim or split the content, then save again.`
          )
        }
      }

      const note: AnkiNote = {
        noteId:     `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        deck:       deck.trim(),
        ankiMod:    String(Date.now()),
        templateId: selectedTemplate.id,
        fields:     processedFields,
        tags: resolvedTags(),
      }
      await appendAnkiNote(note, selectedTemplate)
      toast('Note added', 'success')
      onNoteAdded(note)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const sortedFields = selectedTemplate
    ? [...selectedTemplate.fields].sort((a, b) => a.order - b.order)
    : []

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card anote-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="anki-gen-hd">
          <span className="anki-gen-title">Add Note</span>
          <button className="ai-icon-btn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="anote-body">
          {/* Template */}
          <label className="anote-lbl">
            Template
            <select value={tplId} onChange={e => setTplId(e.target.value)} disabled={saving}>
              {tplList.length === 0
                ? <option value="">No templates configured</option>
                : tplList.map(t => <option key={t.id} value={t.id}>{t.displayName}</option>)}
            </select>
          </label>

          {/* Deck */}
          <label className="anote-lbl">
            Deck
            <input
              className="rf-input"
              value={deck}
              onChange={e => setDeck(e.target.value)}
              list="anote-deck-list"
              placeholder="e.g. Programming::JS"
              disabled={saving}
            />
            <datalist id="anote-deck-list">
              {existingDecks.map(d => <option key={d} value={d} />)}
            </datalist>
          </label>

          {/* AI generate — fills Front/Back/extras for the selected template */}
          {selectedTemplate && (
            <div className="anote-ai-box">
              <div className="anote-ai-hd">
                <span className="anote-ai-title">✨ Generate with AI</span>
                <span className="anote-ai-sub">
                  Describe the topic — AI fills the fields below for <em>{selectedTemplate.displayName}</em>.
                </span>
              </div>
              <textarea
                className="rf-textarea anote-ai-input"
                rows={3}
                placeholder="e.g. CSS Flexbox justify-content vs align-items"
                value={aiPrompt}
                onChange={e => setAiPrompt(e.target.value)}
                disabled={aiBusy || saving}
              />
              <div className="anote-ai-actions">
                <button
                  type="button"
                  className="rf-btn-save"
                  onClick={handleAiGenerate}
                  disabled={aiBusy || saving || !aiPrompt.trim()}
                >{aiBusy ? 'Generating…' : '✨ Generate card'}</button>
                {aiError && <span className="anote-ai-err">{aiError}</span>}
              </div>
            </div>
          )}

          {/* Template fields — rich editor for Front/Back/html, plain for others */}
          {sortedFields.map(f => (
            <FieldEditor
              key={f.key}
              field={f}
              value={fields[f.key] ?? ''}
              onChange={v => setFields(prev => ({ ...prev, [f.key]: v }))}
              disabled={saving}
              onPasteImage={pasteImageToDrive}
            />
          ))}

          {/* Tags — chip input with live suggestions */}
          <div className="anote-field-row">
            <span className="anote-lbl">Tags</span>
            <div className="doc-tag-input-wrap">
              {tags.map(t => (
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
                  else if (e.key === 'Backspace' && !draftTag && tags.length) removeTag(tags[tags.length - 1])
                }}
                placeholder={tags.length ? '' : 'type to search or add…'}
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

          {error && <div className="login-error">{error}</div>}
        </div>

        <div className="anki-gen-actions">
          <button className="rf-btn-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="mgmt-save-btn"
            onClick={handleSave}
            disabled={saving || !tplId}
          >{saving ? 'Saving…' : 'Add Note'}</button>
        </div>
      </div>
    </div>
  )
}
