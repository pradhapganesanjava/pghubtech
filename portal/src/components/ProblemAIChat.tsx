/**
 * AI helper for AdsHub problem panel.
 *
 * Renders INLINE in the description column, beneath the end-of-problem
 * footer — flows as a normal section, no fixed positioning, no overlay.
 * Pre-fills with the problem text as system context; mic-enabled input;
 * response rendered as rich markdown (code blocks, lists, headings, etc.).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { LLM } from '../lib/llm'
import { sanitizeHtml } from '../lib/sanitize'

// Browser SpeechRecognition (mic input) typing. Webkit prefix on Safari.
declare global {
  interface Window {
    SpeechRecognition?:        typeof SpeechRecognition
    webkitSpeechRecognition?:  typeof SpeechRecognition
  }
}

interface Props {
  problemTitle: string
  problemHtml:  string      // raw HTML; we strip tags before sending
  notesPlain?:  string      // optional — user's note content as plain text
  onClose:      () => void
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
}

export default function ProblemAIChat({ problemTitle, problemHtml, notesPlain, onClose }: Props) {
  const [input, setInput]       = useState('')
  const [answer, setAnswer]     = useState('')
  const [busy, setBusy]         = useState(false)
  const [err, setErr]           = useState('')
  const [listening, setListen]  = useState(false)
  const recRef = useRef<SpeechRecognition | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Scroll the panel into view on mount. The AI section renders below
  // the end-of-problem footer inside an overflow:auto column — without
  // this, clicking 🤖 from a long problem appears to 'do nothing'
  // because the new section is below the fold.
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const ctxText = useMemo(() => htmlToText(problemHtml), [problemHtml])

  // Set up mic — Web SpeechRecognition. Graceful degrade if not supported.
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return
    const rec  = new SR()
    rec.lang             = 'en-US'
    rec.interimResults   = false
    rec.continuous       = false
    rec.onresult = e => {
      const text = Array.from(e.results)
        .map(r => r[0].transcript).join(' ').trim()
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
    setErr(''); setAnswer(''); setBusy(true)
    try {
      if (!LLM.isConfigured()) throw new Error('Azure OpenAI not configured — open Settings.')
      const sys = [
        `You are helping with this LeetCode-style problem.`,
        ``,
        `# Problem: ${problemTitle}`,
        ctxText,
        notesPlain ? `\n# My existing notes\n${notesPlain}` : '',
      ].filter(Boolean).join('\n')
      const userQ = input.trim() || 'Explain the problem and give the optimal approach with brief reasoning.'
      const out = await LLM.chat([
        { role: 'system', content: sys },
        { role: 'user',   content: userQ },
      ], 2000)
      setAnswer(out)
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  // Rich-render the answer with marked → sanitize. Memoized so we don't
  // re-parse on every keystroke in the input.
  const answerHtml = useMemo(() => {
    if (!answer) return ''
    try {
      const raw = marked.parse(answer, { async: false }) as string
      return sanitizeHtml(raw)
    } catch { return sanitizeHtml(answer) }
  }, [answer])

  return (
    <div
      className="prob-ai-inline"
      role="region"
      aria-label="Ask AI about this problem"
      ref={rootRef}
    >
      <div className="prob-ai-chat-hd">
        <span>🤖 Ask AI about: <strong>{problemTitle}</strong></span>
        <button className="prob-ai-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="prob-ai-input-row">
        <textarea
          className="prob-ai-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={listening
            ? 'Listening… speak now'
            : `Ask anything about "${problemTitle}" — leave blank for an explanation.`}
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
        </div>
      </div>

      {err && <div className="prob-ai-err">{err}</div>}

      {answer && (
        <div className="prob-ai-response">
          <div className="prob-ai-response-hd">Response</div>
          {/* Markdown-rendered: code fences become <pre><code>, lists,
              headings, inline code, etc. Sanitised before injection. */}
          <div
            className="prob-ai-response-body prob-ai-md"
            dangerouslySetInnerHTML={{ __html: answerHtml }}
          />
        </div>
      )}
    </div>
  )
}
