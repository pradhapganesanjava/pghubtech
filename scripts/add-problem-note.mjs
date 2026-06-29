#!/usr/bin/env node
/**
 * scripts/add-problem-note.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Attach an HTML note to a problem's AdsHub "Notes" pane, and optionally
 * rewrite its description (column J).
 *
 *   node scripts/add-problem-note.mjs <slug> --note body.html [--desc-json prob.json] [--write]
 *
 * The note body (inner HTML) is wrapped exactly like the portal's saveProblemNote
 * (wrapNoteHtml) and uploaded as <slug>.html; the Drive file id + has_notes='1'
 * are written to LCProblems cols K/L.
 *
 * ⚠ Cross-client caveat: this uses the SCRIPTS OAuth client (desktop), which is
 * NOT the portal's web client. The portal can VIEW the note (its login grants
 * drive.readonly), but editing+saving it in the portal may fail because the
 * portal's drive.file scope can't write a file it didn't create. To make it
 * portal-editable, recreate the note from the portal UI.
 */
import { google }       from 'googleapis'
import { readFile, writeFile } from 'fs/promises'
import { createServer } from 'http'
import { exec }         from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const SCOPES     = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
const TAB        = 'LCProblems'

const ARGS     = process.argv.slice(2)
const DO_WRITE = ARGS.includes('--write')
const flag = (name) => { const i = ARGS.indexOf(name); return i >= 0 ? ARGS[i + 1] : null }
const SLUG     = ARGS.find(a => !a.startsWith('--') && a !== flag('--note') && a !== flag('--desc-json'))
const NOTE_F   = flag('--note')
const DESC_J   = flag('--desc-json')
if (!SLUG || (!NOTE_F && !DESC_J)) {
  console.error('Usage: node scripts/add-problem-note.mjs <slug> [--note body.html] [--desc-json prob.json] [--write]')
  console.error('  (at least one of --note / --desc-json required)')
  process.exit(1)
}

function wrapNoteHtml(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notes</title>
<style>
  html,body{margin:0;padding:16px;background:#fff;color:#1a1a2e;
    font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  img{max-width:100%;height:auto;}
  .hw-doc{display:none;}
  .hw-page{display:block;max-width:100%;margin:0 auto 12px;border:1px solid #e1e4e8;border-radius:4px;}
  pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;
    padding:10px;border-radius:6px;border:1px solid #e1e4e8;}
  code{background:#f6f8fa;padding:1px 5px;border-radius:3px;}
  blockquote{border-left:3px solid #d0d7de;margin:6px 0;padding:2px 12px;color:#57606a;}
  h1,h2,h3{margin:10px 0 4px;}
  table{max-width:100%;border-collapse:collapse;}
</style>
</head>
<body>
${body}
</body>
</html>`
}

async function loadEnv() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  const env = {}
  for (const line of text.split('\n')) { const eq = line.indexOf('='); if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim() }
  if (!env.VITE_SHEET_ID) throw new Error('Missing VITE_SHEET_ID in portal/.env.local')
  return { sheetId: env.VITE_SHEET_ID }
}
async function authorize() {
  const creds = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
  const cfg = creds.installed ?? creds.web
  const c = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
  try {
    const token = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
    const granted = (token.scope ?? '').split(/\s+/)
    if (!SCOPES.every(s => granted.includes(s))) return getNewToken(c)
    c.setCredentials(token)
    c.on('tokens', t => writeFile(TOKEN_PATH, JSON.stringify({ ...token, ...t })))
    return c
  } catch { return getNewToken(c) }
}
function getNewToken(c) {
  const url = c.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES })
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const code = new URL(req.url, 'http://localhost:3000').searchParams.get('code')
      if (!code) { res.end('No code'); return }
      res.end('<h2>✓ Authorized — close this tab.</h2>'); server.close()
      try { const { tokens } = await c.getToken(code); c.setCredentials(tokens); await writeFile(TOKEN_PATH, JSON.stringify(tokens)); resolve(c) } catch (e) { reject(e) }
    })
    server.listen(3000, () => { console.log('\nAuthorize in browser:\n  ' + url + '\n'); exec(`open "${url}"`) })
    server.on('error', reject)
  })
}

async function main() {
  const { sheetId } = await loadEnv()
  const auth   = await authorize()
  const sheets = google.sheets({ version: 'v4', auth })
  const drive  = google.drive({ version: 'v3', auth })

  // Locate the row by slug.
  const slugs = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!A2:A` })).data.values || []
  const idx = slugs.findIndex(r => (r[0] || '').trim() === SLUG)
  if (idx < 0) throw new Error(`slug "${SLUG}" not found in ${TAB}`)
  const rowNum = idx + 2
  const existingId = ((await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!K${rowNum}` })).data.values?.[0]?.[0] || '').trim()

  const wrapped = NOTE_F ? wrapNoteHtml((await readFile(NOTE_F, 'utf8')).trim()) : null
  let desc = null
  if (DESC_J) desc = JSON.parse(await readFile(DESC_J, 'utf8')).description_html ?? null

  console.log(`\n  Problem slug: ${SLUG}  (row ${rowNum})`)
  if (NOTE_F) console.log(`  Note body: ${NOTE_F} → ${existingId ? 'UPDATE ' + existingId : 'CREATE <slug>.html'}`)
  if (desc != null) console.log(`  Description (col J): rewrite from ${DESC_J} (${desc.length} chars)`)
  if (!DO_WRITE) { console.log('\n  [dry-run] pass --write to apply.\n'); return }

  // Upload / update the note Drive file (only when --note given) + write K/L.
  if (NOTE_F) {
    let driveId = existingId
    if (driveId) {
      await drive.files.update({ fileId: driveId, media: { mimeType: 'text/html', body: wrapped } })
    } else {
      driveId = (await drive.files.create({
        requestBody: { name: `${SLUG}.html` },
        media: { mimeType: 'text/html', body: wrapped },
        fields: 'id',
      })).data.id
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId, range: `${TAB}!K${rowNum}:L${rowNum}`, valueInputOption: 'RAW',
      requestBody: { values: [[driveId, '1']] },
    })
  }
  if (desc != null) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId, range: `${TAB}!J${rowNum}`, valueInputOption: 'RAW',
      requestBody: { values: [[desc]] },
    })
  }
  console.log(`\n  ✓ ${NOTE_F ? 'Note set; ' : ''}${desc != null ? 'description rewritten' : ''}.\n`)
}
main().catch(e => { console.error(e.message); process.exit(1) })
