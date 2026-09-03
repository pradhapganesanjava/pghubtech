import type { P2RItem } from '../adapters/point2remRepo'
import type { RecallItem } from '../adapters/recallRepo'

// Quiz / Recall is a random Q/A view of Point2Rem notes. Each note becomes a
// card: title (+ viz one-liner) is the question you answer cold; reveal shows
// the note body inline via `points`.

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function hintFromNote(item: P2RItem): string {
  const m = item.content.match(/p2r-viz-oneline[^>]*>([\s\S]*?)<\/div>/i)
  if (m) return stripTags(m[1])
  return ''
}

export function p2rToRecallCard(item: P2RItem): RecallItem {
  const hint = hintFromNote(item)
  return {
    id:       item.id,
    question: hint || item.title,
    hint:     hint && hint !== item.title ? item.title : '',
    answer:   '',
    kind:     'concept',
    tags:     item.tags,
    problems: item.problems,
    points:   [item.id],
    links:    item.links,
    format:   'md',
    updated:  item.updated,
    source:   'p2r',
  }
}

export function mergeRecallDeck(p2rItems: P2RItem[], extra: RecallItem[]): RecallItem[] {
  const fromNotes = p2rItems.map(p2rToRecallCard)
  const taken = new Set(fromNotes.map(c => c.id))
  const extras = extra.filter(c => !taken.has(c.id))
  return [...fromNotes, ...extras]
}
