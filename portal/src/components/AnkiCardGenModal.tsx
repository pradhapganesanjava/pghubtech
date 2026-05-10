// Modal launched from an AI chat panel's "Generate Anki cards" button.
// Generates Q&A drafts from the conversation, lets the user pick a deck +
// template, edit each card inline, and bulk-save them as Anki notes.

import { useEffect, useState } from 'react'
import {
  appendAnkiNote, loadAnkiTemplates, loadAllNotes,
} from '../adapters/ankiRepo'
import type { AnkiNote, AnkiTemplate } from '../adapters/ankiRepo'
import { generateAnkiCardsFromConversation } from '../lib/ankiCardGen'
import type { AnkiCardDraft } from '../lib/ankiCardGen'
import { useToast } from './Toast'

interface Props {
  open:     boolean
  onClose:  () => void
  msgs:     { role: 'user' | 'assistant'; content: string }[]
  // Used as the default deck name and seeded into every card's tag list.
  contextLabel?: string
}

const DEFAULT_DECK = 'AI Chat'

export default function AnkiCardGenModal({ open, onClose, msgs, contextLabel }: Props) {
  const { toast } = useToast()
  const [templates, setTemplates] = useState<AnkiTemplate[]>([])
  const [tplId, setTplId]         = useState<string>('')
  const [decks, setDecks]         = useState<string[]>([])
  const [deck, setDeck]           = useState<string>(DEFAULT_DECK)
  const [drafts, setDrafts]       = useState<AnkiCardDraft[]>([])
  const [busy, setBusy]           = useState(false)
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState<string>('')

  // Load templates + existing decks on open.
  useEffect(() => {
    if (!open) return
    setError('')
    loadAnkiTemplates()
      .then(async map => {
        const list = [...map.values()].filter(t => t.fields.some(f => f.isFront) && t.fields.some(f => f.isBack))
        setTemplates(list)
        if (list.length > 0 && !tplId) setTplId(list[0].id)
        // Pre-fill the deck dropdown from existing notes so the user can pick a familiar one.
        try {
          const all = await loadAllNotes(map)
          const seen = new Set<string>()
          for (const n of all) if (n.deck) seen.add(n.deck)
          setDecks([...seen].sort((a, b) => a.localeCompare(b)))
        } catch { /* non-fatal */ }
      })
      .catch(e => setError(`Could not load templates: ${(e as Error).message}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Reset everything when the modal closes.
  useEffect(() => {
    if (!open) { setDrafts([]); setError(''); setBusy(false); setSaving(false) }
  }, [open])

  async function generate() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const cards = await generateAnkiCardsFromConversation(msgs)
      if (cards.length === 0) {
        setError("AI didn't return any cards. The conversation may be too short or off-topic.")
      } else {
        setDrafts(cards)
      }
    } catch (e) {
      setError(`Generate failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  function updateDraft(i: number, patch: Partial<AnkiCardDraft>) {
    setDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, ...patch } : d))
  }
  function removeDraft(i: number) {
    setDrafts(prev => prev.filter((_, idx) => idx !== i))
  }

  async function saveAll() {
    if (saving || drafts.length === 0) return
    const tpl = templates.find(t => t.id === tplId)
    if (!tpl) { setError('Pick a template first.'); return }
    const frontKey = tpl.fields.filter(f => f.isFront).sort((a, b) => a.order - b.order)[0]?.key
    const backKey  = tpl.fields.filter(f => f.isBack).sort((a, b) => a.order - b.order)[0]?.key
    if (!frontKey || !backKey) {
      setError('Selected template needs at least one Front and one Back field.')
      return
    }
    const deckName = deck.trim() || DEFAULT_DECK
    setSaving(true); setError('')
    let savedCount = 0
    try {
      for (const d of drafts) {
        const note: AnkiNote = {
          noteId:     `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          deck:       deckName,
          ankiMod:    String(Date.now()),
          templateId: tpl.id,
          fields: {
            ...Object.fromEntries(tpl.fields.map(f => [f.key, ''])),
            [frontKey]: d.question,
            [backKey]:  d.answer,
          },
          tags: dedupeTags([...(contextLabel ? [tagify(contextLabel)] : []), 'ai-generated', ...d.tags]),
        }
        await appendAnkiNote(note, tpl)
        savedCount++
      }
      toast(`Saved ${savedCount} card${savedCount === 1 ? '' : 's'} to ${deckName}`, 'success')
      onClose()
    } catch (e) {
      setError(`Saved ${savedCount}/${drafts.length}. Failed: ${(e as Error).message}`)
      toast(`Save failed after ${savedCount} card${savedCount === 1 ? '' : 's'}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card anki-gen-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="anki-gen-hd">
          <span className="anki-gen-title">🃏 Generate Anki cards from conversation</span>
          <button className="ai-icon-btn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="anki-gen-body">
          <div className="anki-gen-controls">
            <label>
              Template
              <select value={tplId} onChange={e => setTplId(e.target.value)} disabled={busy || saving}>
                {templates.length === 0 && <option value="">No templates with Front+Back fields</option>}
                {templates.map(t => <option key={t.id} value={t.id}>{t.displayName}</option>)}
              </select>
            </label>
            <label>
              Deck
              <input
                value={deck}
                onChange={e => setDeck(e.target.value)}
                list="anki-gen-deck-list"
                placeholder={DEFAULT_DECK}
                disabled={busy || saving}
              />
              <datalist id="anki-gen-deck-list">
                {decks.map(d => <option key={d} value={d} />)}
              </datalist>
            </label>
            <button
              className="rf-btn-save"
              onClick={generate}
              disabled={busy || saving || templates.length === 0 || msgs.length === 0}
            >{busy ? 'Generating…' : drafts.length === 0 ? '✨ Generate' : '↻ Regenerate'}</button>
          </div>

          {error && <div className="login-error" style={{ margin: '8px 0' }}>{error}</div>}

          {drafts.length === 0 && !busy && (
            <div className="col-empty">
              Click <strong>✨ Generate</strong> to ask AI for Q&amp;A cards from this conversation.
              You'll review and edit them before saving.
            </div>
          )}

          {drafts.length > 0 && (
            <div className="anki-gen-list">
              {drafts.map((d, i) => (
                <div key={i} className="anki-gen-card">
                  <div className="anki-gen-card-hd">
                    <span className="anki-gen-card-num">#{i + 1}</span>
                    <button
                      className="todo-rm"
                      onClick={() => removeDraft(i)}
                      title="Drop this card"
                      disabled={saving}
                    >✕</button>
                  </div>
                  <label className="anki-gen-lbl">Question</label>
                  <textarea
                    className="rf-textarea"
                    rows={2}
                    value={d.question}
                    onChange={e => updateDraft(i, { question: e.target.value })}
                    disabled={saving}
                  />
                  <label className="anki-gen-lbl">Answer</label>
                  <textarea
                    className="rf-textarea"
                    rows={4}
                    value={d.answer}
                    onChange={e => updateDraft(i, { answer: e.target.value })}
                    disabled={saving}
                  />
                  <label className="anki-gen-lbl">Tags (comma separated)</label>
                  <input
                    className="rf-input"
                    value={d.tags.join(', ')}
                    onChange={e => updateDraft(i, {
                      tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean),
                    })}
                    disabled={saving}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="anki-gen-actions">
          <button className="rf-btn-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="mgmt-save-btn"
            onClick={saveAll}
            disabled={saving || drafts.length === 0 || !tplId}
          >{saving ? 'Saving…' : `Save ${drafts.length} card${drafts.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </div>
  )
}

function tagify(s: string): string {
  return s.toLowerCase().replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').slice(0, 32) || 'chat'
}

function dedupeTags(arr: string[]): string[] {
  const seen = new Set<string>(); const out: string[] = []
  for (const t of arr) { const v = t.trim(); if (v && !seen.has(v)) { seen.add(v); out.push(v) } }
  return out
}
