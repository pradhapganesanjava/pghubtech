// Ask the LLM to extract a small set of high-value Q&A cards from an AI
// conversation. The model returns strict JSON; we parse it (tolerating
// truncation / fences) and return a flat list the UI can preview, edit,
// and save.

import { LLM } from './llm'

export interface AnkiCardDraft {
  question: string
  answer:   string
  tags:     string[]
}

const SYSTEM_PROMPT = [
  `You convert AI chat conversations into ANKI-style Q&A flashcards for spaced-repetition study.`,
  `Output STRICT JSON ONLY — no prose, no markdown fences, no commentary. First character "{", last character "}".`,
  ``,
  `Schema:`,
  `{`,
  `  "cards": [`,
  `    {`,
  `      "question": "concise, self-contained question — should make sense without the original chat",`,
  `      "answer":   "the answer in 1-3 sentences. May include short code snippets when essential, fenced with \\\`\\\`\\\`",`,
  `      "tags":     ["snake_case_topic", "tech::subtopic"]   // 1-4 tags; use "::" for hierarchy when natural`,
  `    }`,
  `  ]`,
  `}`,
  ``,
  `Rules:`,
  `1. Output JSON only. No \`\`\` fences around the whole object.`,
  `2. Generate 3-8 cards total. Prefer fewer high-quality cards over many shallow ones.`,
  `3. Each card must be FULLY self-contained — a reader who has not seen the chat must understand both the question and the answer.`,
  `4. Frame questions to test understanding ("Why is X used in Y?", "How does X differ from Y?") rather than trivia ("What is X?").`,
  `5. Tags should describe the SUBJECT (e.g. "protocols", "ai::mcp", "javascript::async"), not the source. Use lowercase, snake_case, "::" for hierarchy.`,
  `6. Skip pleasantries, off-topic side conversations, and anything that wouldn't be useful to revisit later.`,
  `7. If no card-worthy content exists, return {"cards": []}.`,
].join('\n')

export async function generateAnkiCardsFromConversation(
  msgs: { role: 'user' | 'assistant'; content: string }[],
  maxTokens = 3000,
): Promise<AnkiCardDraft[]> {
  if (msgs.length === 0) return []
  const transcript = msgs
    .map(m => `${m.role === 'user' ? 'USER' : 'AI'}: ${m.content}`)
    .join('\n\n---\n\n')
  const reply = await LLM.chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: transcript },
  ], maxTokens)
  const parsed = parse(reply)
  if (!parsed || !Array.isArray(parsed.cards)) return []
  return parsed.cards
    .map((c: any) => normalizeCard(c))
    .filter((c): c is AnkiCardDraft => c != null)
}

function normalizeCard(c: any): AnkiCardDraft | null {
  if (!c || typeof c !== 'object') return null
  const question = typeof c.question === 'string' ? c.question.trim() : ''
  const answer   = typeof c.answer   === 'string' ? c.answer.trim()   : ''
  if (!question || !answer) return null
  const tags = Array.isArray(c.tags)
    ? c.tags.filter((t: any) => typeof t === 'string' && t.trim()).map((t: string) => t.trim())
    : []
  return { question, answer, tags }
}

function parse(s: string): { cards?: any[] } | null {
  const t = s.trim()
  try { return JSON.parse(t) } catch { /* fall through */ }
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i)
  if (fence) { try { return JSON.parse(fence[1]) } catch { /* */ } }
  const start = t.indexOf('{'), end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) } catch { /* */ }
  }
  // Truncation repair — close any unclosed brackets at the end.
  if (start >= 0) {
    const slice = t.slice(start)
    let braces = 0, brackets = 0, inStr = false, esc = false, lastSafe = 0
    for (let i = 0; i < slice.length; i++) {
      const c = slice[i]
      if (esc) { esc = false; continue }
      if (inStr) {
        if (c === '\\') esc = true
        else if (c === '"') { inStr = false; lastSafe = i + 1 }
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') braces++
      else if (c === '}') { braces--; lastSafe = i + 1 }
      else if (c === '[') brackets++
      else if (c === ']') { brackets--; lastSafe = i + 1 }
    }
    let cand = (inStr ? slice.slice(0, lastSafe) : slice).replace(/[\s,]+$/, '')
    braces = 0; brackets = 0; inStr = false; esc = false
    for (let i = 0; i < cand.length; i++) {
      const c = cand[i]
      if (esc) { esc = false; continue }
      if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === '{') braces++
      else if (c === '}') braces--
      else if (c === '[') brackets++
      else if (c === ']') brackets--
    }
    if (!inStr && braces >= 0 && brackets >= 0) {
      const closed = cand + ']'.repeat(brackets) + '}'.repeat(braces)
      try { return JSON.parse(closed) } catch { /* */ }
    }
  }
  return null
}
