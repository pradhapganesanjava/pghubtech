import { useEffect, useState } from 'react'
import { GAuth } from './lib/gauth'
import { Config } from './services/config'
import { checkAccess, ensureHeaders, loadSettings, saveSetting, UnauthorizedError } from './adapters/sheetsRepo'
import { applyAiSettings } from './services/aiConfig'
import { ToastProvider } from './components/Toast'
import TopBar from './components/TopBar'
import SheetSetupModal from './components/SheetSetupModal'
import DocsView from './views/DocsView'
import AnkiView from './views/AnkiView'
import SysDsgHubView from './views/SysDsgHubView'
import LandingView from './views/LandingView'
import UtilsView from './views/UtilsView'
import AISkillsView from './views/AISkillsView'
import AdsView from './views/AdsView'
import AdsHubView from './views/AdsHubView'
import SettingsView from './views/SettingsView'
import AskAIPanel from './components/AskAIPanel'
import { viewFromPath, pathForView, type View } from './lib/routing'
import './App.css'

type AuthState = 'loading' | 'unauthenticated' | 'needs-sheet' | 'authenticated'

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
  // Initial view is read from the URL so direct links like /pghubtech/AdsHub
  // land on the right tab. See lib/routing.ts + public/404.html for the
  // GitHub Pages SPA fallback wiring.
  const [view, setView]           = useState<View>(() => viewFromPath(window.location.pathname))
  const [theme, setTheme]         = useState<string>(Config.theme)
  const [loginError, setLoginError] = useState('')
  const [aiOpen, setAiOpen]       = useState(false)

  // On mount: try to restore a session
  useEffect(() => {
    const hasSession = GAuth.restoreSession()
    if (hasSession) {
      if (!Config.isSheetConfigured()) {
        setAuthState('needs-sheet')
      } else {
        checkAccess()
          .then(async () => {
            const settings = await loadSettings().catch(() => ({}))
            if (settings.theme) {
              setTheme(settings.theme)
              Config.theme = settings.theme
            }
            // The same fetch already has the AI credentials in it; without this
            // every AI feature claims "not configured" until Settings is opened.
            applyAiSettings(settings)
            setAuthState('authenticated')
          })
          .catch(e => {
            if (e instanceof UnauthorizedError) {
              GAuth.signOut()
              setAuthState('unauthenticated')
            } else {
              setAuthState('needs-sheet')
            }
          })
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

  // Sync view → URL (pushState). Guarded so we don't push a redundant entry
  // when view was just set FROM the URL (popstate handler, initial mount).
  useEffect(() => {
    const target = pathForView(view)
    if (window.location.pathname !== target) {
      window.history.pushState({ view }, '', target)
    }
  }, [view])

  // Sync URL → view on browser back/forward.
  useEffect(() => {
    function onPop() { setView(viewFromPath(window.location.pathname)) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // A read/write whose token expired and could not be silently re-auth'd fires
  // gauth:expired (see GAuth.withAuthRetry). Drop to the login screen but keep
  // `view` untouched — after the user signs back in they land on the same tab,
  // which re-mounts and reloads its data automatically.
  useEffect(() => {
    function onExpired() {
      setLoginError('Your session expired — please sign in again to continue.')
      setAuthState('unauthenticated')
    }
    window.addEventListener('gauth:expired', onExpired)
    return () => window.removeEventListener('gauth:expired', onExpired)
  }, [])

  function handleTheme(t: string) {
    setTheme(t)
    Config.theme = t
    saveSetting('theme', t).catch(() => {})
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
        const settings = await loadSettings().catch(() => ({}))
        if (settings.theme) {
          setTheme(settings.theme)
          Config.theme = settings.theme
        }
        applyAiSettings(settings)
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
        {/* 'notes' is a legacy path that now resolves to the Utils view, so
            TopBar is told 'utils' for it rather than leaving the nav unlit. */}
        <TopBar
          view={
            view === 'notes' ? 'utils'
            : view === 'home' || view === 'browse' ? 'anki'
            : view
          }
          onNav={v => setView(v as View)}
          theme={theme}
          onTheme={handleTheme}
          onSignOut={handleSignOut}
          aiOpen={aiOpen}
          onToggleAI={() => setAiOpen(o => !o)}
        />

        {view === 'landing'  && <LandingView onNav={setView} />}
        {/* /home and /browse still resolve — they open Anki on that sub-tab, so
            existing links and bookmarks keep working. */}
        {(view === 'anki' || view === 'home' || view === 'browse') && (
          <AnkiView initialTab={view === 'browse' ? 'browse' : 'home'} />
        )}
        {view === 'docs'     && <DocsView />}
        {(view === 'utils' || view === 'notes') && (
          <UtilsView initialTab={view === 'notes' ? 'notes' : undefined} />
        )}
        {view === 'ads'      && <AdsView />}
        {view === 'ads-hub'  && <AdsHubView />}
        {view === 'sysdsg-hub' && <SysDsgHubView />}
        {view === 'ai-skills' && <AISkillsView />}
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

        {/* Ask AI floating panel — visible on every view */}
        <AskAIPanel open={aiOpen} onClose={() => setAiOpen(false)} />

        {/* Mobile bottom nav */}
        <nav className="bottom-nav">
          {/* Ads tab temporarily hidden (pghubads.web.app) — may remove later */}
          <button className={`bn-btn${view === 'ads-hub'  ? ' active' : ''}`} onClick={() => setView('ads-hub')}>
            <span className="bn-icon">🧠</span><span className="bn-label">AdsHub</span>
          </button>
          <button
            className={`bn-btn${view === 'sysdsg-hub' ? ' active' : ''}`}
            onClick={() => setView('sysdsg-hub')}
          >
            <span className="bn-icon">🏛</span><span className="bn-label">SysDsg</span>
          </button>
          <button
            className={`bn-btn${view === 'anki' || view === 'home' || view === 'browse' ? ' active' : ''}`}
            onClick={() => setView('anki')}
          >
            <span className="bn-icon">🧠</span><span className="bn-label">Anki</span>
          </button>
          <button className={`bn-btn${view === 'docs'     ? ' active' : ''}`} onClick={() => setView('docs')}>
            <span className="bn-icon">📄</span><span className="bn-label">Pages</span>
          </button>
          <button className={`bn-btn${view === 'utils' || view === 'notes' ? ' active' : ''}`} onClick={() => setView('utils')}>
            <span className="bn-icon">🧰</span><span className="bn-label">Utils</span>
          </button>
          {/* Settings is reachable via the avatar dropdown in the top bar
              (same place on desktop and mobile), so it's no longer in the
              bottom-nav row. */}
        </nav>
      </div>
    </ToastProvider>
  )
}
