// View ↔ URL path routing for the single-page app.
//
// The app lives under Vite's base path (import.meta.env.BASE_URL — '/pghubtech/'
// in production and dev). Each tab maps to a path segment under that base:
//
//   /pghubtech/             → landing (default — the signpost)
//   /pghubtech/start        → landing (alias, e.g. the brand click)
//   /pghubtech/home         → home (Anki's queue)
//   /pghubtech/anki         → anki (Home + Browse live here as sub-tabs)
//   /pghubtech/home         → home
//   /pghubtech/browse       → browse
//   /pghubtech/docs         → docs
//   /pghubtech/notes        → notes
//   /pghubtech/utils        → utils
//   /pghubtech/ads          → ads
//   /pghubtech/adshub       → ads-hub  (also matches AdsHub, ADSHUB — case-insensitive)
//   /pghubtech/sysdsghub    → sysdsg-hub (the /PGHubSysDsg app, framed in place)
//   /pghubtech/ai-skills    → ai-skills
//   /pghubtech/settings     → settings
//
// Direct URL access on GitHub Pages requires public/404.html (the rafgraph
// SPA-redirect trick) — see that file and the matching decode snippet in
// index.html.

export type View =
  | 'landing' | 'anki' | 'home' | 'browse' | 'docs' | 'notes' | 'utils'
  | 'sysdsg-hub'
  | 'ads' | 'ads-hub' | 'ai-skills' | 'settings'

const PATHS_BY_VIEW: Record<View, string> = {
  'landing':   'start',
  'anki':      'anki',
  // home / browse keep their own paths even though they are Anki sub-tabs now,
  // so existing links land on the right sub-tab instead of 404-ing.
  'home':      'home',
  'browse':    'browse',
  'docs':      'docs',
  'notes':     'notes',
  'utils':     'utils',
  'ads':       'ads',
  'ads-hub':   'adshub',
  'sysdsg-hub': 'sysdsghub',
  'ai-skills': 'ai-skills',
  'settings':  'settings',
}

const VIEWS_BY_PATH: Record<string, View> =
  Object.entries(PATHS_BY_VIEW).reduce((acc, [v, p]) => {
    acc[p] = v as View
    return acc
  }, {} as Record<string, View>)

function relativeTo(base: string, pathname: string): string {
  // Strip the configured base prefix so we're left with the in-app segment.
  const b = base.endsWith('/') ? base : base + '/'
  if (pathname === b.slice(0, -1) || pathname === b) return ''
  if (pathname.startsWith(b)) return pathname.slice(b.length)
  // Fallback when running off the base (e.g. a dev preview) — use whatever
  // comes after the first /.
  return pathname.replace(/^\/+/, '')
}

export function viewFromPath(pathname: string, base = import.meta.env.BASE_URL): View {
  const rel = relativeTo(base, pathname).replace(/^\/+|\/+$/g, '').toLowerCase()
  // The bare base is the landing page — the signpost, not a tab. An unknown
  // path lands there too: a signpost is a better answer to "where am I?" than
  // dropping someone into the review queue.
  if (!rel) return 'landing'
  return VIEWS_BY_PATH[rel] ?? 'landing'
}

export function pathForView(view: View, base = import.meta.env.BASE_URL): string {
  const b = base.endsWith('/') ? base : base + '/'
  // Landing owns the bare base, so its canonical URL is the site root; /start
  // stays a working alias. Home is a tab like any other and carries its own
  // segment — without this it would write the root URL and then resolve back
  // to landing on the next reload.
  if (view === 'landing') return b
  return b + PATHS_BY_VIEW[view]
}
