import { useEffect, useState } from 'react'

// Per-problem study timer (mm:ss). Visual escalation: orange + bold at 10 min,
// red at 15 min, blinking at 20+.
//
// Deliberately owns its own ticking state instead of living in AdsHubView:
// a 1 Hz setState in the view re-rendered the whole detail pane every second,
// which wiped any text selection the user had made in the question body while
// copying. Keeping the tick inside this leaf means only this <span> re-renders.
// Mount it with key={slug} so switching problems restarts it from 0:00.
export default function StudyTimer({ running = true }: { running?: boolean }) {
  const [sec, setSec] = useState(0)

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setSec(s => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [running])

  const cls =
    sec >= 20 * 60 ? ' warn danger blink' :
    sec >= 15 * 60 ? ' warn danger' :
    sec >= 10 * 60 ? ' warn' : ''

  return (
    <span
      className={`doc-detail-timer${cls}`}
      title="Time on this problem (resets when you switch)"
    >{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, '0')}</span>
  )
}
