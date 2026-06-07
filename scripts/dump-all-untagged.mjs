#!/usr/bin/env node
// READ ONLY. Union of untagged (no pat_*) problems across ALL LCLists, deduped by id.
import { google } from 'googleapis'
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
const __dir = dirname(fileURLToPath(import.meta.url))
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
async function loadEnv() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8'); const env = {}
  for (const line of text.split('\n')) { const eq = line.indexOf('='); if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim() }
  return { sheetId: env.VITE_SHEET_ID }
}
async function authorize() {
  const creds = JSON.parse(await readFile(join(__dir, 'credentials.json'), 'utf8')); const cfg = creds.installed ?? creds.web
  const c = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
  c.setCredentials(JSON.parse(await readFile(join(__dir, '.token.json'), 'utf8'))); return c
}
const { sheetId } = await loadEnv()
const sheets = google.sheets({ version: 'v4', auth: await authorize() })
const lists = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'LCLists!A2:B' })).data.values || []
const slugToLists = new Map()
for (const r of lists) { const name = (r[0] || '').trim(), slug = (r[1] || '').trim(); if (!slug) continue; if (!slugToLists.has(slug)) slugToLists.set(slug, []); slugToLists.get(slug).push(name) }
const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'LCProblems!A2:H' })).data.values || []
const out = []
const perList = {}
for (const r of rows) {
  const slug = (r[0] || '').trim()
  if (!slugToLists.has(slug)) continue
  const pats = (r[7] || '').split(/[;\n]+/).map(s => s.trim()).filter(s => /^pat_/.test(s))
  const ls = slugToLists.get(slug)
  for (const l of ls) { perList[l] = perList[l] || { total: 0, untagged: 0 }; perList[l].total++; if (!pats.length) perList[l].untagged++ }
  if (!pats.length) out.push({ id: r[1] || '', title: r[2] || '', diff: r[3] || '', topics: r[4] || '', lists: ls })
}
out.sort((a, b) => Number(a.id) - Number(b.id))
console.error('Per-list live counts:')
for (const [k, v] of Object.entries(perList)) console.error(`  ${k.padEnd(20)} total ${String(v.total).padStart(3)}  untagged ${v.untagged}`)
console.error(`\nUnique untagged across all lists: ${out.length}\n`)
console.log(JSON.stringify(out, null, 2))
