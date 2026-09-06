// Landing — the way back to the top. Reached by clicking "PG Hub Tech".
//
// Deliberately not a dashboard: no counts, no fetches, nothing that can be
// stale or slow. It is a signpost, and a signpost that waits on a network call
// is worse than no signpost.

import type { View } from '../lib/routing'

interface Dest {
  view:  View
  icon:  string
  title: string
  blurb: string
  sub?:  string[]
}

// Order mirrors the top nav: this page is a map of that bar.
const DESTS: Dest[] = [
  {
    view: 'ads-hub', icon: '🎯', title: 'AdsHub',
    blurb: 'Problems, patterns and the points worth remembering.',
    sub: ['Tags · Companies · MyList · Point2Rem'],
  },
  {
    view: 'sysdsg-hub', icon: '🏛', title: 'SysDsgHub',
    blurb: 'System design practice — a separate app, opened in place.',
  },
  {
    view: 'anki', icon: '🧠', title: 'Anki',
    blurb: 'The cards themselves — today’s queue, and the whole archive to search.',
    sub: ['Home — what is due now', 'Browse — every card, filtered'],
  },
  {
    view: 'docs', icon: '📄', title: 'Pages',
    blurb: 'Written material kept alongside the decks.',
  },
  {
    view: 'utils', icon: '🧰', title: 'Utils',
    blurb: 'The working tools: tasks, the day, notes, thoughts and the journal.',
    sub: ['ToDo · DART · Notes · Thoughts · Journal'],
  },
]

export default function LandingView({ onNav }: { onNav: (v: View) => void }) {
  return (
    <div className="landing">
      <div className="landing-hd">
        <h1 className="landing-title">PG Hub Tech</h1>
        <p className="landing-sub">Pick where you are working.</p>
      </div>
      <div className="landing-grid">
        {DESTS.map(d => (
          <button
            key={d.view}
            className="landing-card"
            onClick={() => onNav(d.view)}
            title={`Open ${d.title}`}
          >
            <span className="landing-card-icon">{d.icon}</span>
            <span className="landing-card-title">{d.title}</span>
            <span className="landing-card-blurb">{d.blurb}</span>
            {d.sub && (
              <span className="landing-card-sub">
                {d.sub.map((s, i) => <span key={i}>{s}</span>)}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
