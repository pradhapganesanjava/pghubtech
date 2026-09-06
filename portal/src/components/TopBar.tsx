import { useEffect, useRef, useState } from 'react'
import { GAuth } from '../lib/gauth'

interface Props {
  view:    string
  onNav:   (v: string) => void
  theme:   string
  onTheme: (t: string) => void
  onSignOut: () => void
  aiOpen:    boolean
  onToggleAI: () => void
}

const THEMES = [
  { id: 'dark',     label: 'Dark',     bg: '#0f0f13' },
  { id: 'light',    label: 'Light',    bg: '#f5f5ff' },
  { id: 'soft',     label: 'Soft',     bg: '#1e1b34' },
  { id: 'contrast', label: 'Contrast', bg: '#000000' },
  { id: 'glow',     label: 'Glow',     bg: '#050510' },
  { id: 'cartoon',  label: 'Cartoon',  bg: '#fff9e6' },
]

// Settings is reachable via the avatar menu, so it's no longer in the top nav.
const NAVS = [
  { id: 'ads-hub', label: 'AdsHub' },
  { id: 'sysdsg-hub', label: 'SysDsgHub' },
  // Home and Browse are sub-tabs of Anki now — one subject, one tab.
  { id: 'anki',   label: 'Anki'   },
  { id: 'docs',   label: 'Pages'  },
  // Notes now lives as a tab inside Utils.
  { id: 'utils',  label: 'Utils'  },
  // { id: 'ads', label: 'Ads' },  // temporarily hidden (pghubads.web.app) — may remove later
]

export default function TopBar({ view, onNav, theme, onTheme, onSignOut, aiOpen, onToggleAI }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const user = GAuth.getUser()

  // Click-outside to close (in addition to mouseLeave)
  useEffect(() => {
    if (!menuOpen) return
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  function clearCloseTimer() {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  function scheduleClose() {
    clearCloseTimer()
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), 180)
  }
  function openNow() {
    clearCloseTimer()
    setMenuOpen(true)
  }

  return (
    <div className="topbar">
      <div className="topbar-left">
        <span
          className="logo"
          onClick={() => onNav('landing')}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNav('landing') } }}
          style={{ cursor: 'pointer' }}
          title="Go to the landing page"
        >PG Hub Tech</span>
        <nav className="topbar-nav">
          {NAVS.map(n => (
            <button
              key={n.id}
              className={`nav-btn${view === n.id ? ' active' : ''}`}
              onClick={() => onNav(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="topbar-right">
        {/* Ask AI launcher — banner-height pill */}
        <button
          className={`tb-pill ai-launch-btn${aiOpen ? ' active' : ''}`}
          onClick={onToggleAI}
          title={aiOpen ? 'Close Ask AI' : 'Open Ask AI'}
        >
          <span className="tb-pill-icon">✨</span>
          <span className="tb-pill-lbl">AI</span>
        </button>

        {/* Avatar trigger + dropdown (hover OR click) */}
        <div
          className={`avatar-menu-wrap${menuOpen ? ' open' : ''}`}
          ref={wrapRef}
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
        >
          <button
            className="tb-pill avatar-trigger"
            onClick={() => setMenuOpen(o => !o)}
            title={user?.email ?? 'Account'}
          >
            {user?.picture
              ? <img className="avatar-img" src={user.picture} alt={user.name} referrerPolicy="no-referrer" />
              : <span className="avatar-chip">{user?.name?.[0]?.toUpperCase() ?? '·'}</span>}
            <span className="tb-pill-lbl avatar-trigger-lbl">{user?.name?.split(' ')[0] ?? 'Me'}</span>
            <span className="avatar-trigger-caret">▾</span>
          </button>

          {menuOpen && (
            <div className="avatar-menu" onMouseEnter={openNow} onMouseLeave={scheduleClose}>
              {(user?.name || user?.email) && (
                <div className="avatar-menu-user">
                  {user?.name && <div className="avatar-menu-name">{user.name}</div>}
                  {user?.email && <div className="avatar-menu-email">{user.email}</div>}
                </div>
              )}

              <div className="avatar-menu-section-hd">Theme</div>
              <div className="avatar-menu-themes">
                {THEMES.map(t => (
                  <button
                    key={t.id}
                    className={`avatar-theme-swatch${theme === t.id ? ' active' : ''}`}
                    onClick={() => { onTheme(t.id); /* keep menu open so user can preview */ }}
                    title={t.label}
                    style={{ background: t.bg }}
                  >
                    {theme === t.id && <span className="avatar-theme-check">✓</span>}
                  </button>
                ))}
              </div>

              <div className="avatar-menu-divider" />

              <button
                className={`avatar-menu-item${view === 'ai-skills' ? ' active' : ''}`}
                onClick={() => { onNav('ai-skills'); setMenuOpen(false) }}
              >
                <span className="avatar-menu-icon">✨</span>
                <span>AI Skills</span>
              </button>
              <button
                className={`avatar-menu-item${view === 'settings' ? ' active' : ''}`}
                onClick={() => { onNav('settings'); setMenuOpen(false) }}
              >
                <span className="avatar-menu-icon">⚙</span>
                <span>Settings</span>
              </button>
              <button
                className="avatar-menu-item avatar-menu-item-danger"
                onClick={() => { setMenuOpen(false); onSignOut() }}
              >
                <span className="avatar-menu-icon">⏏</span>
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
