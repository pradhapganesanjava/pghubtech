// Applies an AI note plan (lib/noteGen.ts → planNote) to the tree, in memory.
//
// Pure: takes the current nodes and the plan, returns the new tree plus what
// changed. The model's output is treated as untrusted — every op is checked
// against the tree rules, and an op that would break them is skipped and
// logged rather than applied. Nothing is ever deleted, and no spoken segment
// is dropped: one the plan forgot to place lands in an Inbox page.

import type { NoteNode } from '../adapters/notesRepo'
import type { NotePlan, PlanOp } from './noteGen'

export interface ContentFill {
  nodeId:  string
  segment: string     // segment key
  append:  boolean    // add to existing content vs. a fresh page
}

export interface AppliedPlan {
  nodes:   NoteNode[]   // the whole tree after the plan
  created: string[]     // ids of new nodes
  changed: string[]     // ids of existing nodes that were moved or renamed
  fills:   ContentFill[]
  log:     string[]     // what happened, for the person to read
  skipped: string[]     // ops refused, and why
}

const INBOX = 'Inbox'

export function applyPlan(
  nodes: NoteNode[], plan: NotePlan, newId: () => string, now = new Date().toISOString(),
): AppliedPlan {
  const byId    = new Map(nodes.map(n => [n.id, { ...n }]))
  const refs    = new Map<string, string>()
  const created = new Set<string>()
  const changed = new Set<string>()
  const fills: ContentFill[] = []
  const log: string[] = []
  const skipped: string[] = []
  const segs    = new Map(plan.segments.map(s => [s.key, s.text]))
  const usedSeg = new Set<string>()

  // '' = top level; null = unresolvable.
  const resolve = (x: unknown): string | null => {
    const k = String(x ?? '').trim()
    if (!k || k.toUpperCase() === 'ROOT') return ''
    if (refs.has(k)) return refs.get(k)!
    return byId.has(k) ? k : null
  }
  const pathOf = (id: string): string => {
    const parts: string[] = []
    for (let n = byId.get(id); n; n = byId.get(n.parentId)) parts.unshift(n.title)
    return parts.join(' › ')
  }
  const isUnder = (id: string, ancestor: string): boolean => {
    for (let n = byId.get(id); n; n = byId.get(n.parentId)) if (n.id === ancestor) return true
    return false
  }
  const nextPos = (parentId: string): number => {
    let max = -1
    for (const n of byId.values()) if (n.parentId === parentId) max = Math.max(max, n.position)
    return max + 1
  }
  const make = (parentId: string, title: string, kind: NoteNode['kind']): NoteNode => {
    const n: NoteNode = {
      id: newId(), parentId, title: title.trim() || 'Untitled', content: '',
      position: nextPos(parentId), tags: [], createdAt: now, updatedAt: now, kind,
    }
    byId.set(n.id, n); created.add(n.id)
    return n
  }
  const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const takeSegment = (key: unknown, why: string): string | null => {
    const k = String(key ?? '').trim()
    if (!segs.has(k))    { skipped.push(`${why}: unknown segment "${k}"`); return null }
    if (usedSeg.has(k))  { skipped.push(`${why}: segment "${k}" already placed`); return null }
    usedSeg.add(k)
    return k
  }

  for (const raw of plan.ops.slice(0, 60) as Partial<PlanOp & Record<string, unknown>>[]) {
    const op = raw as Record<string, unknown>
    switch (op.op) {
      case 'section': {
        const title  = String(op.title ?? '').trim()
        const parent = resolve(op.parent)
        if (!title || parent === null) { skipped.push(`Section "${title}": unknown parent`); break }
        if (parent && byId.get(parent)!.kind !== 'section') {
          skipped.push(`Section "${title}": a section can't go under a page`); break
        }
        // A section that already exists under this parent is reused, not doubled.
        const hit = [...byId.values()].find(n =>
          n.parentId === parent && n.kind === 'section' && sameTitle(n.title, title))
        const node = hit ?? make(parent, title, 'section')
        if (op.ref) refs.set(String(op.ref), node.id)
        if (!hit) log.push(`＋ Section  ${pathOf(node.id)}`)
        break
      }
      case 'page': {
        const title  = String(op.title ?? '').trim()
        const parent = resolve(op.parent)
        if (parent === null) { skipped.push(`Page "${title}": unknown parent`); break }
        const seg = takeSegment(op.segment, `Page "${title}"`)
        if (!seg) break
        const node = make(parent, title, 'page')
        if (op.ref) refs.set(String(op.ref), node.id)
        fills.push({ nodeId: node.id, segment: seg, append: false })
        log.push(`＋ Page     ${pathOf(node.id)}`)
        break
      }
      case 'append': {
        const target = resolve(op.target)
        const node   = target ? byId.get(target) : undefined
        if (!node || node.kind !== 'page') { skipped.push(`Append: "${String(op.target)}" is not a page`); break }
        const seg = takeSegment(op.segment, `Append to "${node.title}"`)
        if (!seg) break
        fills.push({ nodeId: node.id, segment: seg, append: !created.has(node.id) || fills.some(f => f.nodeId === node.id) })
        if (!created.has(node.id)) changed.add(node.id)
        log.push(`↳ Added to  ${pathOf(node.id)}`)
        break
      }
      case 'move': {
        const id     = resolve(op.node)
        const parent = resolve(op.parent)
        const node   = id ? byId.get(id) : undefined
        if (!node || parent === null) { skipped.push(`Move "${String(op.node)}": unknown node or parent`); break }
        const dest = parent ? byId.get(parent)! : null
        if (node.kind === 'section' && dest?.kind === 'page') {
          skipped.push(`Move "${node.title}": a section can't go under a page`); break
        }
        if (parent === node.id || (parent && isUnder(parent, node.id))) {
          skipped.push(`Move "${node.title}": can't move into itself`); break
        }
        if (node.parentId === parent) break
        const from = pathOf(node.id)
        node.parentId = parent
        node.position = nextPos(parent)
        if (!created.has(node.id)) changed.add(node.id)
        log.push(`⇄ Moved     ${from}  →  ${pathOf(node.id)}`)
        break
      }
      case 'rename': {
        const id    = resolve(op.node)
        const node  = id ? byId.get(id) : undefined
        const title = String(op.title ?? '').trim()
        if (!node || !title) { skipped.push(`Rename "${String(op.node)}": unknown node`); break }
        if (sameTitle(node.title, title)) break
        const from = node.title
        node.title = title
        if (!created.has(node.id)) changed.add(node.id)
        log.push(`✎ Renamed   ${from}  →  ${title}`)
        break
      }
      default:
        skipped.push(`Unknown op "${String(op.op)}"`)
    }
  }

  // Anything the plan forgot still gets kept.
  for (const s of plan.segments) {
    if (usedSeg.has(s.key)) continue
    const inbox = [...byId.values()].find(n => n.parentId === '' && n.kind === 'section' && sameTitle(n.title, INBOX))
      ?? make('', INBOX, 'section')
    const words = s.text.split(/\s+/).slice(0, 6).join(' ')
    const page  = make(inbox.id, words.length > 50 ? words.slice(0, 47) + '…' : words, 'page')
    fills.push({ nodeId: page.id, segment: s.key, append: false })
    usedSeg.add(s.key)
    log.push(`＋ Page     ${pathOf(page.id)}  (not placed by AI)`)
  }

  return {
    nodes:   [...byId.values()],
    created: [...created],
    changed: [...changed],
    fills, log, skipped,
  }
}
