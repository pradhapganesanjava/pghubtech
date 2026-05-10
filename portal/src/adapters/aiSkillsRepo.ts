// AI Skills — named instruction blocks the user maintains so future AI
// conversations can be primed with a chosen "skill" (e.g. "Bash one-liners",
// "Code review", "Translation editor"). Stored as a sheet tab so the
// instructions live next to the rest of the user's data.

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const TAB  = 'AISkills'
const HEADERS = [
  'id', 'name', 'description', 'instruction', 'enabled',
  'created_at', 'updated_at', 'slug',
] as const

// Slugs identify built-in skills that other code paths read by a known key
// (e.g. the ToDo generator reads the skill with slug "todo_generate" as its
// system prompt). User-created skills leave slug empty.
export interface AISkill {
  id:          string
  name:        string
  description: string
  instruction: string
  enabled:     boolean
  createdAt:   string
  updatedAt:   string
  slug:        string
}

function auth(json = false): Record<string, string> {
  const t = GAuth.getToken()
  if (!t) throw new Error('Not authenticated')
  const h: Record<string, string> = { Authorization: `Bearer ${t}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

function sid(): string {
  const id = Config.sheetId
  if (!id) throw new Error('Sheet ID not configured')
  return id
}

async function expectOk(res: Response, label: string): Promise<unknown> {
  if (res.ok) return res.json().catch(() => ({}))
  const err = await res.text().catch(() => '')
  throw new Error(`${label} failed: ${res.status} ${err.slice(0, 200)}`)
}

let _ensured = false

async function ensureTab(): Promise<void> {
  if (_ensured) return
  const res = await fetch(`${BASE}/${sid()}?fields=sheets.properties.title`, { headers: auth() })
  if (!res.ok) return
  const data = await res.json() as { sheets?: { properties?: { title?: string } }[] }
  const have = (data.sheets ?? []).map(s => s.properties?.title ?? '')
  if (!have.includes(TAB)) {
    await fetch(`${BASE}/${sid()}:batchUpdate`, {
      method:  'POST', headers: auth(true),
      body:    JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] }),
    }).then(r => expectOk(r, 'Add AISkills tab'))
    await fetch(
      `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A1:H1`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth(true), body: JSON.stringify({ values: [HEADERS as unknown as string[]] }) },
    ).then(r => expectOk(r, 'Init AISkills headers'))
  }
  _ensured = true
}

function rowToSkill(r: string[]): AISkill | null {
  if (!r[0]) return null
  return {
    id:          r[0],
    name:        r[1] ?? '',
    description: r[2] ?? '',
    instruction: r[3] ?? '',
    enabled:     (r[4] ?? '').toLowerCase() === 'true',
    createdAt:   r[5] ?? '',
    updatedAt:   r[6] ?? '',
    slug:        r[7] ?? '',
  }
}

function skillToRow(s: AISkill): string[] {
  return [
    s.id, s.name, s.description, s.instruction,
    String(s.enabled), s.createdAt, s.updatedAt, s.slug ?? '',
  ]
}

function uuid(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function listSkills(): Promise<AISkill[]> {
  await ensureTab()
  const r = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A2:H`)}`,
    { headers: auth() },
  )
  const d = await r.json() as { values?: string[][] }
  return (d.values ?? []).map(rowToSkill).filter((s): s is AISkill => s != null)
}

export async function createSkill(input: {
  name: string; description?: string; instruction?: string; enabled?: boolean; slug?: string
}): Promise<AISkill> {
  await ensureTab()
  const now = new Date().toISOString()
  const skill: AISkill = {
    id:          uuid(),
    name:        input.name.trim() || 'New skill',
    description: input.description ?? '',
    instruction: input.instruction ?? '',
    enabled:     input.enabled ?? false,
    createdAt:   now,
    updatedAt:   now,
    slug:        input.slug ?? '',
  }
  await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A:H`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method:  'POST', headers: auth(true),
      body:    JSON.stringify({ values: [skillToRow(skill)] }),
    },
  ).then(r => expectOk(r, 'Append skill'))
  return skill
}

export async function updateSkill(skill: AISkill): Promise<void> {
  await ensureTab()
  const r = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A:A`)}`,
    { headers: auth() },
  )
  const d = await r.json() as { values?: string[][] }
  const rows = d.values ?? []
  const idx = rows.findIndex(row => row[0] === skill.id)
  if (idx < 0) throw new Error('Skill row not found')
  const updated = { ...skill, updatedAt: new Date().toISOString() }
  await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A${idx + 1}:H${idx + 1}`)}?valueInputOption=RAW`,
    {
      method:  'PUT', headers: auth(true),
      body:    JSON.stringify({ values: [skillToRow(updated)] }),
    },
  ).then(r2 => expectOk(r2, 'Update skill'))
}

// Look up an existing skill by slug, or create one with the provided defaults
// if no row carries that slug yet. Used to seed built-in instructions (e.g.
// the ToDo generator's prompt) so the user sees a normal editable row in
// AI Skills and other features always have something to read.
export async function ensureSkillBySlug(
  slug: string,
  defaults: { name: string; description?: string; instruction: string },
): Promise<AISkill> {
  const all = await listSkills()
  const found = all.find(s => s.slug === slug)
  if (found) return found
  return createSkill({
    name:        defaults.name,
    description: defaults.description ?? '',
    instruction: defaults.instruction,
    enabled:     true,
    slug,
  })
}

export async function getSkillBySlug(slug: string): Promise<AISkill | null> {
  const all = await listSkills()
  return all.find(s => s.slug === slug) ?? null
}

export async function deleteSkill(id: string): Promise<void> {
  await ensureTab()
  const meta = await fetch(`${BASE}/${sid()}?fields=sheets.properties(sheetId,title)`, { headers: auth() })
  const data = await meta.json() as { sheets: { properties: { sheetId: number; title: string } }[] }
  const sheetId = data.sheets.find(s => s.properties.title === TAB)?.properties?.sheetId
  if (sheetId == null) return
  const r = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(`${TAB}!A:A`)}`,
    { headers: auth() },
  )
  const d = await r.json() as { values?: string[][] }
  const rows = d.values ?? []
  const idx = rows.findIndex(row => row[0] === id)
  if (idx < 0) return
  await fetch(`${BASE}/${sid()}:batchUpdate`, {
    method:  'POST', headers: auth(true),
    body:    JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
        },
      }],
    }),
  }).then(r2 => expectOk(r2, 'Delete skill'))
}
