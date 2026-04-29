import { useEffect, useState } from 'react'
import { GAuth } from './lib/gauth'
import { Config } from './services/config'
import { checkAccess, ensureHeaders } from './adapters/sheetsRepo'
import { ToastProvider } from './components/Toast'
import TopBar from './components/TopBar'
import SheetSetupModal from './components/SheetSetupModal'
import HomeView from './views/HomeView'
import BrowseView from './views/BrowseView'
import SettingsView from './views/SettingsView'
import './App.css'

type AuthState = 'loading' | 'unauthenticated' | 'needs-sheet' | 'authenticated'
type View = 'home' | 'browse' | 'settings'

const GOOGLE_SVG = (
  <svg width="18" height="18" viewBox="0 0 24 24">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
)

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [view, setView]           = useState<View>('home')
  const [theme, setTheme]         = useState<string>(Config.theme)
  const [loginError, setLoginError] = useState('')

  // On mount: try to restore a session
  useEffect(() => {
    const hasSession = GAuth.restoreSession()
    if (hasSession) {
      if (!Config.isSheetConfigured()) {
        setAuthState('needs-sheet')
      } else {
        checkAccess()
          .then(() => setAuthState('authenticated'))
          .catch(() => setAuthState('needs-sheet'))
      }
    } else {
      setAuthState('unauthenticated')
    }
  }, [])

  // Apply theme
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', theme)
    }
  }, [theme])

  function handleTheme(t: string) {
    setTheme(t)
    Config.theme = t
  }

  async function handleSignIn() {
    setLoginError('')
    try {
      await GAuth.signIn(Config.googleClientId)
      const user = GAuth.getUser()

      // Email whitelist check
      const allowed = Config.allowedEmails
      if (allowed.length > 0 && !allowed.includes(user?.email ?? '')) {
        GAuth.signOut()
        setLoginError(`${user?.email ?? 'Your account'} is not authorised to use this app.`)
        return
      }

      if (!Config.isSheetConfigured()) {
        setAuthState('needs-sheet')
      } else {
        await ensureHeaders()
        setAuthState('authenticated')
      }
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : String(e))
    }
  }

  function handleSignOut() {
    GAuth.signOut()
    setAuthState('unauthenticated')
    setView('home')
  }

  async function handleSheetConfigured(sheetId: string) {
    Config.sheetId = sheetId
    await ensureHeaders()
    setAuthState('authenticated')
  }

  // ── Render states ──────────────────────────────────────────────────

  if (authState === 'loading') {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading…</span>
      </div>
    )
  }

  if (authState === 'unauthenticated') {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="app-name">PG Hub Tech</div>
          <p className="tagline">Your personal tech knowledge hub, powered by Google Sheets</p>
          <button className="google-btn" onClick={handleSignIn}>
            {GOOGLE_SVG}
            Sign in with Google
          </button>
          {loginError && <div className="login-error">{loginError}</div>}
          <div className="setup-notice">
            Data is stored in a Google Sheet you own — no external database.
          </div>
        </div>
      </div>
    )
  }

  if (authState === 'needs-sheet') {
    return (
      <SheetSetupModal onDone={handleSheetConfigured} />
    )
  }

  // ── Authenticated ──────────────────────────────────────────────────
  return (
    <ToastProvider>
      <div className="layout">
        <TopBar
          view={view}
          onNav={v => setView(v as View)}
          theme={theme}
          onTheme={handleTheme}
          onSignOut={handleSignOut}
        />

        {view === 'home'     && <HomeView />}
        {view === 'browse'   && <BrowseView />}
        {view === 'settings' && (
          <SettingsView
            theme={theme}
            onTheme={handleTheme}
            onChangeSheet={() => {
              Config.clearSheetId()
              setAuthState('needs-sheet')
            }}
          />
        )}

        {/* Mobile bottom nav */}
        <nav className="bottom-nav">
          <button className={`bn-btn${view === 'home'   ? ' active' : ''}`} onClick={() => setView('home')}>
            <span className="bn-icon">🏠</span><span className="bn-label">Home</span>
          </button>
          <button className={`bn-btn${view === 'browse' ? ' active' : ''}`} onClick={() => setView('browse')}>
            <span className="bn-icon">📋</span><span className="bn-label">Browse</span>
          </button>
          <button className={`bn-btn${view === 'settings' ? ' active' : ''}`} onClick={() => setView('settings')}>
            <span className="bn-icon">⚙️</span><span className="bn-label">Settings</span>
          </button>
        </nav>
      </div>
    </ToastProvider>
  )
}
