// Speech for an app framed in the portal (SysDsgHub, TechHub).
//
// Their voice practice speaks with OUR Azure TTS, so it gets the same
// deployment and voice as everything here, and the credentials this portal
// hydrates from the Sheet. The child sends text, we send back the audio bytes;
// the key never has to travel. Replies go only to the frame that asked, at its
// pinned origin, and a message from any other window is ignored.

import { LLM } from './llm'

async function speakFor(src: Window, origin: string, id: string, text: string) {
  try {
    if (!(await LLM.ensureConfigured())) throw new Error('Azure OpenAI is not configured in PGHubTech Settings.')
    const audio = await (await LLM.ttsAzureBlob(text)).arrayBuffer()
    src.postMessage({ type: 'pghubtech:tts-result', id, audio }, origin, [audio])
  } catch (err) {
    src.postMessage({ type: 'pghubtech:tts-result', id, error: (err as Error).message || String(err) }, origin)
  }
}

/** Answer the frame's speech messages. Returns true when the message was one. */
export function handleFrameTts(e: MessageEvent, frame: HTMLIFrameElement | null, origin: string): boolean {
  if (e.origin !== origin) return false
  const src = frame?.contentWindow
  if (!src || e.source !== src) return false
  const d = e.data as { type?: string; id?: string; text?: string } | null
  if (d?.type === 'pghubtech:tts-hello') {
    src.postMessage({ type: 'pghubtech:tts-hello' }, origin)
    return true
  }
  if (d?.type === 'pghubtech:tts' && d.id && d.text) {
    speakFor(src, origin, d.id, d.text.slice(0, 4000))
    return true
  }
  return false
}
