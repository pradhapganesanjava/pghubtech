// TechHub — a separate repo (PGHubTechnologies, published at /PGHubTechnologies)
// rendered in place. Same arrangement as SysDsgHubView; see that file for the
// long form of the reasoning.
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

// Trailing slash on purpose: GitHub Pages 301s /PGHubTechnologies to
// /PGHubTechnologies/, and paying for that redirect inside an iframe on every
// open is avoidable. The origin is already covered by the frame-src entry in
// index.html, and this app is the host that its parent-auth.js trusts.
// Case matters: Pages serves this path case-sensitively, so /pghubtechnologies/
// is a 404 while /PGHubTechnologies/ is the live site.
const SRC    = 'https://pradhapganesanjava.github.io/PGHubTechnologies/'
const ORIGIN = new URL(SRC).origin

export default function TechHubView() {
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
  // Same origin is not enough on its own here: the two apps namespace their
  // storage keys differently ('pghubtechs_tok' there, 'pghtech_tok' here), and
  // the child's parent-auth.js exists precisely to rewrite what we post under
  // its own key. It also covers `npm run dev`, where the parent is on localhost
  // and the frame is not.
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
          <span>Opening Tech Hub…</span>
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
        title="Tech Hub"
        onLoad={() => { setLoaded(true); sendAuth() }}
        allow="clipboard-write; clipboard-read"
        style={{ visibility: loaded ? 'visible' : 'hidden' }}
      />
    </div>
  )
}
