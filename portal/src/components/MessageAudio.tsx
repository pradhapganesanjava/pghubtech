import { useEffect, useRef, useState } from 'react'
import { LLM } from '../lib/llm'
import { claim, release } from '../lib/audioRegistry'

interface Props {
  text:        string
  // Optional cache key — when stable across renders, the synthesised blob URL
  // is reused so replays don't re-hit the TTS endpoint.
  cacheKey?:   string
}

const URL_CACHE = new Map<string, string>()

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export default function MessageAudio({ text, cacheKey }: Props) {
  const [url, setUrl]         = useState<string | null>(null)
  const [busy, setBusy]       = useState(false)
  const [err, setErr]         = useState('')
  const [playing, setPlaying] = useState(false)
  const [pos, setPos]         = useState(0)
  const [dur, setDur]         = useState(0)

  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Hydrate from cache on mount so re-rendered messages don't lose the URL.
  useEffect(() => {
    if (!cacheKey) return
    const cached = URL_CACHE.get(cacheKey)
    if (cached) setUrl(cached)
  }, [cacheKey])

  // Wire up audio events whenever a fresh url is set
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    function onTime()  { setPos(a!.currentTime); setDur(a!.duration || 0) }
    function onEnd()   { setPlaying(false); release(a!); setPos(0) }
    function onPause() { setPlaying(false); release(a!) }
    function onPlay()  { setPlaying(true); claim(a!) }
    a.addEventListener('timeupdate',     onTime)
    a.addEventListener('loadedmetadata', onTime)
    a.addEventListener('ended',          onEnd)
    a.addEventListener('pause',          onPause)
    a.addEventListener('play',           onPlay)
    return () => {
      a.removeEventListener('timeupdate',     onTime)
      a.removeEventListener('loadedmetadata', onTime)
      a.removeEventListener('ended',          onEnd)
      a.removeEventListener('pause',          onPause)
      a.removeEventListener('play',           onPlay)
      release(a)
    }
  }, [url])

  async function ensureAndPlay() {
    setErr('')
    let target = url
    if (!target) {
      // Need to synthesise first
      if (!LLM.isConfigured()) {
        setErr('Configure Azure OpenAI in Settings first')
        return
      }
      setBusy(true)
      try {
        target = await LLM.ttsAzure(text)
        if (cacheKey) URL_CACHE.set(cacheKey, target)
        setUrl(target)
      } catch (e) {
        // Fall back to browser SpeechSynthesis when Azure TTS is unavailable
        if ('speechSynthesis' in window) {
          const utt = new SpeechSynthesisUtterance(text.slice(0, 4000))
          utt.onend = () => setPlaying(false)
          utt.onerror = () => setPlaying(false)
          speechSynthesis.cancel()
          speechSynthesis.speak(utt)
          setPlaying(true)
          setBusy(false)
          return
        }
        setErr((e as Error).message)
        setBusy(false)
        return
      }
      setBusy(false)
      // Wait for the next render so audioRef points at the new <audio>
      requestAnimationFrame(() => {
        audioRef.current?.play().catch(e => setErr((e as Error).message))
      })
      return
    }
    audioRef.current?.play().catch(e => setErr((e as Error).message))
  }

  function pause() {
    audioRef.current?.pause()
    if ('speechSynthesis' in window) speechSynthesis.cancel()
    setPlaying(false)
  }

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current
    if (!a || !dur) return
    const next = (Number(e.target.value) / 1000) * dur
    a.currentTime = next
    setPos(next)
  }

  const progress = dur > 0 ? Math.round((pos / dur) * 1000) : 0
  // Slider grows with the audio length so longer clips give finer-grained
  // seeking. ~3 px / second, clamped to [50, 240] px.
  const sliderHeight = dur > 0
    ? Math.min(240, Math.max(50, Math.round(dur * 3)))
    : 50

  return (
    <div className="msg-audio" title={err || (playing ? 'Playing' : url ? 'Play' : 'Speak this reply')}>
      <button
        className="msg-audio-btn"
        onClick={playing ? pause : ensureAndPlay}
        disabled={busy}
        title={playing ? 'Pause' : url ? 'Play' : 'Speak this reply'}
      >
        {busy ? '⏳' : playing ? '⏸' : url ? '▶' : '🔊'}
      </button>
      <input
        type="range"
        className="msg-audio-slider"
        min={0}
        max={1000}
        value={progress}
        onChange={onSeek}
        disabled={!url || dur === 0}
        aria-label="Seek"
        style={{ height: `${sliderHeight}px` }}
      />
      <span className="msg-audio-time">
        {url ? fmt(pos) : '0:00'}
      </span>
      {err && <span className="msg-audio-err" title={err}>!</span>}
      {url && <audio ref={audioRef} src={url} preload="metadata" />}
    </div>
  )
}
