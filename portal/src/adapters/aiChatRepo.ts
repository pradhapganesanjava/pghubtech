// Persistence for the Ask AI floating panel. Each message is one row; rows
// belonging to the same conversation share a conv_id. The first user message
// of a conversation becomes its title for the picker.

import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const TAB  = 'AIChat'

const HEADERS = ['conv_id', 'ts', 'role', 'content'] as const

export type ChatRole = 'user' | 'assistant'

export interface AIMessage {
  convId:  string
  ts:      string  // ISO
  role:    ChatRole
  content: string
}

export interface ConversationSummary {
  convId:    string
  startedAt: string
  lastTs:    string
  title:     string  // first user message (or "Empty" if none)
  msgCount:  number
}

function auth(): Record<string, string> {
  const t = GAuth.getToken()
  if (!t) throw new Error('Not authenticated')
  return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
}
function sid(): string {
  const id = Config.sheetId
  if (!id) throw new Error('Sheet ID not configured')
  return id
}

let _tabEnsured = false
let _tabPending: Promise<void> | null = null

async function ensureTab(): Promise<void> {
  if (_tabEnsured) return
  if (_tabPending) return _tabPending
  _tabPending = (async () => {
    const res = await fetch(`${BASE}/${sid()}?fields=sheets.properties.title`, { headers: auth() })
    if (!res.ok) return
    const data = await res.json() as { sheets?: { properties?: { title?: string } }[] }
    const tabs = (data.sheets ?? []).map(s => s.properties?.title ?? '')
    if (!tabs.includes(TAB)) {
      await fetch(`${BASE}/${sid()}:batchUpdate`, {
        method:  'POST', headers: auth(),
        body:    JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] }),
      })
      await fetch(
        `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A1')}?valueInputOption=RAW`,
        { method: 'PUT', headers: auth(), body: JSON.stringify({ values: [HEADERS as unknown as string[]] }) }
      )
    }
    _tabEnsured = true
  })().finally(() => { _tabPending = null })
  return _tabPending
}

function rowToMsg(r: string[]): AIMessage | null {
  if (!r[0] || !r[2]) return null
  const role = (r[2] === 'assistant' ? 'assistant' : 'user') as ChatRole
  return { convId: r[0], ts: r[1] ?? '', role, content: r[3] ?? '' }
}

export async function loadAllMessages(): Promise<AIMessage[]> {
  await ensureTab()
  const res = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A2:D')}`,
    { headers: auth() },
  )
  if (!res.ok) throw new Error(`Failed to load AI chat: ${res.status}`)
  const data = await res.json() as { values?: string[][] }
  return (data.values ?? []).map(rowToMsg).filter((m): m is AIMessage => m != null)
}

export function summarise(messages: AIMessage[]): ConversationSummary[] {
  const byConv = new Map<string, AIMessage[]>()
  for (const m of messages) {
    if (!byConv.has(m.convId)) byConv.set(m.convId, [])
    byConv.get(m.convId)!.push(m)
  }
  const out: ConversationSummary[] = []
  for (const [convId, msgs] of byConv) {
    const sorted    = msgs.slice().sort((a, b) => a.ts.localeCompare(b.ts))
    const startedAt = sorted[0]?.ts ?? ''
    const lastTs    = sorted[sorted.length - 1]?.ts ?? ''
    const firstUser = sorted.find(m => m.role === 'user')?.content ?? ''
    const title     = (firstUser || sorted[0]?.content || 'New chat').slice(0, 80)
    out.push({ convId, startedAt, lastTs, title, msgCount: sorted.length })
  }
  // Newest conversations first.
  out.sort((a, b) => b.lastTs.localeCompare(a.lastTs))
  return out
}

export async function appendMessage(msg: AIMessage): Promise<void> {
  await ensureTab()
  const res = await fetch(
    `${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A:D')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method:  'POST',
      headers: auth(),
      body:    JSON.stringify({ values: [[msg.convId, msg.ts, msg.role, msg.content]] }),
    },
  )
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Append AI message failed: ${res.status} ${err.slice(0, 160)}`)
  }
}

// Bulk delete every row of a given conversation.
export async function deleteConversation(convId: string): Promise<void> {
  await ensureTab()
  const [meta, rowsRes] = await Promise.all([
    fetch(`${BASE}/${sid()}?fields=sheets.properties(sheetId,title)`, { headers: auth() }).then(r => r.json()),
    fetch(`${BASE}/${sid()}/values/${encodeURIComponent(TAB + '!A:A')}`, { headers: auth() }).then(r => r.json()),
  ]) as [
    { sheets?: { properties?: { sheetId: number; title: string } }[] },
    { values?: string[][] },
  ]
  const sheetId = (meta.sheets ?? []).find(s => s.properties?.title === TAB)?.properties?.sheetId
  if (sheetId == null) return

  const rows = rowsRes.values ?? []
  const targets: number[] = []  // 0-based row indices to delete
  rows.forEach((r, i) => { if (r[0] === convId) targets.push(i) })
  if (targets.length === 0) return

  // Delete from the bottom up so the indices we've already collected stay valid.
  targets.sort((a, b) => b - a)
  const requests = targets.map(idx => ({
    deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
    },
  }))

  await fetch(`${BASE}/${sid()}:batchUpdate`, {
    method:  'POST', headers: auth(),
    body:    JSON.stringify({ requests }),
  })
}

export function newConvId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
