import type { AnkiNote, AnkiTemplate } from '../adapters/ankiRepo'

export interface CardSection {
  key:   string
  label: string
  type:  string
  value: string
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function getCardSections(note: AnkiNote, tmpl: AnkiTemplate): {
  front: CardSection[]
  back:  CardSection[]
} {
  const sorted = [...tmpl.fields].sort((a, b) => a.order - b.order)
  const front = sorted
    .filter(f => f.isFront)
    .map(f => ({ key: f.key, label: f.label, type: f.type, value: note.fields[f.key] ?? '' }))
  const back = sorted
    .filter(f => f.isBack && !f.isFront)
    .map(f => ({ key: f.key, label: f.label, type: f.type, value: note.fields[f.key] ?? '' }))
  return { front, back }
}

export function getCardFrontHtml(note: AnkiNote, tmpl: AnkiTemplate): string {
  const frontFields = tmpl.fields
    .filter(f => f.isFront)
    .sort((a, b) => a.order - b.order)

  const parts: string[] = []
  for (const f of frontFields) {
    const val = note.fields[f.key]
    if (!val) continue
    parts.push(val)
  }

  if (parts.length === 0) {
    const firstField = [...tmpl.fields].sort((a, b) => a.order - b.order)[0]
    if (firstField) {
      const val = note.fields[firstField.key]
      if (val) return val
    }
    return ''
  }

  return parts.join('<hr style="margin:8px 0">')
}

export function getCardBackHtml(note: AnkiNote, tmpl: AnkiTemplate): string {
  const backFields = tmpl.fields
    .filter(f => f.isBack && !f.isFront)
    .sort((a, b) => a.order - b.order)

  const parts: string[] = []
  for (const f of backFields) {
    const val = note.fields[f.key]
    if (!val) continue
    parts.push(val)
  }

  return parts.join('<hr style="margin:8px 0">')
}

export function getCardFrontText(note: AnkiNote, tmpl: AnkiTemplate): string {
  return stripHtml(getCardFrontHtml(note, tmpl))
}

export function getCardTags(note: AnkiNote): string[] {
  return note.tags
}

export function getCardDeck(note: AnkiNote): string {
  return note.deck
}
