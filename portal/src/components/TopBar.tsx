import { useState, useRef, useEffect } from 'react'
import { GAuth } from '../lib/gauth'

interface Props {
  view:    string
  onNav:   (v: string) => void
  theme:   string
  onTheme: (t: string) => void
  onSignOut: () => void
}

const THEMES = [
  { id: 'dark',     label: 'Dark',     bg: '#0f0f13' },
  { id: 'light',    label: 'Light',    bg: '#f5f5ff' },
  { id: 'soft',     label: 'Soft',     bg: '#1e1b34' },
  { id: 'contrast', label: 'Contrast', bg: '#000000' },
  { id: 'glow',     label: 'Glow',     bg: '#050510' },
  { id: 'cartoon',  label: 'Cartoon',  bg: '#fff9e6' },
]

const NAVS = [
  { id: 'home',     label: 'Home'     },
  { id: 'browse',   label: 'Browse'   },
  { id: 'settings', label: 'Settings' },
]

export default function TopBar({ view, onNav, theme, onTheme, onSignOut }: Props) {
  const [dropOpen, setDropOpen] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)
  const user = GAuth.getUser()

  useEffect(() => {
    if (!dropOpen) return
    function onOutside(e: MouseEvent) {
      if (dropRef.current?.contains(e.target as Node)) return
      setDropOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [dropOpen])

  const currentTheme = THEMES.find(t => t.id === theme) ?? THEMES[0]

  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="logo">PG Hub Tech</span>
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
        {/* Theme picker */}
        <div className="theme-picker-wrap" ref={dropRef}>
          <button
            className="theme-current-dot"
            style={{ background: currentTheme.bg }}
            onClick={() => setDropOpen(d => !d)}
            title={`Theme: ${currentTheme.label}`}
          />
          {dropOpen && (
            <div className="theme-dropdown">
              {THEMES.map(t => (
                <button
                  key={t.id}
                  className={`theme-drop-item${theme === t.id ? ' active' : ''}`}
                  onClick={() => { onTheme(t.id); setDropOpen(false) }}
                >
                  <span className="theme-drop-dot" style={{ background: t.bg }} />
                  <span className="theme-drop-label">{t.label}</span>
                  {theme === t.id && <span className="theme-drop-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* User avatar */}
        {user?.picture
          ? <img className="avatar-img" src={user.picture} alt={user.name} title={user.name} referrerPolicy="no-referrer" />
          : user?.name
            ? <div className="avatar-chip" title={user.email}>{user.name[0].toUpperCase()}</div>
            : null
        }

        <button className="signout-btn" onClick={onSignOut} title="Sign out">⏏</button>
      </div>
    </div>
  )
}
