// Azure OpenAI client. Mirrors the surface used in pg-hub-ads.

import { Config } from '../services/config'

export interface ChatMessage {
  role:    'user' | 'assistant' | 'system'
  content: string
}

export const LLM = {
  isConfigured(): boolean {
    return !!(Config.azureEndpoint && Config.azureApiKey)
  },

  _url(): string {
    const ep  = Config.azureEndpoint.replace(/\/$/, '')
    const dep = Config.azureDeployment
    const ver = Config.azureApiVersion
    return `${ep}/openai/deployments/${dep}/chat/completions?api-version=${ver}`
  },

  async chat(messages: ChatMessage[], maxTokens = 800): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Azure OpenAI is not configured — open Settings to add the endpoint and API key.')
    }
    const res = await fetch(this._url(), {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key':      Config.azureApiKey,
      },
      body: JSON.stringify({ messages, max_completion_tokens: maxTokens }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(err.error?.message || `HTTP ${res.status}`)
    }
    const data = await res.json() as { choices: { message: { content: string } }[] }
    return data.choices?.[0]?.message?.content?.trim() ?? ''
  },

  // Single-prompt helper for the floating Ask AI panel.
  async ask(prompt: string): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }])
  },

  // Speech synthesis via Azure (preferred when configured). Returns an object
  // URL the caller can hand to <audio>. Falls back to the browser's
  // SpeechSynthesis when the Azure TTS deployment is missing — see lib/tts.ts.
  async ttsAzure(text: string): Promise<string> {
    const dep = Config.azureTtsDeployment
    if (!dep) throw new Error('Azure TTS deployment not configured')
    const ep  = (Config.azureTtsEndpoint || Config.azureEndpoint).replace(/\/$/, '')
    const ver = Config.azureTtsApiVersion
    const key = Config.azureTtsApiKey || Config.azureApiKey
    if (!key) throw new Error('Azure TTS API key not configured')
    const res = await fetch(`${ep}/openai/deployments/${dep}/audio/speech?api-version=${ver}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body:    JSON.stringify({
        model:           dep,
        input:           text,
        voice:           Config.ttsVoice,
        response_format: 'mp3',
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(err.error?.message || `TTS HTTP ${res.status}`)
    }
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  },
}
