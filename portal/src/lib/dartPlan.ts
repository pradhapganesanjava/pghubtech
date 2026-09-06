// DART scheduling — the pure half of the Today view.
//
// A goal carries a window, a frequency, and up to two targets: time (minutes)
// and work (a countable unit — problems, topics, chapters). Those are tracked
// as SEPARATE verticals and never averaged: "hours in but work short" and
// "work done in less time" call for opposite corrections, so a single blended
// percentage would hide the very thing worth seeing. A goal is behind if
// EITHER tracked vertical is behind.
//
// Everything here is a pure function of (goals, log, today) so the Today panel
// stays a renderer and the rules stay reviewable in one place.

import type { DartGoal, DartLogEntry } from '../adapters/dartRepo'

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function parseIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function daysBetween(from: string, to: string): number {
  const MS = 86400000
  return Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / MS)
}

// "1h40" / "40m" / "2h" / "0m" — matches how the user writes durations.
export function fmtMins(total: number): string {
  const n = Math.max(0, Math.round(total))
  if (n === 0) return '0m'
  const h = Math.floor(n / 60), m = n % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h${String(m).padStart(2, '0')}`
}

export function fmtUnits(n: number, label: string): string {
  const v = Math.round(n * 10) / 10
  const l = label || 'units'
  // "1 sub-topics" reads badly and these strings appear all over the UI.
  return `${v} ${v === 1 && l.endsWith('s') ? l.slice(0, -1) : l}`
}

export interface Period {
  start: string        // YYYY-MM-DD, inclusive
  end:   string        // YYYY-MM-DD, inclusive
  days:  number        // total days in the period
  label: string        // 'today' | 'this week' | 'this month' | 'by <date>'
}

// The window a goal's target is measured over. Weeks run Monday→Sunday.
// 'total' means the target covers the goal's whole start→end window rather
// than repeating — "24 hours by Sep 10", not "24 hours every week".
export function periodFor(g: DartGoal, todayIso: string): Period {
  const freq = g.frequency
  if (freq === 'total') {
    const start = g.startDate || todayIso
    // A total goal with no end date has no window to spread over, so it all
    // lands today rather than silently becoming unbounded.
    const end   = g.endDate || todayIso
    return {
      start, end,
      days:  Math.max(1, daysBetween(start, end) + 1),
      label: `by ${end}`,
    }
  }
  const t = parseIso(todayIso)
  if (freq === 'daily') {
    return { start: todayIso, end: todayIso, days: 1, label: 'today' }
  }
  if (freq === 'weekly') {
    const dow   = (t.getDay() + 6) % 7          // 0 = Monday
    const start = new Date(t); start.setDate(t.getDate() - dow)
    const end   = new Date(start); end.setDate(start.getDate() + 6)
    return { start: isoDate(start), end: isoDate(end), days: 7, label: 'this week' }
  }
  const start = new Date(t.getFullYear(), t.getMonth(), 1)
  const end   = new Date(t.getFullYear(), t.getMonth() + 1, 0)
  return {
    start: isoDate(start), end: isoDate(end),
    days: end.getDate(), label: 'this month',
  }
}

export function goalRunsOn(g: DartGoal, todayIso: string): boolean {
  if (!g.active) return false
  if (g.startDate && todayIso < g.startDate) return false
  if (g.endDate   && todayIso > g.endDate)   return false
  return true
}

export type TaskStatus = 'must' | 'could' | 'done'

// One vertical (time or work) of a goal, measured over the current period.
export interface GoalVertical {
  tracked:    boolean   // false when this goal sets no target on this vertical
  target:     number
  done:       number    // logged this period
  remaining:  number
  todayShare: number    // put this in today to stay on pace
  todayDone:  number
  behind:     boolean   // required pace has caught up with the even pace
}

export interface GoalTask {
  goal:     DartGoal
  period:   Period
  daysLeft: number      // today included; clipped by the goal's end date
  time:     GoalVertical
  work:     GoalVertical
  status:   TaskStatus
  why:      string      // one line explaining the status
}

// Days from today to the end of the period, inclusive, never past the goal's
// end date — a goal ending Thursday cannot spread its week over Friday–Sunday,
// so its remaining work compresses into the days it actually has left.
function daysLeftIn(p: Period, g: DartGoal, todayIso: string): number {
  const last = g.endDate && g.endDate < p.end ? g.endDate : p.end
  return Math.max(1, daysBetween(todayIso, last) + 1)
}

function vertical(
  target: number, done: number, todayDone: number, daysLeft: number, periodDays: number,
): GoalVertical {
  const tracked   = target > 0
  const remaining = Math.max(0, target - done)
  const share     = remaining === 0 ? 0 : Math.ceil(remaining / daysLeft)
  // Behind means the pace now required STRICTLY exceeds the pace the goal was
  // planned at. Sitting exactly on the even line — which is where every goal
  // starts on day one, with the whole window still ahead — is on pace, not
  // behind; treating it as behind would mark every goal must-do from the
  // moment it is created and flatten the must/could signal entirely. The
  // epsilon absorbs float noise so equality never tips over on rounding.
  const required = remaining / daysLeft
  const even     = target / periodDays
  return {
    tracked, target, done, remaining, todayShare: share, todayDone,
    behind: tracked && remaining > 0 && required > even * (1 + 1e-9),
  }
}

export function goalTask(g: DartGoal, log: DartLogEntry[], todayIso: string): GoalTask {
  const period = periodFor(g, todayIso)
  const mine   = log.filter(e => e.kind === 'goal' && e.refId === g.id)
  const inP    = mine.filter(e => e.date >= period.start && e.date <= period.end)
  const inD    = mine.filter(e => e.date === todayIso)
  const sum    = (rows: DartLogEntry[], f: (e: DartLogEntry) => number) =>
    rows.reduce((s, e) => s + f(e), 0)

  const daysLeft = daysLeftIn(period, g, todayIso)
  const time = vertical(
    g.targetMinutes, sum(inP, e => e.minutes), sum(inD, e => e.minutes), daysLeft, period.days)
  const work = vertical(
    g.targetUnits,   sum(inP, e => e.units),   sum(inD, e => e.units),   daysLeft, period.days)

  const tracked = [time, work].filter(v => v.tracked)
  const label   = g.unitLabel || 'units'

  let status: TaskStatus
  let why: string
  if (tracked.length > 0 && tracked.every(v => v.remaining === 0)) {
    status = 'done'
    why    = `target met ${period.label}`
  } else if (daysLeft <= 1) {
    status = 'must'
    const bits: string[] = []
    if (time.tracked && time.remaining > 0) bits.push(`${fmtMins(time.remaining)} left`)
    if (work.tracked && work.remaining > 0) bits.push(`${fmtUnits(work.remaining, label)} left`)
    why = period.label === 'today'
      ? `daily — ${bits.join(' · ') || 'due'}`
      : `last day (${period.label}) — ${bits.join(' · ') || 'due'}`
  } else if (g.priority === 'must') {
    status = 'must'
    why    = `marked must-do — ${daysLeft} days left`
  } else if (time.behind || work.behind) {
    status = 'must'
    // Name the vertical that is actually behind; if both are, say so — never
    // fold them into one number.
    const bits: string[] = []
    if (time.behind) bits.push(`${fmtMins(time.todayShare)}/day needed vs ${fmtMins(time.target / period.days)} planned`)
    if (work.behind) bits.push(`${fmtUnits(work.todayShare, label)}/day needed vs ${fmtUnits(work.target / period.days, label)} planned`)
    why = `behind on ${time.behind && work.behind ? 'both' : time.behind ? 'time' : 'work'} — ${bits.join(' · ')}`
  } else {
    status = 'could'
    const bits: string[] = []
    if (time.tracked && time.remaining > 0) bits.push(fmtMins(time.remaining))
    if (work.tracked && work.remaining > 0) bits.push(fmtUnits(work.remaining, label))
    why = `ahead of pace — ${bits.join(' · ')} left over ${daysLeft} days`
  }

  return { goal: g, period, daysLeft, time, work, status, why }
}

export function goalTasksFor(goals: DartGoal[], log: DartLogEntry[], todayIso: string): GoalTask[] {
  const order: Record<TaskStatus, number> = { must: 0, could: 1, done: 2 }
  return goals
    .filter(g => goalRunsOn(g, todayIso))
    .map(g => goalTask(g, log, todayIso))
    .sort((a, b) => order[a.status] - order[b.status] || a.goal.title.localeCompare(b.goal.title))
}

// Progress across the goal's whole start→end window, for the Goals tab.
export interface GoalWindow {
  totalMinutes: number
  totalUnits:   number
  daysToEnd:    number | null   // null when open-ended
  expired:      boolean
}

export function goalWindow(g: DartGoal, log: DartLogEntry[], todayIso: string): GoalWindow {
  const mine = log.filter(e => e.kind === 'goal' && e.refId === g.id)
  return {
    totalMinutes: mine.reduce((s, e) => s + e.minutes, 0),
    totalUnits:   mine.reduce((s, e) => s + e.units, 0),
    daysToEnd:    g.endDate ? daysBetween(todayIso, g.endDate) : null,
    expired:      !!g.endDate && g.endDate < todayIso,
  }
}

// ── Quick log: free text → the day's items ───────────────────────────────────
//
// One line of dictation ("meditate 15m, read 20 min, chased a prod bug 45m")
// becomes one entry per fragment. A fragment that names something the day
// already asks for is logged AGAINST that item; anything else is unplanned and
// lands on the date only, never becoming a routine.
//
// Deliberately local, not an LLM call: the whole value is that it is instant
// and predictable, and a wrong match here writes to your consistency grid.

export interface ParsedEffort {
  text:    string          // the fragment with its duration/count stripped
  minutes: number          // 0 when none stated
  units:   number          // 0 when none stated
}

// Spelled-out counts: dictation says "three hours", never "3 hours".
const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  couple: 2, few: 3, half: 0.5,
}
const NUMWORD = Object.keys(WORD_NUM).join('|')

// Rewrite "three hours" → "3 hours", "half an hour" → "30 min", "a couple of
// hours" → "2 hours", so the digit patterns below stay the single source of
// truth for durations.
function digitise(str: string): string {
  return str
    .replace(/\bhalf\s+an?\s+hour\b/gi, '30 min')
    .replace(/\ban?\s+couple\s+of\s+/gi, 'couple ')
    .replace(new RegExp(`\\b(${NUMWORD})\\s+(?:of\\s+)?(hours?|hrs?|minutes?|mins?)\\b`, 'gi'),
      (_m, w: string, unit: string) => `${WORD_NUM[w.toLowerCase()]} ${unit}`)
}

// Disfluency the voice-to-text faithfully preserved. Removed for the TITLE
// only — never for anything stored as the user's own words.
function deFiller(str: string): string {
  return str
    .replace(/\b(?:i mean|you know|kind of|sort of|basically|actually|literally|like i said)\b/gi, ' ')
    .replace(/\b(\w+)(\s+\1)+\b/gi, '$1')          // "that that" → "that"
    .replace(/^\s*(?:so|and|but|well|okay|ok|um+|uh+|yeah)\b[\s,]*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// "1h30", "1h", "90m", "45 min", "20 minutes", "2 hrs", "three hours"
export function parseEffort(fragment: string): ParsedEffort {
  let minutes = 0, units = 0
  let text = digitise(fragment)

  // h/hr/hrs/hour(s) — the `r` must stay optional or bare "1h30" slips through.
  const hm = text.match(/(\d+)\s*h(?:ou)?r?s?\s*(\d+)\s*m?\b/i)
  const h  = text.match(/(\d+(?:\.\d+)?)\s*h(?:ou)?r?s?\b/i)
  const m  = text.match(/(\d+)\s*m(?:in(?:ute)?s?)?\b/i)
  if (hm && hm[2]) {
    minutes = Number(hm[1]) * 60 + Number(hm[2])
    text = text.replace(hm[0], ' ')
  } else if (h) {
    minutes = Math.round(Number(h[1]) * 60)
    text = text.replace(h[0], ' ')
  } else if (m) {
    minutes = Number(m[1])
    text = text.replace(m[0], ' ')
  }

  // "3 problems", "x4", "4 topics" — a count of output, not time.
  const u = text.match(/\b(?:x\s*(\d+)|(\d+)\s*(?:problems?|topics?|questions?|items?|reps?|pages?))\b/i)
  if (u) {
    units = Number(u[1] ?? u[2])
    text = text.replace(u[0], ' ')
  }

  return { text: titleFrom(text), minutes, units }
}

// A log line needs a TITLE, not a transcript. Dictation arrives as a ramble
// with the effort reported at the end ("…that took three hours. I spent on
// that today"), so: drop the filler, drop the clause that only reports time,
// keep the first real clause, and cap it.
export function titleFrom(raw: string): string {
  // "X I mean Y" is a self-correction: Y is what was meant, X is the false
  // start. Keep the LAST correction and drop everything before it — this runs
  // before deFiller, which would otherwise just delete the marker.
  let t = String(raw).replace(/^.*\bi mean\b\s*/i, '')
  t = deFiller(t)
    .replace(/[\s,;.–—-]+$/g, '')
    .replace(/^[\s,;.–—-]+/g, '')

  // Clauses whose whole job was to state the effort — the number is already
  // parsed out by now, so what remains is "that took", "i spent on that today".
  // Clock phrases are captured by parseClock and rendered as their own column,
  // so they are noise in the title: "this preparation this morning from six to
  // nine" must become "this preparation".
  const CLOCKWORD = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight'
  const CLOCKNUM  = `(?:\\d{1,2}(?::\\d{2})?|${CLOCKWORD})`
  t = t
    .replace(new RegExp(`\\b(?:from\\s+)?${CLOCKNUM}\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?\\s*(?:to|until|till|-|–|—)\\s*${CLOCKNUM}\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?`, 'gi'), ' ')
    .replace(new RegExp(`\\bat\\s+${CLOCKNUM}\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?`, 'gi'), ' ')
    .replace(/\b(?:this|in the|during the)\s+(?:morning|afternoon|evening|night)\b/gi, ' ')
    .replace(/\b(?:tonight|today|yesterday)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  t = t
    .replace(/\b(?:that\s+)?took\b[^.]*$/i, '')
    // Only when the object is a pronoun — "I spent on that today" reports
    // effort, while "I spent … on the migration script" names the work.
    .replace(/\bi\s+spent\b[^.]*\b(?:that|this|it)\b\s*(?:today|tonight)?\s*$/i, '')
    // …and as a lead-in, "spent about on X" → "X".
    .replace(/^\s*(?:i\s+)?(?:spent|worked)\s+(?:about|around|roughly|approximately)?\s*(?:on\s+)?/i, '')
    .replace(/\b(?:today|this morning|this evening|tonight)\b\s*$/i, '')
    .trim()

  // First sentence, then first clause — "X so Y" keeps X, which is the thing
  // actually done.
  t = t.split(/(?<=[.!?])\s+/)[0]
  const clause = t.split(/\s+\b(?:so|because|since|which|and then)\b\s+/i)[0]
  if (clause.split(/\s+/).length >= 3) t = clause

  // Lead-ins that name no work: "I gathered all the required X" → "gathered
  // all the required X" reads better as a title with the pronoun dropped.
  // Pulling the duration out also strands prepositions ("reviewed docs for",
  // "of reading"), so trim them from both ends.
  const EDGE = /^(?:for|of|on|in|about|at|to|with)\s+|\s+(?:for|of|on|in|about|at|to|with)$/gi
  t = t.replace(/^\s*i\s+/i, '')
       .replace(EDGE, '')
       .replace(EDGE, '')
       .replace(/[\s,;.–—-]+$/g, '')
       .replace(/\s{2,}/g, ' ')
       .trim()

  // Titles are chips in a list; past ~70 chars they stop being scannable.
  if (t.length > 70) {
    const cut = t.slice(0, 70)
    t = (cut.slice(0, cut.lastIndexOf(' ')) || cut) + '…'
  }
  // Never return nothing: a log line with no title is worse than a clumsy one.
  if (!t) {
    t = deFiller(String(raw)).replace(/\s{2,}/g, ' ').trim().slice(0, 70)
    if (!t) return ''
  }
  return t.charAt(0).toUpperCase() + t.slice(1)
}

// Filler verbs a dictation adds that a routine title would not ("said gratitude"
// vs "Say Gratitude"), plus ordinary glue words.
const STOP = new Set([
  'the','a','an','and','of','my','to','for','on','in','at','with','some',
  'did','do','done','say','said','went','go','get','got','had','have','make','made','take','took',
])
// Crude stemmer, deliberately: "meditated" and "Meditate" must land on the same
// token, and a real stemmer is not worth a dependency for routine titles.
const stem = (w: string) => w.length > 4
  ? w.replace(/(ing|ed|es|s)$/, '').replace(/e$/, '')
  : w
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/).filter(w => w && !STOP.has(w)).map(stem).filter(Boolean)

// Score in [0,1]: how much of the shorter title the fragment covers. Exact
// substring wins outright so "meditate" hits "Meditate / Visualize" cleanly.
export function matchScore(fragment: string, title: string): number {
  const f = norm(fragment), t = norm(title)
  if (!f.length || !t.length) return 0
  const fs = f.join(' '), ts = t.join(' ')
  if (fs === ts) return 1
  if (fs.includes(ts) || ts.includes(fs)) return 0.9
  const shared = f.filter(w => t.includes(w)).length
  return shared / Math.min(f.length, t.length)
}

export interface MatchTarget { kind: 'routine' | 'goal'; id: string; title: string }

// The best target at or above the threshold, else null (⇒ unplanned).
export function bestMatch(fragment: string, targets: MatchTarget[], min = 0.6): MatchTarget | null {
  let best: MatchTarget | null = null, bestScore = 0
  for (const t of targets) {
    const s = matchScore(fragment, t.title)
    if (s > bestScore) { bestScore = s; best = t }
  }
  return bestScore >= min ? best : null
}

// Split a dictated line into fragments: commas, semicolons, newlines, " and ".
export function splitFragments(input: string): string[] {
  return input
    .split(/[\n;,]+|\s+\band\b\s+/i)
    .map(x => x.trim())
    .filter(Boolean)
}

// ── Clock times out of dictation ─────────────────────────────────────────────
//
// "from six to nine ... this morning" is a 06:00–09:00 window, and the log is
// far more useful on a timeline than as a duration alone. Meridiem is rarely
// spoken, so it is inferred from the part-of-day words in the same sentence.

export interface ClockSpan { start: string; end: string }   // "HH:MM", '' when absent

const CLOCK_WORD: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  noon: 12, midnight: 0,
}
const CW = Object.keys(CLOCK_WORD).join('|')

const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

// 'am' | 'pm' | '' from the part-of-day words anywhere in the fragment.
function dayHalf(str: string): 'am' | 'pm' | '' {
  if (/\b(morning|dawn|sunrise|breakfast)\b/i.test(str)) return 'am'
  if (/\b(afternoon|evening|night|tonight|dinner|dusk)\b/i.test(str)) return 'pm'
  return ''
}

function toHour(tok: string): number | null {
  const w = CLOCK_WORD[tok.toLowerCase()]
  if (w !== undefined) return w
  const n = Number(tok)
  return Number.isFinite(n) ? n : null
}

// 12-hour → 24-hour, given an explicit or inferred half.
function to24(h: number, half: 'am' | 'pm' | ''): number {
  if (h > 12) return h                        // already 24h
  if (half === 'pm') return h === 12 ? 12 : h + 12
  if (half === 'am') return h === 12 ? 0 : h
  return h
}

export function parseClock(fragment: string): ClockSpan {
  const none = { start: '', end: '' }
  const half = dayHalf(fragment)
  const NUM  = `(?:\\d{1,2}(?::\\d{2})?|${CW})`
  const MER  = `\\s*(a\\.?m\\.?|p\\.?m\\.?)?`

  const split = (tok: string): [number, number] | null => {
    const [hs, ms] = tok.split(':')
    const h = toHour(hs)
    if (h === null || h > 24) return null
    return [h, ms ? Number(ms) : 0]
  }

  // "from six to nine", "9:30 to 11", "2-4pm"
  const range = fragment.match(new RegExp(
    `\\b(?:from\\s+)?(${NUM})${MER}\\s*(?:to|until|till|-|–|—)\\s*(${NUM})${MER}`, 'i'))
  if (range) {
    const a = split(range[1]), b = split(range[3])
    if (a && b) {
      const halfA = (range[2]?.toLowerCase().startsWith('p') ? 'pm'
                   : range[2]?.toLowerCase().startsWith('a') ? 'am' : '') as 'am' | 'pm' | ''
      const halfB = (range[4]?.toLowerCase().startsWith('p') ? 'pm'
                   : range[4]?.toLowerCase().startsWith('a') ? 'am' : '') as 'am' | 'pm' | ''
      // An explicit half on either end governs both when the other is silent.
      let h1 = to24(a[0], halfA || halfB || half)
      let h2 = to24(b[0], halfB || halfA || half)
      // "11 to 2" with nothing else stated crosses noon rather than running backwards.
      if (h2 < h1 && !halfB && h2 + 12 <= 23) h2 += 12
      return { start: hhmm(h1, a[1]), end: hhmm(h2, b[1]) }
    }
  }

  // A single stated time: "at 14:30", "at six in the evening"
  const one = fragment.match(new RegExp(`\\bat\\s+(${NUM})${MER}`, 'i'))
  if (one) {
    const a = split(one[1])
    if (a) {
      const h = (one[2]?.toLowerCase().startsWith('p') ? 'pm'
               : one[2]?.toLowerCase().startsWith('a') ? 'am' : '') as 'am' | 'pm' | ''
      return { start: hhmm(to24(a[0], h || half), a[1]), end: '' }
    }
  }
  return none
}

// The timeline's item column is narrow — a couple of words, not a sentence.
export function shortTitle(title: string, words = 5): string {
  const w = String(title).replace(/…$/, '').trim().split(/\s+/).filter(Boolean)
  return w.length <= words ? w.join(' ') : w.slice(0, words).join(' ') + '…'
}

// Minutes since midnight, for laying a span out on a timeline.
export function clockMinutes(hhmmStr: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmmStr)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
