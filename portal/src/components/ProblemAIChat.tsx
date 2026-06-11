/**
 * AI helper for AdsHub problem panel.
 *
 * Renders as a FLOATING window (like the page-header "Ask AI" panel) so
 * it overlays the detail pane without hiding the Code / Notes sections.
 * Pre-fills the problem text as system context. Each Q→A is APPENDED to
 * a running thread — prior messages stay visible and are passed back to
 * the LLM as conversation history so the model can refer to earlier turns.
 *
 * The window can be resized (drag the bottom-left handle) and maximized,
 * mirroring AskAIPanel. Closing it leaves Code / Notes untouched.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { LLM, type ChatMessage } from '../lib/llm'
import { sanitizeHtml } from '../lib/sanitize'

declare global {
  interface Window {
    SpeechRecognition?:        typeof SpeechRecognition
    webkitSpeechRecognition?:  typeof SpeechRecognition
  }
}

interface Props {
  slug:         string    // used as the localStorage key for this thread
  problemTitle: string
  problemHtml:  string
  notesPlain?:  string
  onClose:      () => void
}

interface Turn { role: 'user' | 'assistant'; content: string }

// Per-problem thread persistence — keyed by slug so each problem has
// its own conversation. Survives closing/reopening the AI section AND
// reloading the page; only cleared when the user opens a brand-new
// problem (different slug → different key).
const THREAD_KEY = (slug: string) => `pghub.aiChat.${slug}`
function loadThread(slug: string): Turn[] {
  try {
    const raw = localStorage.getItem(THREAD_KEY(slug))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Defensive — only accept the expected shape.
    return parsed.filter(t => t && typeof t === 'object'
                          && (t.role === 'user' || t.role === 'assistant')
                          && typeof t.content === 'string')
  } catch { return [] }
}
function saveThread(slug: string, turns: Turn[]) {
  try { localStorage.setItem(THREAD_KEY(slug), JSON.stringify(turns)) } catch {}
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
}

function renderMd(text: string): string {
  try {
    const raw = marked.parse(text, { async: false }) as string
    return sanitizeHtml(raw)
  } catch { return sanitizeHtml(text) }
}

// Floating-window size bounds (mirror AskAIPanel).
const DEFAULT_W = 440
const DEFAULT_H = 580
const MIN_W     = 320
const MIN_H     = 320
const MAX_W     = 1100
const MAX_H     = 1000

export default function ProblemAIChat({ slug, problemTitle, problemHtml, notesPlain, onClose }: Props) {
  // Hydrate from localStorage on mount so reopening the AI section
  // (or reloading the page) keeps the existing thread.
  const [turns, setTurns]       = useState<Turn[]>(() => loadThread(slug))
  const [input, setInput]       = useState('')
  const [busy,  setBusy]        = useState(false)
  const [err,   setErr]         = useState('')
  const [listening, setListen]  = useState(false)
  // Floating-window geometry (mirrors AskAIPanel).
  const [maximized, setMaximized] = useState(false)
  const [size, setSize]           = useState({ w: DEFAULT_W, h: DEFAULT_H })
  const resizingRef = useRef(false)
  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const recRef    = useRef<SpeechRecognition | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const inputRef  = useRef<HTMLTextAreaElement | null>(null)
  // Mirror `listening` so the rec callbacks (which close over their
  // initial values) can check the LATEST state — used to auto-restart
  // recognition when the browser stops it on silence but the user
  // hasn't toggled off yet.
  const wantListenRef = useRef(false)

  const ctxText = useMemo(() => htmlToText(problemHtml), [problemHtml])

  // Newest turn renders at the TOP of the thread (input pinned above),
  // older turns push down. Auto-scroll the thread back to top whenever
  // a turn arrives so the user always sees the most recent exchange.
  useEffect(() => {
    if (!threadRef.current) return
    threadRef.current.scrollTop = 0
  }, [turns.length, busy])

  // Persist thread to localStorage on every change so closing the AI
  // section + reopening it (or reloading the page) restores history.
  useEffect(() => { saveThread(slug, turns) }, [slug, turns])

  // If the user opens a NEW problem (slug changed) while the component
  // is still mounted, swap the thread to the new problem's stored one.
  useEffect(() => { setTurns(loadThread(slug)) }, [slug])

  // Mic — Web SpeechRecognition. continuous=true keeps listening
  // through pauses (was stopping after one utterance). On any
  // browser-initiated stop (silence timeout, etc.) we auto-restart if
  // the user hasn't explicitly toggled off. Graceful degrade if SR
  // not supported.
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return
    const rec = new SR()
    rec.lang             = 'en-US'
    rec.interimResults   = false
    rec.continuous       = true
    rec.onresult = e => {
      // Only consume results we haven't applied yet (resultIndex
      // forward) — continuous mode emits a growing list.
      let text = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += e.results[i][0].transcript + ' '
      }
      text = text.trim()
      if (text) {
        setInput(prev => (prev ? prev + ' ' : '') + text)
        // Park the cursor in the input so the user can immediately
        // edit / append by typing.
        inputRef.current?.focus()
      }
    }
    rec.onend = () => {
      // Browsers (Chrome especially) stop recognition after long
      // silence even when continuous=true. If the user still WANTS to
      // be listening, restart.
      if (wantListenRef.current) {
        try { rec.start() } catch { /* already-started races: ignore */ }
      } else {
        setListen(false)
      }
    }
    rec.onerror = e => {
      // 'no-speech' fires on prolonged silence; not a hard error —
      // onend will fire next and we'll restart.
      if ((e as any).error && (e as any).error !== 'no-speech') {
        wantListenRef.current = false
        setListen(false)
      }
    }
    recRef.current = rec
    return () => {
      wantListenRef.current = false
      try { rec.stop() } catch {}
    }
  }, [])

  function startMic() {
    const r = recRef.current
    if (!r) { setErr('Mic not supported in this browser'); return }
    try {
      wantListenRef.current = true
      r.start()
      setListen(true)
      // Drop the cursor into the input box so dictated text + manual
      // typing both land in the same place.
      inputRef.current?.focus()
    } catch (e) {
      setErr((e as Error).message)
      wantListenRef.current = false
    }
  }
  function stopMic() {
    wantListenRef.current = false   // explicit user toggle — don't restart
    const r = recRef.current
    if (r) { try { r.stop() } catch {} }
    setListen(false)
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

  async function send() {
    if (busy) return
    const prompt = input.trim() || 'Explain the problem and give the optimal approach with brief reasoning.'
    setErr('')
    setInput('')
    // Optimistically append the user turn so it shows immediately.
    const nextTurns: Turn[] = [...turns, { role: 'user', content: prompt }]
    setTurns(nextTurns)
    setBusy(true)
    try {
      if (!LLM.isConfigured()) throw new Error('Azure OpenAI not configured — open Settings.')
      const sys = [
        `You are helping with this LeetCode-style problem.`,
        ``,
        `# Problem: ${problemTitle}`,
        ctxText,
        notesPlain ? `\n# My existing notes\n${notesPlain}` : '',
      ].filter(Boolean).join('\n')
      // Send system + full transcript so the model has context across
      // prior turns.
      const history: ChatMessage[] = [
        { role: 'system', content: sys },
        ...nextTurns.map(t => ({ role: t.role, content: t.content }) as ChatMessage),
      ]
      const out = await LLM.chat(history, 2000)
      setTurns(ts => [...ts, { role: 'assistant', content: out }])
    } catch (e) {
      setErr((e as Error).message)
      // Roll back the user turn so it doesn't sit there unanswered.
      setTurns(ts => ts.slice(0, -1))
      setInput(prompt)
    } finally { setBusy(false) }
  }

  // Render order: input row at TOP, then turns in REVERSE chronological
  // order beneath it (latest exchange just under the input; older ones
  // push down). Pairs (user Q + AI A) stay adjacent — for one exchange
  // the order is [AI, User] so the answer sits closest to the input.
  const turnsReversed = useMemo(() => turns.slice().reverse(), [turns])

  const wrapStyle: React.CSSProperties = maximized ? {} : { width: size.w, height: size.h }

  return (
   <div
     className={`ai-panel prob-ai-panel${maximized ? ' maximized' : ''}`}
     style={wrapStyle}
     role="dialog"
     aria-label="Ask AI about this problem"
   >
    {/* Floating-window header — mirrors AskAIPanel's title + window controls. */}
    <div className="ai-panel-hd">
      <span className="ai-panel-title">🤖 AI <span style={{ color: 'var(--text3)', fontWeight: 400, fontSize: 11 }}>· {problemTitle}</span></span>
      <div className="ai-panel-hd-actions">
        <button className="ai-icon-btn" onClick={() => setMaximized(m => !m)} title={maximized ? 'Restore' : 'Maximize'}>{maximized ? '🗗' : '🗖'}</button>
        <button className="ai-icon-btn" onClick={onClose} title="Close">✕</button>
      </div>
    </div>

    <div className="prob-ai-inline" role="region" aria-label="Ask AI about this problem">
      {/* Input row pinned at the TOP. Action icons (🎤 ➤ 🗑) float
          INSIDE the textarea on the right — the textarea gets right
          padding to keep typed text from sliding under them. */}
      {err && <div className="prob-ai-err">{err}</div>}
      <div className="prob-ai-input-wrap">
        <textarea
          ref={inputRef}
          className="prob-ai-input prob-ai-input--padded"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={listening
            ? 'Listening… speak now'
            : turns.length
              ? 'Continue the conversation…'
              : `Ask anything about "${problemTitle}" — ⌘↵ to send`}
          rows={2}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
          }}
        />
        <div className="prob-ai-input-icons">
          <button
            className={`prob-ai-mic${listening ? ' active' : ''}`}
            onClick={listening ? stopMic : startMic}
            title={listening ? 'Stop dictation' : 'Voice input'}
          >🎤</button>
          <button className="prob-ai-send" onClick={send} disabled={busy} title="Send (⌘↵)">
            {busy ? '…' : '➤'}
          </button>
        </div>
      </div>

      {/* Stacked thread BELOW the input. Newest exchange on top. */}
      <div className="prob-ai-thread" ref={threadRef}>
        {busy && (
          <div className="prob-ai-turn prob-ai-turn--assistant prob-ai-turn--busy">
            <div className="prob-ai-turn-hd">AI</div>
            <div className="prob-ai-busy">Thinking…</div>
          </div>
        )}
        {turnsReversed.map((t, i) => (
          // Index is from the reversed array — fine for keys since we
          // never reorder turns once they're in the thread.
          <div key={turns.length - 1 - i} className={`prob-ai-turn prob-ai-turn--${t.role}`}>
            <div className="prob-ai-turn-hd">{t.role === 'user' ? 'You' : 'AI'}</div>
            {t.role === 'assistant' ? (
              <div className="prob-ai-md" dangerouslySetInnerHTML={{ __html: renderMd(t.content) }} />
            ) : (
              <div className="prob-ai-user-body">{t.content}</div>
            )}
          </div>
        ))}
        {turns.length === 0 && !busy && (
          <div className="prob-ai-empty">
            Ask anything about <strong>{problemTitle}</strong>. Each Q→A appears above the older ones; prior turns are sent back to the model as context.
          </div>
        )}
      </div>
    </div>

    {/* Resize handle (bottom-left) — hidden while maximized. */}
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
   </div>
  )
}
