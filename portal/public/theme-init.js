// Sync the user's saved theme before React mounts to avoid a flash of the
// default (dark) theme on load. Extracted from an inline <script> so the CSP
// can drop 'unsafe-inline' for script-src.
(function () {
  try {
    var t = localStorage.getItem('pghtech_theme')
    if (t && t !== 'dark') document.documentElement.setAttribute('data-theme', t)
  } catch (_) { /* localStorage may be blocked — harmless */ }
})()
