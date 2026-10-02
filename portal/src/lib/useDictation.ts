// Voice → text via the Web Speech API (Chrome on macOS, Safari on iOS).
//
// Appends what is heard to the caller's text rather than replacing it, so
// dictation can be stopped, typed around, and resumed into the same draft.

import { useEffect, useRef, useState } from 'react'

export function useDictation(text: string, setText: (s: string) => void, onError: (msg: string) => void) {
  const [listening, setListening] = useState(false)
  const recogRef = useRef<SpeechRecognition | null>(null)
  const baseRef  = useRef('')

  function stop() {
    try { recogRef.current?.stop() } catch { /* ignore */ }
    recogRef.current = null
    setListening(false)
  }

  function toggle() {
    if (listening) { stop(); return }
    const w = window as unknown as {
      SpeechRecognition?: typeof SpeechRecognition
      webkitSpeechRecognition?: typeof SpeechRecognition
    }
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!SR) {
      onError('Voice dictation is not supported in this browser. Try Chrome on macOS or Safari on iOS.')
      return
    }
    const r = new SR()
    r.continuous     = true
    r.interimResults = true
    r.lang           = navigator.language || 'en-US'
    baseRef.current  = text.length === 0 || /\s$/.test(text) ? text : text + ' '
    r.onresult = e => {
      let heard = ''
      for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript
      setText(baseRef.current + heard)
    }
    r.onerror = e => { onError(`Mic error: ${e.error || 'unknown'}`); stop() }
    r.onend   = () => { setListening(false); recogRef.current = null }
    try {
      r.start()
      recogRef.current = r
      setListening(true)
    } catch (e) {
      onError(`Could not start mic: ${(e as Error).message}`)
    }
  }

  // Leaving the view must release the microphone.
  useEffect(() => () => { try { recogRef.current?.abort() } catch { /* ignore */ } }, [])

  return { listening, toggle, stop }
}
