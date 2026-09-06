// Anki — the card-facing half of the app: the daily queue (Home) and the whole
// archive (Browse). They were two top-level tabs; they are one subject, so they
// sit behind one tab with their own sub-bar, the way Utils holds its tools.

import { useEffect, useState } from 'react'
import HomeView from './HomeView'
import BrowseView from './BrowseView'

export type AnkiSubTab = 'home' | 'browse'

export default function AnkiView({ initialTab }: { initialTab?: AnkiSubTab } = {}) {
  const [tab, setTab] = useState<AnkiSubTab>(initialTab ?? 'home')

  // /home and /browse still resolve to this view — honour which one was asked
  // for rather than always opening the queue.
  useEffect(() => { if (initialTab) setTab(initialTab) }, [initialTab])

  return (
    <div className="utils-wrap">
      <div className="utils-tabbar">
        <button
          className={`utils-tab${tab === 'home' ? ' active' : ''}`}
          onClick={() => setTab('home')}
        >🏠 Home</button>
        <button
          className={`utils-tab${tab === 'browse' ? ' active' : ''}`}
          onClick={() => setTab('browse')}
        >📋 Browse</button>
      </div>
      {tab === 'home'   && <HomeView />}
      {tab === 'browse' && <BrowseView />}
    </div>
  )
}
