#!/usr/bin/env node
/**
 * scripts/exchange-oauth-code.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Write scripts/.token.json from an authorization code you paste in.
 *
 *   node scripts/exchange-oauth-code.mjs 'http://localhost:3000/?code=4/0A…&scope=…'
 *   node scripts/exchange-oauth-code.mjs '4/0A…'
 *
 * Why: reauth.mjs only works if Google's redirect actually reaches its local
 * listener on :3000. When it doesn't (proxy, a browser that won't hit loopback,
 * a tab closed too early), the code is still sitting in the address bar of the
 * page you landed on — even one that rendered "can't be reached". Paste that
 * whole URL here and the exchange happens without any local server.
 *
 * Codes are single-use and expire in ~10 minutes, so do this straight after
 * consenting. redirect_uri must match the one the code was issued for.
 */
import { google }              from 'googleapis'
import { readFile, writeFile } from 'fs/promises'
import { dirname, join }       from 'path'
import { fileURLToPath }       from 'url'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const REDIRECT   = 'http://localhost:3000'   // must match reauth.mjs / the auth URL

const raw = process.argv[2]
if (!raw) {
  console.error("Usage: node scripts/exchange-oauth-code.mjs '<pasted redirect URL, or bare code>'")
  process.exit(1)
}

// Accept either the whole redirect URL or just the code. Quote the URL in the
// shell — an unquoted & would background the command and truncate the code.
let code = raw.trim()
if (code.startsWith('http')) {
  const u = new URL(code)
  const err = u.searchParams.get('error')
  if (err) {
    console.error(`Google returned an error instead of a code: ${err}`)
    if (err === 'redirect_uri_mismatch') {
      console.error(`Add ${REDIRECT} to this OAuth client's authorized redirect URIs in the Cloud console.`)
    }
    process.exit(1)
  }
  code = u.searchParams.get('code') ?? ''
}
if (!code) { console.error('No ?code= found in that URL.'); process.exit(1) }

const creds = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
const cfg   = creds.installed ?? creds.web
const client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, REDIRECT)

try {
  const { tokens } = await client.getToken(code)
  if (!tokens.refresh_token) {
    console.error('⚠ No refresh_token in the response — the auth URL needs access_type=offline&prompt=consent.')
  }
  await writeFile(TOKEN_PATH, JSON.stringify(tokens))
  console.log('✓ Token saved to scripts/.token.json')
  console.log(`  scopes: ${tokens.scope ?? '(none reported)'}`)
} catch (e) {
  const d = e?.response?.data
  console.error(`Exchange failed: ${d?.error ?? e.message}${d?.error_description ? ` — ${d.error_description}` : ''}`)
  if (d?.error === 'invalid_grant') console.error('That code was already used or has expired — consent again and paste the fresh URL.')
  process.exit(1)
}
