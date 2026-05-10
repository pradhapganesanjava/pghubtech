import { useEffect, useMemo, useRef, useState } from 'react'
import { LLM } from '../lib/llm'
import { sanitizeHtml } from '../lib/sanitize'
import { stopAll } from '../lib/audioRegistry'
import { exportConversationAsDoc } from '../lib/conversationExport'
import {
  appendMessage, deleteConversation, loadAllMessages, newConvId, summarise,
} from '../adapters/aiChatRepo'
import type { AIMessage, ConversationSummary } from '../adapters/aiChatRepo'
import MessageAudio from './MessageAudio'
import AnkiCardGenModal from './AnkiCardGenModal'
import { useToast } from './Toast'

interface Props {
  open:    boolean
  onClose: () => void
}

const DEFAULT_W = 440
const DEFAULT_H = 580
const MIN_W     = 320
const MIN_H     = 320
const MAX_W     = 1100
const MAX_H     = 1000

export default function AskAIPanel({ open, onClose }: Props) {
  const { toast } = useToast()
  const [allMsgs, setAllMsgs]       = useState<AIMessage[]>([])
  const [convId, setConvId]         = useState<string>(() => newConvId())
  const [draft, setDraft]           = useState('')
  const [busy, setBusy]             = useState(false)
  const [error, setError]           = useState('')
  const [showHistory, setShowHist]  = useState(false)
  const [maximized, setMaximized]   = useState(false)
  const [size, setSize]             = useState({ w: DEFAULT_W, h: DEFAULT_H })
  const [saving, setSaving]         = useState(false)
  const [ankiOpen, setAnkiOpen]     = useState(false)

  const resizingRef = useRef(false)
  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  // ── Load existing conversations once we're signed-in and panel opens ─────
  useEffect(() => {
    if (!open || allMsgs.length > 0) return
    loadAllMessages()
      .then(setAllMsgs)
      .catch(e => toast(`Could not load past chats: ${(e as Error).message}`, 'error'))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stop any audio when the panel closes.
  useEffect(() => { if (!open) stopAll() }, [open])

  // ── Derived: messages for the current conversation, conv list ────────────
  const currentMsgs = useMemo(
    () => allMsgs.filter(m => m.convId === convId).sort((a, b) => a.ts.localeCompare(b.ts)),
    [allMsgs, convId],
  )
  const conversations: ConversationSummary[] = useMemo(() => summarise(allMsgs), [allMsgs])

  // ── Send / receive ────────────────────────────────────────────────────────
  async function send() {
    const prompt = draft.trim()
    if (!prompt || busy) return
    setError('')
    if (!LLM.isConfigured()) {
      setError('Configure Azure OpenAI in Settings → AI Assistant.')
      return
    }
    const userMsg: AIMessage = { convId, ts: new Date().toISOString(), role: 'user', content: prompt }
    setAllMsgs(prev => [...prev, userMsg])
    setDraft('')
    setBusy(true)
    appendMessage(userMsg).catch(() => { /* sheet failure is non-fatal for the UI */ })

    try {
      // Pass the conversation as context so multi-turn works.
      const history = [...currentMsgs, userMsg].map(m => ({ role: m.role, content: m.content }))
      const reply = await LLM.chat(history)
      const aiMsg: AIMessage = { convId, ts: new Date().toISOString(), role: 'assistant', content: reply }
      setAllMsgs(prev => [...prev, aiMsg])
      appendMessage(aiMsg).catch(() => { /* ignore */ })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function startNewChat() {
    stopAll()
    setConvId(newConvId())
    setShowHist(false)
    setError('')
  }

  function selectConversation(id: string) {
    stopAll()
    setConvId(id)
    setShowHist(false)
    setError('')
  }

  async function removeConversation(id: string) {
    if (!window.confirm('Delete this conversation? This removes all messages from the sheet.')) return
    try {
      await deleteConversation(id)
      setAllMsgs(prev => prev.filter(m => m.convId !== id))
      if (convId === id) startNewChat()
      toast('Conversation deleted', 'success')
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'error')
    }
  }

  async function saveAsDoc() {
    if (currentMsgs.length === 0 || saving) return
    setSaving(true); setError('')
    try {
      const rec = await exportConversationAsDoc(
        currentMsgs.map(m => ({ role: m.role, content: m.content })),
        'Ask AI',
      )
      toast(`Saved to Docs as "${rec.alias}"`, 'success')
    } catch (e) {
      const msg = (e as Error).message
      setError(`Save failed: ${msg}`)
      toast(`Save failed: ${msg}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  // ── Resize handle (bottom-LEFT corner: panel is anchored top-right) ──────
  function onResizeDown(e: React.PointerEvent<HTMLDivElement>) {
    if (maximized) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizingRef.current = true
    resizeStart.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h }
    document.body.classList.add('resizing-h')
  }
  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizingRef.current || !resizeStart.current) return
    const start = resizeStart.current
    // Anchored top-right ⇒ growing leftwards = wider, downwards = taller.
    const dx = start.x - e.clientX
    const dy = e.clientY - start.y
    const w = Math.min(MAX_W, Math.max(MIN_W, start.w + dx))
    const h = Math.min(MAX_H, Math.max(MIN_H, start.h + dy))
    setSize({ w, h })
  }
  function onResizeUp(e: React.PointerEvent<HTMLDivElement>) {
    resizingRef.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  if (!open) return null

  // Newest message at the top → reverse for render
  const reversed = currentMsgs.slice().reverse()
  const wrapStyle: React.CSSProperties = maximized
    ? {}
    : { width: size.w, height: size.h }

  return (
    <div className={`ai-panel${maximized ? ' maximized' : ''}`} style={wrapStyle} role="dialog" aria-label="Ask AI">
      <div className="ai-panel-hd">
        <span className="ai-panel-title">✨ Ask AI</span>
        <div className="ai-panel-hd-actions">
          <button
            className="ai-icon-btn"
            onClick={() => setShowHist(s => !s)}
            title="Conversations"
          >🗂</button>
          <button
            className="ai-icon-btn"
            onClick={() => setAnkiOpen(true)}
            title={currentMsgs.length === 0 ? 'Nothing to convert yet' : 'Generate Anki cards from this conversation'}
            disabled={currentMsgs.length === 0}
          >🃏</button>
          <button
            className="ai-icon-btn"
            onClick={saveAsDoc}
            title={currentMsgs.length === 0 ? 'Nothing to save yet' : 'Save conversation as a Doc'}
            disabled={currentMsgs.length === 0 || saving}
          >{saving ? '…' : '💾'}</button>
          <button
            className="ai-icon-btn"
            onClick={startNewChat}
            title="New chat"
          >＋</button>
          <button
            className="ai-icon-btn"
            onClick={() => setMaximized(m => !m)}
            title={maximized ? 'Restore' : 'Maximize'}
          >{maximized ? '🗗' : '🗖'}</button>
          <button className="ai-icon-btn" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* Conversation picker (drops down from header) */}
      {showHistory && (
        <div className="ai-conv-list">
          {conversations.length === 0 && (
            <div className="ai-conv-empty">No past conversations</div>
          )}
          {conversations.map(c => (
            <div
              key={c.convId}
              className={`ai-conv-row${c.convId === convId ? ' active' : ''}`}
            >
              <button className="ai-conv-pick" onClick={() => selectConversation(c.convId)} title={c.title}>
                <span className="ai-conv-title">{c.title}</span>
                <span className="ai-conv-meta">{c.msgCount} msg · {fmtDate(c.lastTs)}</span>
              </button>
              <button className="ai-conv-rm" onClick={() => removeConversation(c.convId)} title="Delete">🗑</button>
            </div>
          ))}
        </div>
      )}

      {/* Input (top) */}
      <div className="ai-panel-input">
        <textarea
          className="ai-textarea"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Ask AI…  (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={busy}
        />
        <button
          className="ai-send-btn"
          onClick={send}
          disabled={busy || !draft.trim()}
          title="Send"
        >➤</button>
      </div>
      {error && <div className="ai-panel-err">{error}</div>}

      {/* Reversed message list — newest just below the input, older below */}
      <div className="ai-panel-body">
        {busy && (
          <div className="ai-msg ai-msg-assistant">
            <div className="ai-typing"><span /><span /><span /></div>
          </div>
        )}
        {reversed.length === 0 && !busy && (
          <div className="ai-panel-empty">
            Type a question above. Each AI response gets its own play button —
            click 🔊 to have it read aloud.
          </div>
        )}
        {reversed.map((m, i) => (
          <div key={`${m.ts}-${i}`} className={`ai-msg ai-msg-${m.role}`}>
            <div
              className="ai-msg-body"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(simpleMd(m.content)) }}
            />
            {m.role === 'assistant' && (
              <div className="msg-audio-track">
                <MessageAudio text={m.content} cacheKey={`${m.convId}|${m.ts}`} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Resize handle (bottom-left) */}
      {!maximized && (
        <div
          className="ai-panel-resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          title="Drag to resize"
        />
      )}

      <AnkiCardGenModal
        open={ankiOpen}
        onClose={() => setAnkiOpen(false)}
        msgs={currentMsgs.map(m => ({ role: m.role, content: m.content }))}
        contextLabel="Ask AI"
      />
    </div>
  )
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const today = new Date(); today.setHours(0,0,0,0)
  const same = d.toDateString() === today.toDateString()
  return same
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString()
}

// Tiny markdown-ish formatter — bold, italic, code, code blocks, line breaks.
// Output is then run through DOMPurify so any unintended HTML is neutralised.
function simpleMd(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>')
}
