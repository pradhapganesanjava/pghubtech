// Thought processing — the two AI passes that turn a raw brain-dump into
// something worth re-reading weeks later.
//
//   1. refineThought()  cleans the capture, classifies it, and files it in the
//                       tree. Small, strict JSON — reliable to parse.
//   2. renderThought()  turns the cleaned text into rich HTML: headings,
//                       bullets, highlights, callouts, flow diagrams.
//
// Two calls rather than one: rich HTML embedded inside a JSON string escapes
// badly and truncates the whole payload when it runs long. Split, a failed
// render still leaves a correctly filed, cleaned thought.

import { LLM } from './llm'
import { parseLooseJson } from './looseJson'
import { MAX_PATH_DEPTH, THOUGHT_BUCKETS, normalisePath } from '../adapters/dartRepo'
import type { ThoughtBucket } from '../adapters/dartRepo'

export interface RefinedThought {
  cleaned:    string
  bucket:     ThoughtBucket
  path:       string
  summary:    string
  highlights: string[]
}

// The clean-up is deliberately conservative: this replaces the stored text, so
// anything it invents or drops is a change to the record. Same words, same
// order, same structure — only the noise of speech removed.
function refinePrompt(existingPaths: string[]): string {
  return `You tidy a person's raw captured thought and file it.

Return ONLY a JSON object, no prose, no code fence:
{"cleaned":"...","bucket":"...","path":"A::B","summary":"...","highlights":["...","..."]}

**cleaned** — the SAME thought, spoken or typed, made readable:
- Remove filler words (ah, uh, um, erm, like, you know, I mean, sort of, basically).
- Remove stutters and accidental repetition ("I learned about I learned about" → "I learned about").
- Fix grammar, verb agreement, and obvious speech-to-text errors ONLY where the
  intent is unmistakable (e.g. "under space reputation" → "spaced repetition",
  "confession" → "confusion" where the sentence is clearly about confusion).
- Add sentence breaks and capitalisation so it reads as sentences.
- KEEP the person's own words, their order, and their voice. Do NOT summarise,
  reorder, restructure, bullet, add headings, or add anything they did not say.
- Do NOT reformat into lists. It stays flowing prose, exactly as delivered.
- If the text is already clean, return it unchanged.

**bucket** — exactly one of: ${THOUGHT_BUCKETS.join(', ')}. Use "Other" only when
nothing fits.

**path** — where this belongs in a topic tree, "::"-delimited, Title Case,
AT MOST ${MAX_PATH_DEPTH} levels (fewer is better; 2–3 is usual).
${existingPaths.length > 0
  ? `Reuse one of these existing paths when the thought belongs with them — extend
one with a new leaf rather than inventing a parallel branch:
${existingPaths.map(p => `  ${p}`).join('\n')}`
  : 'There are no existing paths yet; create a sensible top-level group.'}
Only start a new top-level group when the thought genuinely does not fit any above.

**summary** — one line, max 90 characters, in their own words, recognisable in a list.

**highlights** — 2–5 short concrete points actually present in the text. Never invent.`
}

export async function refineThought(
  raw: string, existingPaths: string[],
): Promise<RefinedThought | null> {
  if (!LLM.isConfigured()) return null
  const reply = await LLM.chat([
    { role: 'system', content: refinePrompt(existingPaths) },
    { role: 'user',   content: raw },
  ], 2000)
  const p = parseLooseJson(reply) as {
    cleaned?: string; bucket?: string; path?: string
    summary?: string; highlights?: unknown
  } | null
  if (!p) return null

  const bucket = (THOUGHT_BUCKETS as readonly string[]).includes(p.bucket ?? '')
    ? p.bucket as ThoughtBucket
    : 'Other'
  return {
    // A refusal or an empty field must never blank the user's capture.
    cleaned:    (p.cleaned ?? '').trim() || raw,
    bucket,
    path:       normalisePath(p.path ?? '') || 'Unfiled',
    summary:    (p.summary ?? '').trim().slice(0, 200),
    highlights: Array.isArray(p.highlights)
      ? p.highlights.map(h => String(h).trim()).filter(Boolean).slice(0, 8)
      : [],
  }
}

// The class vocabulary below is styled in App.css and is theme-aware. Letting
// the model pick from a fixed set beats free-form inline styles: the output
// stays consistent, readable in every theme, and safe through the sanitiser
// (which strips style/script but keeps class).
const RENDER_PROMPT = `You turn a person's thought into a compact, visual study card in HTML.

Return ONLY an HTML fragment. No markdown, no code fence, no <html>/<body>.

Use ONLY these tags:
  h3 h4 p ul ol li strong em br div span table thead tbody tr th td blockquote

Use ONLY these classes, exactly as named:
  <span class="th-hl">…</span>          highlight a crucial phrase (use sparingly)
  <span class="th-key">…</span>         a named concept or term
  <div class="th-callout">…</div>       a point worth boxing out
  <div class="th-callout good">…</div>  something that works / do this
  <div class="th-callout warn">…</div>  a trap / what goes wrong
  <div class="th-steps">                an ordered process
    <div class="th-step"><span class="th-step-n">1</span><div class="th-step-b">…</div></div>
  </div>
  <div class="th-flow">                 a left-to-right flow
    <div class="th-flow-step">…</div><div class="th-flow-arrow">→</div><div class="th-flow-step">…</div>
  </div>
  <div class="th-cycle">                a repeating loop (last item returns to first)
    <div class="th-flow-step">…</div><div class="th-flow-arrow">→</div><div class="th-flow-step">…</div>
  </div>
  <div class="th-grid"><div class="th-card"><h4>…</h4>…</div></div>   side-by-side points

Rules:
- Lead with an <h3> naming the idea, then the substance. No preamble.
- Structure it so the whole thing is graspable in about fifteen seconds:
  headings, short bullets, bold for the load-bearing words.
- Include a th-steps, th-flow or th-cycle whenever the thought describes a
  process, sequence or loop — that is the fastest thing to recall from.
- Never invent content. Everything must come from the thought itself.
- No inline style attributes, no colours of your own — the classes carry the styling.
- Keep it tight: this is a recall aid, not an essay.`

export async function renderThought(cleaned: string): Promise<string> {
  if (!LLM.isConfigured()) return ''
  const reply = await LLM.chat([
    { role: 'system', content: RENDER_PROMPT },
    { role: 'user',   content: cleaned },
  ], 3000)
  return stripFence(reply)
}

// Models still fence HTML now and again despite being told not to.
function stripFence(s: string): string {
  const t = (s ?? '').trim()
  const m = t.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i)
  return (m ? m[1] : t).trim()
}
