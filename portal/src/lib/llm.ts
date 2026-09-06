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

  // Async guard for call sites that can await: if the credentials are not in
  // Config yet, read them from the Settings tab and look again. Covers a boot
  // fetch that failed or had not finished, so a feature is never permanently
  // "not configured" just because of when it was opened.
  async ensureConfigured(): Promise<boolean> {
    if (this.isConfigured()) return true
    const { hydrateAiConfig } = await import('../services/aiConfig')
    await hydrateAiConfig()
    return this.isConfigured()
  },

  _url(): string {
    const ep  = Config.azureEndpoint.replace(/\/$/, '')
    const dep = Config.azureDeployment
    const ver = Config.azureApiVersion
    return `${ep}/openai/deployments/${dep}/chat/completions?api-version=${ver}`
  },

  // Default bumped from 800 → 4000 so code-heavy answers (e.g. binary-search
  // explanations with a few cpp/python snippets) don't get truncated mid-block.
  // Azure typically caps deployments at 4096–16384; we leave headroom.
  async chat(messages: ChatMessage[], maxTokens = 4000): Promise<string> {
    const { content } = await this.chatWithMeta(messages, maxTokens)
    return content
  },

  // Same as chat() but exposes finish_reason so callers can detect when the
  // response was cut by the token cap (finishReason === 'length') vs ended
  // naturally ('stop'). The Ask AI panel uses this to surface a truncation
  // banner and offer Retry.
  async chatWithMeta(messages: ChatMessage[], maxTokens = 4000): Promise<{ content: string; finishReason: string }> {
    // Last line of defence: a direct chat() call on a cold Config hydrates
    // rather than throwing at the user.
    if (!this.isConfigured() && !(await this.ensureConfigured())) {
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
    const data = await res.json() as { choices: { message: { content: string }; finish_reason: string }[] }
    return {
      content:      data.choices?.[0]?.message?.content?.trim() ?? '',
      finishReason: data.choices?.[0]?.finish_reason ?? 'stop',
    }
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
