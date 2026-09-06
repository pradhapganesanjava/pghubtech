// SysDsgHub — a separate repo (SysDsgHub, published at /PGHubSysDsg) rendered in place.
//
// It ships as its own GitHub Pages site but lives on the SAME ORIGIN as this
// portal (pradhapganesanjava.github.io), so an iframe here shares localStorage
// with it — which is where GAuth keeps the token. The sign-in therefore carries
// over with no handshake, no postMessage, no second consent screen. That is
// only true in production: under `npm run dev` the portal is on localhost, the
// frame is not, and the embedded app falls back to its own stored session.
//
// Deliberately NOT sandboxed: a sandbox without allow-same-origin would put the
// frame in an opaque origin and cost exactly the storage sharing that makes
// this work. The framed app is ours, from our own origin.

import { useEffect, useRef, useState } from 'react'
import { GAuth } from '../lib/gauth'

// Trailing slash on purpose: GitHub Pages 301s /PGHubSysDsg to /PGHubSysDsg/,
// and paying for that redirect inside an iframe on every open is avoidable.
// Only the PATH changed when this moved — the origin is the same, so the
// frame-src entry in index.html and the trusted origin in the child app's
// parent-auth.js both still hold.
// Case matters: Pages serves this path case-sensitively, so /pghubsysdsg/ is
// a 404 while /PGHubSysDsg/ is the live site.
const SRC    = 'https://pradhapganesanjava.github.io/PGHubSysDsg/'
const ORIGIN = new URL(SRC).origin

export default function SysDsgHubView() {
  const [loaded, setLoaded] = useState(false)
  const [slow, setSlow]     = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)

  // A blank frame and a slow frame look identical, so say something after a
  // few seconds rather than leaving the pane empty and unexplained.
  useEffect(() => {
    if (loaded) return
    const t = window.setTimeout(() => setSlow(true), 4000)
    return () => window.clearTimeout(t)
  }, [loaded])

  // Hand the child our session so it never shows a second sign-in.
  //
  // In production this is usually redundant — same origin means the frame
  // already shares this tab's sessionStorage, where GAuth keeps `pghtech_tok`.
  // It matters when that is not true: under `npm run dev` the parent is on
  // localhost and the frame is not, and it also covers the child storing its
  // session under different keys.
  //
  // targetOrigin is pinned to the app's exact origin — never '*'. A wildcard
  // would post an OAuth token to whatever happens to be framed.
  function sendAuth() {
    const token = GAuth.getToken()
    if (!token) return
    // The child stores { token, expires } and refuses a record with under five
    // minutes left, so a guessed expiry would either be rejected or — worse —
    // claim more life than the token has. Read the real one off our own record.
    let expires = 0
    try {
      const raw = sessionStorage.getItem('pghtech_tok')
      if (raw) expires = Number(JSON.parse(raw)?.expires) || 0
    } catch { /* fall through to no expiry */ }
    if (!expires) return
    frameRef.current?.contentWindow?.postMessage(
      { type: 'pghubtech:auth', token, expires, user: GAuth.getUser() },
      ORIGIN,
    )
  }

  // The child asks when it is ready, which avoids racing its bootstrap; the
  // onLoad push below covers a child that never asks.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== ORIGIN) return
      if ((e.data as { type?: string } | null)?.type === 'pghubtech:auth-request') sendAuth()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  return (
    <div className="ext-embed">
      {!loaded && (
        <div className="ext-embed-load">
          <div className="spinner" />
          <span>Opening SysDsgHub…</span>
          {slow && (
            <a className="ext-embed-link" href={SRC} target="_blank" rel="noopener noreferrer">
              Taking a while — open it in a new tab ↗
            </a>
          )}
        </div>
      )}
      <iframe
        ref={frameRef}
        className="ext-embed-frame"
        src={SRC}
        title="SysDsgHub"
        onLoad={() => { setLoaded(true); sendAuth() }}
        allow="clipboard-write; clipboard-read"
        style={{ visibility: loaded ? 'visible' : 'hidden' }}
      />
    </div>
  )
}
