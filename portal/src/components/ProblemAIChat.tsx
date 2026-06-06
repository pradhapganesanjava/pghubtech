/**
 * Inline AI helper for AdsHub problem panel.
 *
 * Triggered from the 🤖 button in the code-strip / code-header. Pre-fills
 * with the problem text as system context, lets the user ASK a question
 * (typed or via mic), shows the answer below. Lightweight — no history,
 * no conversation tracking; one Q→A per session unless the user re-opens.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { LLM } from '../lib/llm'

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
      // System: problem + optional notes as context. User: their question
      // (or a default "explain this problem" when empty).
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

  return (
    <div className="prob-ai-panel" role="region" aria-label="Ask AI about this problem">
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
          <pre className="prob-ai-response-body">{answer}</pre>
        </div>
      )}
    </div>
  )
}
