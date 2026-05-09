// Text-to-speech with two backends: Azure OpenAI when configured, browser
// SpeechSynthesis as fallback. Singleton — only one utterance plays at a
// time; calling speak() interrupts whatever is in flight.

import { Config } from '../services/config'
import { LLM } from './llm'

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

export const TTS = {
  _audio:     null as HTMLAudioElement | null,
  _utterance: null as SpeechSynthesisUtterance | null,
  _playing:   false,
  _paused:    false,
  onPlayEnd:  null as (() => void) | null,

  get isPlaying() { return this._playing && !this._paused },
  get isPaused()  { return this._paused },

  _markEnd() {
    this._playing = false
    this._paused  = false
    this.onPlayEnd?.()
  },

  async speak(htmlOrText: string): Promise<void> {
    if (!Config.audioOn) return
    const text = stripHtml(htmlOrText).slice(0, 4000)
    if (!text) return
    this.stop()

    // Azure first when a TTS deployment is configured.
    if (Config.azureTtsDeployment && (Config.azureTtsApiKey || Config.azureApiKey)) {
      try {
        const url = await LLM.ttsAzure(text)
        const audio = new Audio(url)
        this._audio   = audio
        this._playing = true
        this._paused  = false
        audio.onended = () => this._markEnd()
        audio.onerror = () => this._markEnd()
        await audio.play()
        return
      } catch { /* fall through to browser synth */ }
    }

    // Browser fallback.
    if ('speechSynthesis' in window) {
      const utt = new SpeechSynthesisUtterance(text)
      const want = Config.ttsVoice
      if (want) {
        const voices = speechSynthesis.getVoices()
        const v = voices.find(v => v.name === want) || voices.find(v => v.lang.startsWith('en')) || null
        if (v) utt.voice = v
      }
      utt.onend   = () => this._markEnd()
      utt.onerror = () => this._markEnd()
      this._utterance = utt
      this._playing   = true
      this._paused    = false
      speechSynthesis.speak(utt)
    }
  },

  pause(): void {
    if (!this._playing || this._paused) return
    if (this._audio) this._audio.pause()
    if ('speechSynthesis' in window) speechSynthesis.pause()
    this._paused = true
  },

  resume(): void {
    if (!this._playing || !this._paused) return
    if (this._audio) this._audio.play()
    if ('speechSynthesis' in window) speechSynthesis.resume()
    this._paused = false
  },

  stop(): void {
    if (this._audio) { this._audio.pause(); this._audio = null }
    if ('speechSynthesis' in window) speechSynthesis.cancel()
    if (this._playing || this._paused) this._markEnd()
  },

  toggle(): boolean {
    const next = !Config.audioOn
    Config.audioOn = next
    if (!next) this.stop()
    return next
  },
}
