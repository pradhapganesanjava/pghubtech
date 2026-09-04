// Journal processing.
//
//   extractJournal()  cleans a dictated day and pulls out its shape: wake and
//                     sleep, a timeline banded by time of day, and the day's
//                     reflection (right / wrong, expected vs reality, what is
//                     being fixed, what worked).
//   generateInsights() reads many days at once, on demand, and reports the
//                     patterns — what keeps failing, the 1% change that would
//                     move it, and strategies that worked and were dropped.
//
// The clean-up is the same conservative contract as Thoughts: the words stay
// the writer's, only the noise of speech goes.

import { LLM } from './llm'
import { parseLooseJson } from './looseJson'
import { bandForHour, dartConfig } from '../adapters/dartRepo'
import type { BandKey, JournalEntry, JournalFields, TimelineItem } from '../adapters/dartRepo'

const bandSpec = () => dartConfig().dayBands
  .map(b => `  ${b.key} = ${b.label} (${b.hint})`).join('\n')

// Built per call: the bands are sheet data and can change between calls.
const extractPrompt = () => `You turn a person's spoken account of their day into structured JSON.

Return ONLY a JSON object, no prose, no code fence:
{
  "cleaned": "...",
  "wakeTime": "HH:MM", "sleepTime": "HH:MM",
  "timeline": [{"band":"morning","from":"09:00","to":"11:30","minutes":150,"title":"...","detail":"..."}],
  "wentRight": ["..."], "wentWrong": ["..."],
  "expected": "...", "reality": "...",
  "fixing": ["..."], "worked": ["..."],
  "summary": "..."
}

**cleaned** — the same account, made readable:
- Remove filler words (ah, uh, um, erm, like, you know, I mean, sort of, basically).
- Remove stutters and accidental repetition, and words that carry no meaning.
- Fix grammar and obvious speech-to-text errors ONLY where the intent is plain.
- KEEP their words, their order, their voice. Do NOT summarise, reorder or
  restructure. It stays flowing prose.

**wakeTime / sleepTime** — 24h "HH:MM" if stated or clearly implied, else "".

**timeline** — one entry per distinct activity mentioned. band is one of:
${bandSpec()}
- "from"/"to" are "HH:MM" when a time was given, otherwise "".
- "minutes" is the duration if stated or derivable from from/to, else 0.
- Pick the band from the stated time. With no time, pick the band the account
  implies from its order and wording; never invent a clock time to justify it.
- "title" is short (max 60 chars). "detail" may be empty.
- Only activities they actually mention. Do not pad the day.

**wentRight / wentWrong** — short concrete points, their own framing.
**expected** — what they meant the day to be. **reality** — what it turned out
to be. Both "" if they did not say.
**fixing** — habits or tasks they are trying to fix or keep struggling with.
**worked** — a habit, tactic or strategy that actually paid off today.
Phrase fixing/worked items the SAME way each time they recur, so the same
struggle reads as one recurring item across days rather than many near-misses.

**summary** — one line, max 90 characters, recognisable in a list.

Never invent anything absent from the account. Empty string or empty list is
the correct answer when something was not mentioned.`

const validBands = () => new Set(dartConfig().dayBands.map(b => b.key))

function hhmm(v: unknown): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim())
  if (!m) return ''
  const h = Number(m[1]), min = Number(m[2])
  if (h > 23 || min > 59) return ''
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

function strList(v: unknown, cap = 10): string[] {
  return Array.isArray(v)
    ? v.map(x => String(x).trim()).filter(Boolean).slice(0, cap)
    : []
}

function minutesBetween(from: string, to: string): number {
  if (!from || !to) return 0
  const [fh, fm] = from.split(':').map(Number)
  const [th, tm] = to.split(':').map(Number)
  let d = (th * 60 + tm) - (fh * 60 + fm)
  if (d < 0) d += 24 * 60          // ran past midnight
  return d
}

function toTimeline(v: unknown): TimelineItem[] {
  if (!Array.isArray(v)) return []
  return v.map(raw => {
    const o = (raw ?? {}) as Record<string, unknown>
    const from = hhmm(o.from), to = hhmm(o.to)
    // A stated clock time always wins over the model's own band choice.
    const ok = validBands()
    const fallback = dartConfig().dayBands[1]?.key ?? dartConfig().dayBands[0]?.key ?? 'morning'
    const band: BandKey = from
      ? bandForHour(Number(from.slice(0, 2)))
      : ok.has(String(o.band)) ? String(o.band) : fallback
    const stated = Number(o.minutes)
    return {
      band, from, to,
      minutes: Number.isFinite(stated) && stated > 0 ? Math.round(stated) : minutesBetween(from, to),
      title:  String(o.title ?? '').trim().slice(0, 80),
      detail: String(o.detail ?? '').trim(),
    }
  }).filter(t => t.title)
}

export async function extractJournal(raw: string, date: string): Promise<JournalFields | null> {
  if (!LLM.isConfigured()) return null
  const reply = await LLM.chat([
    { role: 'system', content: extractPrompt() },
    { role: 'user',   content: raw },
  ], 3000)
  const p = parseLooseJson(reply) as Record<string, unknown> | null
  if (!p) return null

  const cleaned = String(p.cleaned ?? '').trim() || raw
  return {
    date, raw: cleaned, rawOriginal: raw,
    wakeTime:  hhmm(p.wakeTime),
    sleepTime: hhmm(p.sleepTime),
    timeline:  toTimeline(p.timeline),
    wentRight: strList(p.wentRight),
    wentWrong: strList(p.wentWrong),
    expected:  String(p.expected ?? '').trim(),
    reality:   String(p.reality ?? '').trim(),
    fixing:    strList(p.fixing),
    worked:    strList(p.worked),
    summary:   String(p.summary ?? '').trim().slice(0, 200)
               || cleaned.split('\n')[0].slice(0, 90),
  }
}

// Fallback when there is no AI: the day is still stored, just unstructured.
export function bareJournal(raw: string, date: string): JournalFields {
  return {
    date, raw, rawOriginal: raw, wakeTime: '', sleepTime: '', timeline: [],
    wentRight: [], wentWrong: [], expected: '', reality: '',
    fixing: [], worked: [],
    summary: raw.split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 90) ?? '',
  }
}

// ── Insights ─────────────────────────────────────────────────────────────────

const INSIGHT_PROMPT = `You review a stretch of someone's daily journal and report the patterns.

Return ONLY an HTML fragment. No markdown, no code fence, no <html>/<body>.

Use ONLY these tags:
  h3 h4 p ul ol li strong em br div span table thead tbody tr th td

Use ONLY these classes:
  <span class="th-hl">…</span>          a phrase that matters
  <span class="th-key">…</span>         a named habit or strategy
  <div class="th-callout">…</div>       a point worth boxing out
  <div class="th-callout good">…</div>  something working — keep it
  <div class="th-callout warn">…</div>  a recurring failure
  <div class="th-steps">
    <div class="th-step"><span class="th-step-n">1</span><div class="th-step-b">…</div></div>
  </div>
  <div class="th-grid"><div class="th-card"><h4>…</h4>…</div></div>

Cover these, in this order, each under its own <h3>:

1. **What keeps failing** — only things that recur across MULTIPLE days. Say how
   many days out of how many, from the entries given. Never call a one-off a pattern.
2. **The 1% fix** — for each recurring failure, ONE change small enough to do
   tomorrow. Not a resolution: a specific, tiny, mechanical change. Use th-steps.
3. **Worked, then dropped** — strategies or habits the entries show working on
   some days and then disappearing. Name the last day each appeared. This is the
   most valuable section: say plainly what to bring back.
4. **Holding steady** — what is genuinely working. Keep it short.
5. **Expected vs reality** — where the gap between the two is widest, and what
   the entries suggest is causing it.

Rules:
- Ground every claim in the entries. Quote their own wording for a habit.
- Count days honestly; if the window is thin, say the evidence is thin.
- No inline styles. No advice that is not traceable to something they wrote.`

export interface InsightInput {
  from:    string
  to:      string
  entries: JournalEntry[]
}

// Entries are compacted before sending: full prose for many days would crowd
// out the patterns, and the structured fields are the part being analysed.
function digest(entries: JournalEntry[]): string {
  return entries
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(e => {
      const bits = [`## ${e.date}`]
      if (e.wakeTime || e.sleepTime) bits.push(`wake ${e.wakeTime || '?'} · sleep ${e.sleepTime || '?'}`)
      if (e.summary) bits.push(`summary: ${e.summary}`)
      if (e.timeline.length) {
        bits.push('timeline: ' + e.timeline
          .map(t => `${t.band}${t.from ? ` ${t.from}` : ''} ${t.title}${t.minutes ? ` (${t.minutes}m)` : ''}`)
          .join('; '))
      }
      if (e.wentRight.length) bits.push('went right: ' + e.wentRight.join(' | '))
      if (e.wentWrong.length) bits.push('went wrong: ' + e.wentWrong.join(' | '))
      if (e.expected) bits.push(`expected: ${e.expected}`)
      if (e.reality)  bits.push(`reality: ${e.reality}`)
      if (e.fixing.length) bits.push('trying to fix: ' + e.fixing.join(' | '))
      if (e.worked.length) bits.push('worked: ' + e.worked.join(' | '))
      return bits.join('\n')
    })
    .join('\n\n')
}

export async function generateInsights(input: InsightInput): Promise<string> {
  if (!LLM.isConfigured()) throw new Error('Azure OpenAI is not configured — add the key in Settings.')
  if (input.entries.length === 0) throw new Error('No journal entries in that window.')
  const reply = await LLM.chat([
    { role: 'system', content: INSIGHT_PROMPT },
    { role: 'user', content:
      `Window ${input.from} → ${input.to}, ${input.entries.length} entries.\n\n${digest(input.entries)}` },
  ], 4000)
  const t = reply.trim()
  const m = t.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i)
  return (m ? m[1] : t).trim()
}

// Rolled up across every entry, for the "what am I always fixing" view.
export interface Consolidated { text: string; days: string[] }

export function consolidate(entries: JournalEntry[], pick: (e: JournalEntry) => string[]): Consolidated[] {
  const m = new Map<string, Consolidated>()
  for (const e of entries) {
    for (const raw of pick(e)) {
      // Normalised only for grouping; the first spelling seen is what shows.
      const key = raw.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
      if (!key) continue
      const hit = m.get(key)
      if (hit) { if (!hit.days.includes(e.date)) hit.days.push(e.date) }
      else m.set(key, { text: raw, days: [e.date] })
    }
  }
  return [...m.values()].sort((a, b) => b.days.length - a.days.length)
}
