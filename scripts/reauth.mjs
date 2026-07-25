// One-off Google OAuth re-auth: refreshes scripts/.token.json.
// Run interactively:  node scripts/reauth.mjs   (opens a browser)
import { google }         from 'googleapis'
import { readFile, writeFile } from 'fs/promises'
import { dirname, join }   from 'path'
import { fileURLToPath }   from 'url'
import { createServer }    from 'http'
import { exec }            from 'child_process'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const SCOPES     = ['https://www.googleapis.com/auth/spreadsheets']

const creds = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
const cfg   = creds.installed ?? creds.web
const oAuth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')

const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES })
await new Promise((resolve, reject) => {
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith('/')) return
    const code = new URL(req.url, 'http://localhost:3000').searchParams.get('code')
    if (!code) { res.end('No code received'); return }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<h2>&#10003; Authorized! You can close this tab.</h2>')
    server.close()
    try {
      const { tokens } = await oAuth2Client.getToken(code)
      await writeFile(TOKEN_PATH, JSON.stringify(tokens))
      console.log('  Token saved to scripts/.token.json')
      resolve()
    } catch (e) { reject(e) }
  })
  server.listen(3000, () => {
    console.log('\nOpening browser for Google authorization…')
    console.log('If the browser does not open, visit:\n  ' + authUrl + '\n')
    exec(`open "${authUrl}"`)
  })
  server.on('error', reject)
})
