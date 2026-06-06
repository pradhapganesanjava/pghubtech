/**
 * AI helper for AdsHub problem panel.
 *
 * Fills the CodePanel overlay slot (right column, same place Notes
 * takes over). Pre-fills the problem text as system context. Each Q→A
 * is APPENDED to a running thread — prior messages stay visible and
 * are passed back to the LLM as conversation history so the model can
 * refer to earlier turns.
 *
 * The section header ('🤖 AI · <title>') is rendered ABOVE us by the
 * parent CodePanel via its `headerLeft` prop.
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
  problemTitle: string
  problemHtml:  string
  notesPlain?:  string
  onClose:      () => void
}

interface Turn { role: 'user' | 'assistant'; content: string }

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

export default function ProblemAIChat({ problemTitle, problemHtml, notesPlain, onClose }: Props) {
  const [turns, setTurns]       = useState<Turn[]>([])
  const [input, setInput]       = useState('')
  const [busy,  setBusy]        = useState(false)
  const [err,   setErr]         = useState('')
  const [listening, setListen]  = useState(false)
  const recRef    = useRef<SpeechRecognition | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)

  const ctxText = useMemo(() => htmlToText(problemHtml), [problemHtml])

  // Newest turn renders at the TOP of the thread (input pinned above),
  // older turns push down. Auto-scroll the thread back to top whenever
  // a turn arrives so the user always sees the most recent exchange.
  useEffect(() => {
    if (!threadRef.current) return
    threadRef.current.scrollTop = 0
  }, [turns.length, busy])

  // Mic — Web SpeechRecognition. Graceful degrade if unsupported.
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return
    const rec = new SR()
    rec.lang             = 'en-US'
    rec.interimResults   = false
    rec.continuous       = false
    rec.onresult = e => {
      const text = Array.from(e.results).map(r => r[0].transcript).join(' ').trim()
      if (text) setInput(prev => (prev ? prev + ' ' : '') + text)
    }
    rec.onend   = () => setListen(false)
    rec.onerror = () => setListen(false)
    recRef.current = rec
    return () => { try { rec.stop() } catch {} }
  }, [])

  function startMic() {
    const r = recRef.current
    if (!r) { setErr('Mic not supported in this browser'); return }
    try { r.start(); setListen(true) } catch (e) { setErr((e as Error).message) }
  }
  function stopMic() {
    const r = recRef.current
    if (r) { try { r.stop() } catch {} }
    setListen(false)
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

  function clearThread() {
    if (!turns.length) return
    if (confirm('Clear the conversation thread?')) setTurns([])
  }

  // Render order: input row at TOP, then turns in REVERSE chronological
  // order beneath it (latest exchange just under the input; older ones
  // push down). Pairs (user Q + AI A) stay adjacent — for one exchange
  // the order is [AI, User] so the answer sits closest to the input.
  const turnsReversed = useMemo(() => turns.slice().reverse(), [turns])

  return (
    <div className="prob-ai-inline" role="region" aria-label="Ask AI about this problem">
      {/* Section header lives in CodePanel.headerLeft. */}

      {/* Input row pinned at the TOP. */}
      {err && <div className="prob-ai-err">{err}</div>}
      <div className="prob-ai-input-row">
        <textarea
          className="prob-ai-input"
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
        <div className="prob-ai-actions">
          <button
            className={`prob-ai-mic${listening ? ' active' : ''}`}
            onClick={listening ? stopMic : startMic}
            title={listening ? 'Stop dictation' : 'Voice input'}
          >🎤</button>
          <button className="prob-ai-send" onClick={send} disabled={busy} title="Send (⌘↵)">
            {busy ? '…' : '➤'}
          </button>
          {turns.length > 0 && (
            <button className="prob-ai-clear" onClick={clearThread} title="Clear conversation thread">🗑</button>
          )}
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
  )
}
