// AI credentials live in the Sheet's Settings tab and are mirrored into
// localStorage so Config's getters stay synchronous.
//
// The mirror is only populated once something reads the sheet. That used to be
// SettingsView alone, so on a fresh browser every AI feature — ToDo Generate,
// lesson extraction, Ask AI, TTS — reported "Configure Azure OpenAI in
// Settings" until you happened to open Settings once. Twelve call sites, one
// cause: nobody hydrated at boot.

import { Config } from './config'
import { loadSettings } from '../adapters/sheetsRepo'

export const AI_KEYS = {
  endpoint:    'ai_endpoint',
  apiKey:      'ai_api_key',
  deployment:  'ai_deployment',
  apiVersion:  'ai_api_version',
  ttsEndpoint: 'ai_tts_endpoint',
  ttsApiKey:   'ai_tts_api_key',
  ttsDeploy:   'ai_tts_deployment',
  ttsVersion:  'ai_tts_api_version',
  ttsVoice:    'ai_tts_voice',
  audioOn:     'ai_audio_on',
} as const

const FIELDS: [string, keyof typeof Config][] = [
  [AI_KEYS.endpoint,    'azureEndpoint'],
  [AI_KEYS.apiKey,      'azureApiKey'],
  [AI_KEYS.deployment,  'azureDeployment'],
  [AI_KEYS.apiVersion,  'azureApiVersion'],
  [AI_KEYS.ttsEndpoint, 'azureTtsEndpoint'],
  [AI_KEYS.ttsApiKey,   'azureTtsApiKey'],
  [AI_KEYS.ttsDeploy,   'azureTtsDeployment'],
  [AI_KEYS.ttsVersion,  'azureTtsApiVersion'],
  [AI_KEYS.ttsVoice,    'ttsVoice'],
]

/** Mirror sheet settings into Config. Blank values are skipped, never written
 *  over a working local value. */
export function applyAiSettings(s: Record<string, string>): void {
  for (const [key, target] of FIELDS) {
    if (s[key] !== undefined && s[key] !== '') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(Config as any)[target] = s[key]
    }
  }
  if (s[AI_KEYS.audioOn] !== undefined) Config.audioOn = s[AI_KEYS.audioOn] !== 'false'
}

// One in-flight fetch shared by every caller: a page where several panels wake
// at once should read the Settings tab once, not five times.
let inflight: Promise<void> | null = null

export function hydrateAiConfig(): Promise<void> {
  if (!inflight) {
    inflight = loadSettings()
      .then(applyAiSettings)
      .catch(e => {
        // eslint-disable-next-line no-console
        console.warn('[aiConfig] hydration failed; local cache stands:', e)
      })
      .finally(() => { inflight = null })
  }
  return inflight
}
