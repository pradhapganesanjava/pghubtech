import { useEffect, useRef, useState } from 'react'
import { LLM } from '../lib/llm'
import { claim, release } from '../lib/audioRegistry'
import { chunkForTts } from '../lib/audioMode'

interface Props {
  // Plain text (already stripped of HTML & code by htmlToSpokenText).
  text:     string
  // Whether to auto-start playing the first chunk on mount / text change.
  autoPlay: boolean
  // Cosmetic prefix shown in the player label, e.g. "Q" or "A".
  label?:   string
}

// Lightweight TTS player that breaks `text` into TTS-friendly chunks (~3000
// chars each) and walks through them. On finish of one chunk, the next one
// can be played by clicking ⏭ Continue. Mounting (or text change) optionally
// auto-plays chunk 0 — this is what gives Home's audio mode its hands-free
// feel: each new card or "Show Answer" click kicks off the read automatically.
export default function AudioReader({ text, autoPlay, label }: Props) {
  const [chunks, setChunks] = useState<string[]>([])
  const [idx, setIdx]       = useState(0)
  const [url, setUrl]       = useState<string | null>(null)
  const [busy, setBusy]     = useState(false)
  const [playing, setPlaying] = useState(false)
  const [err, setErr]       = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // (Re)chunk whenever the source text changes.
  useEffect(() => {
    const cs = chunkForTts(text || '')
    setChunks(cs)
    setIdx(0); setUrl(null); setErr('')
  }, [text])

  // Auto-start playback when text arrives in autoPlay mode.
  useEffect(() => {
    if (!autoPlay) return
    if (chunks.length === 0) return
    // small defer so the mount fully completes before we hit the network
    const t = setTimeout(() => { play(0) }, 50)
    return () => clearTimeout(t)
  }, [chunks, autoPlay]) // eslint-disable-line react-hooks/exhaustive-deps

  // Wire <audio> events.
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    function onPlay()  { setPlaying(true); claim(a!) }
    function onPause() { setPlaying(false); release(a!) }
    function onEnd()   { setPlaying(false); release(a!) }
    a.addEventListener('play',  onPlay)
    a.addEventListener('pause', onPause)
    a.addEventListener('ended', onEnd)
    return () => {
      a.removeEventListener('play',  onPlay)
      a.removeEventListener('pause', onPause)
      a.removeEventListener('ended', onEnd)
      release(a)
    }
  }, [url])

  async function play(targetIdx: number) {
    if (busy) return
    setErr('')
    if (targetIdx < 0 || targetIdx >= chunks.length) return

    // If the same chunk was already synthesized and we're just resuming, play.
    if (targetIdx === idx && url) {
      audioRef.current?.play().catch(e => setErr((e as Error).message))
      return
    }

    setIdx(targetIdx)
    setUrl(null)

    if (!LLM.isConfigured()) {
      // Fall back to browser SpeechSynthesis without going through Azure.
      if ('speechSynthesis' in window) {
        speechSynthesis.cancel()
        const utt = new SpeechSynthesisUtterance(chunks[targetIdx].slice(0, 4000))
        utt.onend = () => setPlaying(false)
        utt.onerror = () => setPlaying(false)
        speechSynthesis.speak(utt)
        setPlaying(true)
        return
      }
      setErr('Audio not available — configure Azure TTS in Settings, or use a browser with SpeechSynthesis.')
      return
    }

    setBusy(true)
    try {
      const u = await LLM.ttsAzure(chunks[targetIdx])
      setUrl(u)
      // wait for the next render so <audio src> is attached
      requestAnimationFrame(() => {
        audioRef.current?.play().catch(e => setErr((e as Error).message))
      })
    } catch (e) {
      // fallback to SpeechSynthesis on Azure failure
      if ('speechSynthesis' in window) {
        speechSynthesis.cancel()
        const utt = new SpeechSynthesisUtterance(chunks[targetIdx].slice(0, 4000))
        utt.onend = () => setPlaying(false)
        utt.onerror = () => setPlaying(false)
        speechSynthesis.speak(utt)
        setPlaying(true)
      } else {
        setErr((e as Error).message)
      }
    } finally { setBusy(false) }
  }

  function pause() {
    audioRef.current?.pause()
    if ('speechSynthesis' in window) speechSynthesis.cancel()
    setPlaying(false)
  }

  if (chunks.length === 0) return null
  const hasMore = idx + 1 < chunks.length

  return (
    <div className="audio-reader" role="group" aria-label={`${label ?? ''} audio reader`}>
      <button
        className="audio-reader-btn"
        onClick={playing ? pause : () => play(idx)}
        disabled={busy}
        title={playing ? 'Pause' : busy ? 'Loading…' : 'Play'}
      >{busy ? '⏳' : playing ? '⏸' : '▶'}</button>
      <span className="audio-reader-label">
        {label ? `${label} ` : ''}chunk {idx + 1} / {chunks.length}
      </span>
      {hasMore && (
        <button
          className="audio-reader-btn"
          onClick={() => play(idx + 1)}
          disabled={busy}
          title={`Continue — play chunk ${idx + 2} / ${chunks.length}`}
          aria-label="Continue with next chunk"
        >⏭</button>
      )}
      {err && <span className="audio-reader-err" title={err}>!</span>}
      {url && <audio ref={audioRef} src={url} preload="metadata" />}
    </div>
  )
}
