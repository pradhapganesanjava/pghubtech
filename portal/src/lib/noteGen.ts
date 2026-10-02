// Notes capture — the AI passes that turn something spoken into pages in the
// open note's section → page tree.
//
//   1. cleanSpoken()  removes the noise of speech, keeps the words. The result
//                     is stored as the capture's raw text BEFORE anything else
//                     runs, so the later passes can fail without losing it.
//   2. planNote()     splits the talk by topic and returns a JSON plan of tree
//                     operations (create / append / move / rename) against the
//                     current tree. lib/notePlan.ts validates and applies it.
//   3. renderNote()   writes each segment's page body in the notes format:
//                     headings, bullets, highlights, callouts, flows.
//
// Plan and render are split for the same reason as thoughtGen: HTML inside a JSON string escapes
// badly and truncates the whole payload when it runs long.

import { LLM } from './llm'
import { parseLooseJson } from './looseJson'
import { CARD_VOCAB } from './thoughtGen'
import type { NoteNode } from '../adapters/notesRepo'
import { parseBlocks, renderBlocksAsHtml } from '../components/PageBlocksEditor'

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

// ── Planning ────────────────────────────────────────────────────────────────
//
// The model never touches the Sheet. It reads the current tree and returns a
// plan — the talk split into segments, plus a list of operations — and
// lib/notePlan.ts validates and applies it.

export const MAX_TREE_DEPTH = 5   // root section … page, counted in levels

export interface PlanSegment { key: string; text: string }

export type PlanOp =
  | { op: 'section'; ref: string; parent: string; title: string }
  | { op: 'page';    ref: string; parent: string; title: string; segment: string }
  | { op: 'append';  target: string; segment: string }
  | { op: 'move';    node: string; parent: string }
  | { op: 'rename';  node: string; title: string }

export interface NotePlan { segments: PlanSegment[]; ops: PlanOp[] }

function plainText(content: string): string {
  return renderBlocksAsHtml(parseBlocks(content))
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

// Indented outline of the note, ids and kinds inline, with a short excerpt of
// each page so the model can tell "continues this page" from "new subtopic".
function outline(nodes: NoteNode[]): string {
  const kids = new Map<string, NoteNode[]>()
  for (const n of nodes) {
    const l = kids.get(n.parentId) ?? []
    l.push(n); kids.set(n.parentId, l)
  }
  const lines: string[] = []
  const walk = (pid: string, depth: number) => {
    for (const n of (kids.get(pid) ?? []).sort((a, b) => a.position - b.position)) {
      const pad = '  '.repeat(depth)
      lines.push(`${pad}[${n.kind} ${n.id}] ${n.title}`)
      if (n.kind === 'page') {
        const ex = plainText(n.content).slice(0, 160)
        if (ex) lines.push(`${pad}    “${ex}${ex.length === 160 ? '…' : ''}”`)
      }
      walk(n.id, depth + 1)
    }
  }
  walk('', 0)
  return lines.join('\n')
}

function planPrompt(noteName: string, nodes: NoteNode[]): string {
  const tree = outline(nodes)
  return `You are the librarian of a personal notebook called "${noteName}".
It is a tree: SECTIONS are folders; PAGES hold content. A section can hold
sections and pages; a page can hold only sub-pages.

The person just spoke a note. It can be about anything — system design,
technical topics, maths, psychology, study tips, experiences, lessons learned
from experience, beliefs, assumptions, points to remember, slogans,
affirmations — and ONE talk often covers SEVERAL unrelated topics. Your job:
split it by topic and file every part where it belongs, restructuring the
tree when that makes it cleaner.

Return ONLY a JSON object, no prose, no code fence:
{
  "segments": [ {"key":"a","text":"..."} ],
  "ops": [
    {"op":"section","ref":"s1","parent":"ROOT","title":"System Design"},
    {"op":"section","ref":"s2","parent":"s1","title":"Caching"},
    {"op":"page","ref":"p1","parent":"s2","title":"Caching Decisions","segment":"a"},
    {"op":"append","target":"<existing page id>","segment":"b"},
    {"op":"move","node":"<existing id>","parent":"<section id | ref | ROOT>"},
    {"op":"rename","node":"<existing id | ref>","title":"..."}
  ]
}

SEGMENTS
- Split the talk into one segment per distinct topic. Copy the person's
  sentences into "text" — do not summarise or reword. Every sentence goes in
  exactly one segment. One topic → one segment.

HIERARCHY — build top-down, broad to specific
- Level 1 is a broad ROOT DOMAIN (e.g. System Design, Technical, Mathematics,
  Psychology, Study Tips, Experiences, Lessons Learned, Beliefs, Assumptions,
  Points To Remember, Slogans, Affirmations). Then topic → subtopic → page.
- At most ${MAX_TREE_DEPTH} levels including the page. Title Case, short titles.
- REUSE an existing root/section when the topic belongs there, using its id as
  "parent" — never create a duplicate or near-duplicate (match by meaning, not
  just spelling). Create a new root or a new branch only when nothing fits.
  A new topic beside an existing one becomes its SIBLING under the same parent.

PAGES — new, append, or restructure
- A topic with no page yet → "page" op under the right section.
- More on exactly the same subtopic as an existing page → "append" to it.
- A different angle on an existing page's topic → PROMOTE the topic: create a
  section titled after that topic under the page's parent, "move" the existing
  page into it, "rename" that page to its specific angle, and add the new
  content as a sibling "page". Example: System Design › Caching has a page
  "Decision Making"; a new talk adds another caching-decision point →
  section "Decision Making" under Caching, move the old page into it and
  rename it (e.g. "Read-Heavy Workloads"), new page beside it.
- Never delete anything. Never move a section under a page.

REFERENCES
- "parent"/"target"/"node" take an existing id from the tree, a "ref" made by
  an EARLIER op in this list, or "ROOT" for the top level.
- Every segment is used by exactly one "page" or "append" op.

${tree
  ? `Current tree ([kind id] title; pages show a content excerpt):\n${tree}`
  : 'The notebook is empty — start the right root domains.'}`
}

export async function planNote(
  cleaned: string, noteName: string, nodes: NoteNode[],
): Promise<NotePlan | null> {
  if (!LLM.isConfigured()) return null
  const reply = await LLM.chat([
    { role: 'system', content: planPrompt(noteName, nodes) },
    { role: 'user',   content: cleaned },
  ], 6000)   // segments copy the talk back, so leave room
  const p = parseLooseJson(reply) as { segments?: unknown; ops?: unknown } | null
  if (!p || !Array.isArray(p.segments) || !Array.isArray(p.ops)) return null
  const segments = (p.segments as Record<string, unknown>[])
    .map(s => ({ key: String(s?.key ?? '').trim(), text: String(s?.text ?? '').trim() }))
    .filter(s => s.key && s.text)
  return { segments, ops: p.ops as PlanOp[] }
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
