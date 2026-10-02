// Notes capture — the three AI passes that turn something spoken into a page
// in the open note's section → page tree.
//
//   1. cleanSpoken()  removes the noise of speech, keeps the words. The result
//                     is stored as the capture's raw text BEFORE anything else
//                     runs, so the later passes can fail without losing it.
//   2. fileNote()     picks where it goes: a section path (existing sections
//                     reused, missing ones created) and a page — new, or an
//                     existing page to append to. Small strict JSON.
//   3. renderNote()   writes the page body in the notes format: headings,
//                     bullets, highlights, callouts, flows.
//
// Split for the same reason as thoughtGen: HTML inside a JSON string escapes
// badly and truncates the whole payload when it runs long.

import { LLM } from './llm'
import { parseLooseJson } from './looseJson'
import { CARD_VOCAB } from './thoughtGen'
import type { NoteNode } from '../adapters/notesRepo'

// Sections nest without limit in the UI; the model is held to a shallow path
// so filing stays browsable.
export const MAX_SECTION_DEPTH = 3

// Conservative on purpose: this is the text kept as the record of what was
// said. Same words, same order — only fillers, stutters and repeats go.
const CLEAN_PROMPT = `You tidy a person's raw dictated or typed note.

Return ONLY the cleaned text. No preamble, no quotes, no code fence.

- Remove filler words (ah, uh, um, erm, like, you know, I mean, sort of, basically, so yeah).
- Remove stutters and accidental repetition ("the the cache" → "the cache",
  "I think I think we" → "I think we").
- Fix grammar and obvious speech-to-text errors ONLY where the intent is
  unmistakable (e.g. "cash invalidation" → "cache invalidation" when the
  sentence is clearly about caching).
- Add sentence breaks, punctuation and capitalisation so it reads as proper sentences.
- KEEP the person's own words, their order, and their voice — the same way it
  was spoken. Do NOT summarise, reorder, bullet, add headings, or add anything
  they did not say.
- If the text is already clean, return it unchanged.`

export async function cleanSpoken(raw: string): Promise<string> {
  if (!LLM.isConfigured()) return raw
  const reply = await LLM.chat([
    { role: 'system', content: CLEAN_PROMPT },
    { role: 'user',   content: raw },
  ], 4000)
  // A refusal or an empty reply must never blank the capture.
  return stripFence(reply) || raw
}

export interface NoteFiling {
  sections:   string[]   // section titles from the root down; [] = top level
  page:       string     // page title (new page) — ignored when appending
  appendToId: string     // existing page id to append to, or ''
}

// Indented outline of the note so the model can see — and reuse — what is
// there. Ids ride along so an append target is unambiguous.
function outline(nodes: NoteNode[]): string {
  const kids = new Map<string, NoteNode[]>()
  for (const n of nodes) {
    const l = kids.get(n.parentId) ?? []
    l.push(n); kids.set(n.parentId, l)
  }
  const lines: string[] = []
  const walk = (pid: string, depth: number) => {
    for (const n of (kids.get(pid) ?? []).sort((a, b) => a.position - b.position)) {
      lines.push(`${'  '.repeat(depth)}[${n.kind} ${n.id}] ${n.title}`)
      walk(n.id, depth + 1)
    }
  }
  walk('', 0)
  return lines.join('\n')
}

function filePrompt(noteName: string, nodes: NoteNode[]): string {
  const tree = outline(nodes)
  return `You file a person's note into their notebook "${noteName}".
The notebook is a tree of sections (folders) holding pages.

Return ONLY a JSON object, no prose, no code fence:
{"sections":["Section","Sub-section"],"page":"Page Title","appendToId":""}

**sections** — the section path from the top level down, Title Case,
AT MOST ${MAX_SECTION_DEPTH} levels (1-2 is usual). REUSE existing section titles
exactly as written when the note belongs there; only add a new section when
nothing fits. [] puts the page at the top level.

**page** — a short Title Case title naming what the note is about.

**appendToId** — the id of an EXISTING page when the note clearly continues
that same page's topic; otherwise "". Only ids that appear below are valid.

${tree
  ? `Current tree ([kind id] title, indented by nesting):\n${tree}`
  : 'The notebook is empty — start a sensible first section.'}`
}

export async function fileNote(
  cleaned: string, noteName: string, nodes: NoteNode[],
): Promise<NoteFiling | null> {
  if (!LLM.isConfigured()) return null
  const reply = await LLM.chat([
    { role: 'system', content: filePrompt(noteName, nodes) },
    { role: 'user',   content: cleaned },
  ], 800)
  const p = parseLooseJson(reply) as {
    sections?: unknown; page?: string; appendToId?: string
  } | null
  if (!p) return null
  const appendToId = String(p.appendToId ?? '').trim()
  return {
    sections: Array.isArray(p.sections)
      ? p.sections.map(s => String(s).trim()).filter(Boolean).slice(0, MAX_SECTION_DEPTH)
      : [],
    page:     String(p.page ?? '').trim().slice(0, 120),
    // A hallucinated id is treated as "make a new page", never an error.
    appendToId: nodes.some(n => n.id === appendToId && n.kind === 'page') ? appendToId : '',
  }
}

const RENDER_PROMPT = `You turn a person's spoken note into a well-structured notebook page in HTML.

Return ONLY an HTML fragment. No markdown, no code fence, no <html>/<body>.

${CARD_VOCAB}

Rules:
- Organise the content as notes: <h3>/<h4> headings for each topic, short
  bullets, <strong> for the load-bearing words, th-hl for the one or two
  phrases that matter most.
- Use th-steps, th-flow or th-cycle whenever the note describes a process,
  sequence or loop; th-callout warn for pitfalls, good for what works; a table
  when it compares things.
- Keep everything that was said — restructure it, do not drop points.
- Never invent content. Everything must come from the note itself.
- No inline style attributes, no colours of your own — the classes carry the styling.`

export async function renderNote(cleaned: string, title: string, appending: boolean): Promise<string> {
  if (!LLM.isConfigured()) return ''
  const lead = appending
    ? `This continues the existing page "${title}". Do not repeat the page title; lead with an <h3> naming this addition.`
    : `This is the new page "${title}". Do not repeat the page title; go straight into the substance.`
  const reply = await LLM.chat([
    { role: 'system', content: `${RENDER_PROMPT}\n- ${lead}` },
    { role: 'user',   content: cleaned },
  ], 4000)
  return stripFence(reply)
}

// Models still fence output now and again despite being told not to.
function stripFence(s: string): string {
  const t = (s ?? '').trim()
  const m = t.match(/^```(?:html|text)?\s*([\s\S]*?)\s*```$/i)
  return (m ? m[1] : t).trim()
}
