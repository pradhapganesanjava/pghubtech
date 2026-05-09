// Tiny singleton that ensures only one HTMLAudioElement is playing across the
// whole app. Each MessageAudio component registers its element when starting
// playback; if another element was active, it's paused and reset.

let active: HTMLAudioElement | null = null

export function claim(audio: HTMLAudioElement): void {
  if (active && active !== audio) {
    try { active.pause() } catch { /* ignore */ }
    active.currentTime = 0
  }
  active = audio
}

export function release(audio: HTMLAudioElement): void {
  if (active === audio) active = null
}

export function stopAll(): void {
  if (active) {
    try { active.pause() } catch { /* ignore */ }
    active.currentTime = 0
    active = null
  }
}
