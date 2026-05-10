// Floating AI chat — same look-and-feel as AskAIPanel but with no
// persistence: messages live only in component state and are wiped when
// the panel closes. Used by the Activity Log so a quick question stays
// scoped to that context without polluting the AIChat history.

import { useEffect, useRef, useState } from 'react'
import { LLM } from '../lib/llm'
import { sanitizeHtml } from '../lib/sanitize'
import { stopAll } from '../lib/audioRegistry'
import { exportConversationAsDoc } from '../lib/conversationExport'
import { parseLooseJson } from '../lib/looseJson'
import MessageAudio from './MessageAudio'
import AnkiCardGenModal from './AnkiCardGenModal'
import { useToast } from './Toast'

interface Props {
  open:           boolean
  onClose:        () => void
  title?:         string    // header label
  systemPrompt?:  string    // optional priming instruction
  // Cap on the LLM response length. Bigger when expecting structured JSON
  // back, since truncation breaks the parser. Defaults to 800.
  maxTokens?:     number
  // When provided, assistant messages are scanned for a JSON payload and an
  // "Apply" button is rendered inline. Click → onApply(parsed). The parent
  // decides what to do with the structured data (e.g. populate a form).
  onApply?:       (parsed: unknown) => void | Promise<void>
}

interface Msg {
  role:    'user' | 'assistant'
  content: string
  err?:    boolean
}

const DEFAULT_W = 420
const DEFAULT_H = 540
const MIN_W     = 320
const MIN_H     = 320
const MAX_W     = 1100
const MAX_H     = 1000

export default function EphemeralAIChat({
  open, onClose, title = 'Ask AI', systemPrompt, maxTokens, onApply,
}: Props) {
  const { toast } = useToast()
  const [msgs, setMsgs]         = useState<Msg[]>([])
  const [draft, setDraft]       = useState('')
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState('')
  const [maximized, setMax]     = useState(false)
  const [size, setSize]         = useState({ w: DEFAULT_W, h: DEFAULT_H })
  const [listening, setListening] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [ankiOpen, setAnkiOpen] = useState(false)
  const resizingRef             = useRef(false)
  const resizeStart             = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const recogRef                = useRef<any>(null)
  const dictBaseRef             = useRef('')   // draft text captured at the moment dictation started

  // Wipe state on close so each session starts clean.
  useEffect(() => {
    if (!open) {
      stopAll()
      stopDictation()
      setMsgs([]); setDraft(''); setError(''); setMax(false)
      setSize({ w: DEFAULT_W, h: DEFAULT_H })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ── Voice → text (Web Speech API; Chrome/Mac, Safari/iOS) ─────────────
  function stopDictation() {
    try { recogRef.current?.stop() } catch { /* ignore */ }
    recogRef.current = null
    setListening(false)
  }
  function toggleMic() {
    if (listening) { stopDictation(); return }
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      setError('Voice dictation is not supported in this browser. Try Chrome on macOS or Safari on iOS.')
      return
    }
    setError('')
    const r = new SR()
    r.continuous     = true
    r.interimResults = true
    r.lang           = navigator.language || 'en-US'
    dictBaseRef.current = draft.length === 0 || /\s$/.test(draft) ? draft : draft + ' '
    r.onresult = (event: any) => {
      let combined = ''
      for (let i = 0; i < event.results.length; i++) {
        combined += event.results[i][0].transcript
      }
      setDraft(dictBaseRef.current + combined)
    }
    r.onerror = (e: any) => {
      setError(`Mic error: ${e.error || 'unknown'}`)
      stopDictation()
    }
    r.onend = () => { setListening(false); recogRef.current = null }
    try {
      r.start()
      recogRef.current = r
      setListening(true)
    } catch (e) {
      setError(`Could not start mic: ${(e as Error).message}`)
    }
  }

  async function send() {
    const prompt = draft.trim()
    if (!prompt || busy) return
    setError('')
    if (!LLM.isConfigured()) {
      setError('Configure Azure OpenAI in Settings → AI Assistant.')
      return
    }
    const next: Msg = { role: 'user', content: prompt }
    setMsgs(prev => [...prev, next])
    setDraft('')
    setBusy(true)
    try {
      const history: { role: 'user' | 'assistant' | 'system'; content: string }[] = []
      if (systemPrompt) history.push({ role: 'system', content: systemPrompt })
      msgs.forEach(m => history.push({ role: m.role, content: m.content }))
      history.push({ role: 'user', content: prompt })
      const reply = await LLM.chat(history, maxTokens)
      setMsgs(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (e) {
      setMsgs(prev => [...prev, { role: 'assistant', content: (e as Error).message, err: true }])
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setMsgs([]); setDraft(''); setError('')
    stopAll()
    stopDictation()
  }

  async function saveAsDoc() {
    if (msgs.length === 0 || saving) return
    setSaving(true); setError('')
    try {
      const rec = await exportConversationAsDoc(
        msgs.map(m => ({ role: m.role, content: m.content })),
        title,
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

  // Resize handle — bottom-left so the panel can grow up/left.
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

  const reversed = msgs.slice().reverse()
  const wrapStyle: React.CSSProperties = maximized ? {} : { width: size.w, height: size.h }

  return (
    <div
      className={`ai-panel${maximized ? ' maximized' : ''}`}
      style={wrapStyle}
      role="dialog"
      aria-label={title}
    >
      <div className="ai-panel-hd">
        <span className="ai-panel-title">✨ {title}</span>
        <div className="ai-panel-hd-actions">
          <button
            className="ai-icon-btn"
            onClick={() => setAnkiOpen(true)}
            title={msgs.length === 0 ? 'Nothing to convert yet' : 'Generate Anki cards from this conversation'}
            disabled={msgs.length === 0}
          >🃏</button>
          <button
            className="ai-icon-btn"
            onClick={saveAsDoc}
            title={msgs.length === 0 ? 'Nothing to save yet' : 'Save conversation as a Doc'}
            disabled={msgs.length === 0 || saving}
          >{saving ? '…' : '💾'}</button>
          <button
            className="ai-icon-btn"
            onClick={reset}
            title="Clear conversation"
            disabled={msgs.length === 0 && !draft}
          >🗑</button>
          <button
            className="ai-icon-btn"
            onClick={() => setMax(m => !m)}
            title={maximized ? 'Restore' : 'Maximize'}
          >{maximized ? '🗗' : '🗖'}</button>
          <button className="ai-icon-btn" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* Input on top, mirroring AskAIPanel. */}
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
          placeholder="Ask AI…  (Enter to send, Shift+Enter for newline) — not saved"
          rows={2}
          disabled={busy}
        />
        <div className="ai-input-btn-col">
          <button
            className={`ai-send-btn ai-mic-btn${listening ? ' listening' : ''}`}
            onClick={toggleMic}
            disabled={busy}
            title={listening ? 'Stop dictation' : 'Start voice dictation'}
            aria-pressed={listening}
          >{listening ? '⏺' : '🎤'}</button>
          <button
            className="ai-send-btn"
            onClick={send}
            disabled={busy || !draft.trim()}
            title="Send"
          >➤</button>
        </div>
      </div>
      {error && <div className="ai-panel-err">{error}</div>}

      <div className="ai-panel-body">
        {busy && (
          <div className="ai-msg ai-msg-assistant">
            <div className="ai-typing"><span /><span /><span /></div>
          </div>
        )}
        {reversed.length === 0 && !busy && (
          <div className="ai-panel-empty">
            Quick session — your messages here are not saved.
          </div>
        )}
        {reversed.map((m, i) => {
          const showApply = m.role === 'assistant' && !m.err && !!onApply
          const parsed    = showApply ? tryParseJson(m.content) : null
          return (
            <div key={`${i}-${m.role}`} className={`ai-msg ai-msg-${m.role}${m.err ? ' err' : ''}`}>
              {parsed ? (
                <pre className="ai-msg-json"><code>{JSON.stringify(parsed, null, 2)}</code></pre>
              ) : (
                <div
                  className="ai-msg-body"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(simpleMd(m.content)) }}
                />
              )}
              {showApply && (
                <button
                  className="ai-apply-btn"
                  onClick={() => {
                    if (parsed) {
                      onApply!(parsed)
                    } else {
                      setError("AI response wasn't valid JSON — couldn't apply. Ask again or refine the prompt so the AI returns structured data.")
                    }
                  }}
                  title={parsed
                    ? 'Apply this structured response to the form (replaces matched fields)'
                    : 'Response is not valid JSON — clicking will surface a hint'}
                >✓ Apply to form{parsed ? '' : ' (no JSON found)'}</button>
              )}
              {m.role === 'assistant' && !m.err && (
                <div className="msg-audio-track">
                  <MessageAudio text={m.content} cacheKey={`eph-${i}`} />
                </div>
              )}
            </div>
          )
        })}
      </div>

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
        msgs={msgs.map(m => ({ role: m.role, content: m.content }))}
        contextLabel={title}
      />
    </div>
  )
}

function tryParseJson(s: string): unknown | null {
  return parseLooseJson(s)
}

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
