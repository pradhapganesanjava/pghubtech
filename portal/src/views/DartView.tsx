// DART — Daily Activity & Results Tracker.
//
//   ☀️ Today    the day as a checklist: the fixed routine blocks plus whatever
//               today's goals ask for, with a must-do / could-do call on each.
//   🎯 Goals    start → tentative end, a frequency, and a time target per period.
//   💡 Lessons  what worked / what did not, kept as reusable practice.
//
// Lessons is injected as `lessonsPanel` rather than imported: it lives in
// UtilsView, which imports THIS file, so a direct import would close a cycle.
// (Logging happens on Today now — the ＋ Log box writes straight against the
// day's items, so the separate Activity Log tab was retired.)
//   💭 Thoughts free-typed notes, auto-sorted into buckets and reviewable later.
//
// Everything persists to the DART spreadsheet in the Drive folder
// PGHubTechDART — see adapters/dartRepo.ts. The scheduling rules (what today
// asks for, and whether it is a must) live in lib/dartPlan.ts.

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  addBlock, addGoal, addLogEntry, addRoutine,
  deleteBlock, deleteGoal, deleteLogEntries, deleteRoutine,
  loadBlocks, loadGoals, loadLog, loadRoutines,
  updateBlock, updateGoal, updateRoutine,
} from '../adapters/dartRepo'
import type {
  DartBlock, DartGoal, DartLogEntry, DartRoutine, LogMood,
  GoalFrequency, GoalPriority,
} from '../adapters/dartRepo'
import {
  bestMatch, clockMinutes, fmtMins, fmtUnits, goalTask, goalTasksFor, goalWindow,
  isoDate, parseClock, parseEffort, parseIso, shortTitle, splitFragments,
} from '../lib/dartPlan'
import type { MatchTarget } from '../lib/dartPlan'
import type { GoalTask } from '../lib/dartPlan'
import { useToast } from '../components/Toast'
import { LLM } from '../lib/llm'
import { addLesson } from '../adapters/utilsRepo'
import ConsistencyGrid from '../components/ConsistencyGrid'

type DartSubTab = 'today' | 'goals' | 'lessons'

const DAY_NAMES   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export default function DartView({ lessonsPanel }: { lessonsPanel?: ReactNode } = {}) {
  const { toast } = useToast()
  const [tab, setTab] = useState<DartSubTab>('today')

  // Blocks / routines / goals / log back both the Today and Goals tabs, so
  // they are held here and loaded once rather than refetched on every switch.
  const [blocks,   setBlocks]   = useState<DartBlock[]>([])
  const [routines, setRoutines] = useState<DartRoutine[]>([])
  const [goals,    setGoals]    = useState<DartGoal[]>([])
  const [log,      setLog]      = useState<DartLogEntry[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  useEffect(() => {
    // Sequential, not Promise.all: the very first call has to create the Drive
    // folder + spreadsheet, and four parallel callers would each try to create
    // their own. dartRepo memoises the resolution, so this only costs on run 1.
    ;(async () => {
      try {
        setBlocks(await loadBlocks())
        setRoutines(await loadRoutines())
        setGoals(await loadGoals())
        setLog(await loadLog())
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  return (
    <div className="dart-wrap">
      <div className="activity-subtabs">
        <button
          className={`activity-subtab${tab === 'today' ? ' active' : ''}`}
          onClick={() => setTab('today')}
        >☀️ Today</button>
        <button
          className={`activity-subtab${tab === 'goals' ? ' active' : ''}`}
          onClick={() => setTab('goals')}
        >🎯 Goals</button>
        {lessonsPanel && (
          <button
            className={`activity-subtab${tab === 'lessons' ? ' active' : ''}`}
            onClick={() => setTab('lessons')}
          >💡 Lessons</button>
        )}
      </div>

      {tab === 'lessons' ? (
        // Straight through: Lessons loads from its own store, so it must not
        // sit behind DART's spreadsheet load or its error state.
        lessonsPanel
      ) : error ? (
        <div className="dart-error">
          Could not open the DART store in Drive/PGHubTechDART — {error}
        </div>
      ) : loading ? (
        <div className="dart-loading"><div className="spinner" /><span>Opening DART…</span></div>
      ) : tab === 'today' ? (
        <TodayPanel
          blocks={blocks} routines={routines} goals={goals} log={log}
          setBlocks={setBlocks} setRoutines={setRoutines} setLog={setLog}
          toast={toast}
        />
      ) : (
        <GoalsPanel goals={goals} log={log} setGoals={setGoals} toast={toast} />
      )}
    </div>
  )
}

type Toast = ReturnType<typeof useToast>['toast']

// ── Today ────────────────────────────────────────────────────────────────────

// A dictated ramble carries a real title and real substance, but the local
// parser can only trim — it cannot decide that "collected gathered all the
// materials to prepare for the next intuit interview" is *Intuit interview
// prep*. That judgement is the one thing worth an API call, and only for
// unplanned work long enough to have a shape (matched items already have a
// title: the routine's own).
//
// Fails soft in every direction: not configured, network down, bad JSON — the
// locally parsed title stands and nothing blocks the save.
async function condense(
  raw: string, fallbackTitle: string,
): Promise<{ title: string; notes: string; mood: LogMood }> {
  const fallback = { title: fallbackTitle, notes: '', mood: 'good' as LogMood }
  if (raw.trim().split(/\s+/).length < 12 || !(await LLM.ensureConfigured())) return fallback
  try {
    const reply = await LLM.chat([
      { role: 'system', content: [
        'You clean up one line of dictated work-log text.',
        'Return STRICT JSON only — first character "{", last "}". No prose, no fences.',
        '{ "title": "", "bullets": [], "mood": "good" }',
        'title:   3–6 words naming the WORK done. Title case. No duration, no filler,',
        '         no "I". If the speaker corrected themselves ("X I mean Y"), Y wins.',
        'bullets: 1–3 short lines of substance actually stated — what was gathered,',
        '         prepared, fixed, decided. Never invent detail. Never restate the title.',
        '         Omit the duration; it is recorded separately.',
        'mood:    "good" when the speaker sounds satisfied it was worth the time,',
        '         "waste" when they call it wasted / regret it, "mixed" when unsure',
        '         or when they say more was still needed. Default "good".',
      ].join('\n') },
      { role: 'user', content: raw },
    ], 300)
    const m = reply.match(/\{[\s\S]*\}/)
    if (!m) return fallback
    const j = JSON.parse(m[0]) as { title?: string; bullets?: string[]; mood?: string }
    const title = String(j.title ?? '').trim()
    const notes = (Array.isArray(j.bullets) ? j.bullets : [])
      .map(b => String(b ?? '').trim()).filter(Boolean).slice(0, 3).join('\n')
    const mood = (['good','mixed','waste'].includes(String(j.mood)) ? j.mood : 'good') as LogMood
    return { title: title || fallbackTitle, notes, mood }
  } catch {
    return fallback
  }
}

// A stated window is itself a duration — "six to nine" is 180 minutes even if
// the speaker never says "three hours".
function spanMinutes(span: { start: string; end: string }): number {
  const a = clockMinutes(span.start), b = clockMinutes(span.end)
  return a !== null && b !== null && b > a ? b - a : 0
}

// A day's log often carries the thing worth keeping: the approach that finally
// worked, the trick that unblocked it, the route that wasted an hour. That is a
// LESSON, not a log line — it outlives the date.
//
// Run once over the whole dictation rather than per fragment, so "tried X, gave
// up, Y worked" is read as one story. Returns null when the text is pure
// activity reporting, which is the common case — the prompt is explicit that
// inventing a lesson is worse than returning none.
async function extractLesson(
  raw: string,
): Promise<{ problem: string; worked: string; notWorked: string; path: string } | null> {
  if (raw.trim().split(/\s+/).length < 8 || !(await LLM.ensureConfigured())) return null
  try {
    const reply = await LLM.chat([
      { role: 'system', content: [
        'You read one day of work-log dictation and decide whether it contains a',
        'REUSABLE lesson — a strategy, approach or trick that helped finish the',
        'work, or one that clearly did not.',
        'Return STRICT JSON only, first character "{", last "}". No prose, no fences.',
        '{ "has_lesson": false, "problem": "", "worked": [], "not_worked": [], "path": "" }',
        'has_lesson: true ONLY when the speaker names something they would want to',
        '            do again (or avoid) next time. Plain activity reporting',
        '            ("spent 3h on prep") is NOT a lesson.',
        'problem:    the situation it applies to, one short line under 80 chars.',
        'worked:     the approach/trick that helped, as an ARRAY of short bullets.',
        'not_worked: the approach that failed or wasted time, same array form.',
        'Every bullet: one idea, under 80 characters, no trailing period. Split a',
        'long thought into two bullets rather than writing one long line. [] if none.',
        'path:       1-3 "::"-separated tags filing it for later, broad → narrow,',
        '            lowercase, e.g. "interview::prep" or "debugging::tooling".',
        'Never invent. A wrong lesson is worse than no lesson — when unsure, false.',
      ].join('\n') },
      { role: 'user', content: raw },
    ], 400)
    const m = reply.match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0]) as Record<string, unknown>
    if (j.has_lesson !== true) return null
    // Bullets are stored one per line; a model that answers with a plain string
    // instead of an array still works.
    const asLines = (v: unknown): string => (Array.isArray(v) ? v : [v])
      .map(x => String(x ?? '').trim().replace(/[.;]$/, ''))
      .filter(Boolean).join('\n')
    const problem   = String(j.problem ?? '').trim()
    const worked    = asLines(j.worked)
    const notWorked = asLines(j.not_worked)
    // A lesson with no substance on either axis is noise.
    if (!problem || (!worked && !notWorked)) return null
    // Same shape and depth cap as a Thought path.
    const path = String(j.path ?? '').toLowerCase()
      .split('::').map(x => x.trim().replace(/\s+/g, '-')).filter(Boolean)
      .slice(0, 4).join('::')
    return { problem, worked, notWorked, path }
  } catch {
    return null
  }
}

function TodayPanel({
  blocks, routines, goals, log, setBlocks, setRoutines, setLog, toast,
}: {
  blocks: DartBlock[]; routines: DartRoutine[]; goals: DartGoal[]; log: DartLogEntry[]
  setBlocks:   React.Dispatch<React.SetStateAction<DartBlock[]>>
  setRoutines: React.Dispatch<React.SetStateAction<DartRoutine[]>>
  setLog:      React.Dispatch<React.SetStateAction<DartLogEntry[]>>
  toast: Toast
}) {
  const [date, setDate]     = useState(() => isoDate(new Date()))
  const [editing, setEdit]  = useState(false)
  const [busy, setBusy]     = useState<string | null>(null)
  // Only the opened card shows bars and the log controls — everything else
  // stays a glanceable headline.
  const [openId, setOpenId] = useState<string | null>(null)
  // Quick log: collapsed by default — it is a capture box, not a fixture.
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickText, setQuickText] = useState('')
  const todayIso            = isoDate(new Date())

  const activeRoutines = useMemo(() => routines.filter(r => r.active), [routines])
  const byBlock = useMemo(() => {
    const m = new Map<string, DartRoutine[]>()
    for (const r of activeRoutines) {
      const list = m.get(r.blockId) ?? []
      list.push(r)
      m.set(r.blockId, list)
    }
    m.forEach(arr => arr.sort((a, b) => a.position - b.position))
    return m
  }, [activeRoutines])

  const dayLog = useMemo(() => log.filter(e => e.date === date), [log, date])
  const doneRoutineIds = useMemo(
    () => new Set(dayLog.filter(e => e.kind === 'routine').map(e => e.refId)),
    [dayLog],
  )

  const tasks = useMemo(() => goalTasksFor(goals, log, date), [goals, log, date])
  const openTasks = tasks.filter(t => t.status !== 'done')

  const askedRoutine = activeRoutines.reduce((s, r) => s + r.minutes, 0)
  const askedGoals   = openTasks.reduce((s, t) => s + t.time.todayShare, 0)
  const asked        = askedRoutine + askedGoals

  const loggedTotal   = dayLog.reduce((s, e) => s + e.minutes, 0)
  const creditRoutine = activeRoutines
    .filter(r => doneRoutineIds.has(r.id))
    .reduce((s, r) => s + r.minutes, 0)
  const creditGoals   = openTasks
    .reduce((s, t) => s + Math.min(t.time.todayDone, t.time.todayShare), 0)
  const done  = creditRoutine + creditGoals
  const left  = Math.max(0, asked - done)
  const extra = Math.max(0, loggedTotal - done)

  const totalCount = activeRoutines.length + tasks.length
  const doneCount  = doneRoutineIds.size + tasks.filter(t => t.status === 'done').length
  const pct        = asked === 0 ? 0 : Math.min(100, Math.round((done / asked) * 100))

  const nextRoutine = useMemo(() => {
    for (const b of blocks) {
      for (const r of byBlock.get(b.id) ?? []) {
        if (!doneRoutineIds.has(r.id)) return { block: b, routine: r }
      }
    }
    return null
  }, [blocks, byBlock, doneRoutineIds])
  const mustTasks = openTasks.filter(t => t.status === 'must')

  const d = parseIso(date)

  const adhocEntries = useMemo(() => dayLog.filter(e => e.kind === 'adhoc'), [dayLog])

  // Entries that stated a wall-clock window, in order — the timeline's rows.
  const timeline = useMemo(() => dayLog
    .filter(e => e.startTime)
    .map(e => ({ e, from: clockMinutes(e.startTime) ?? 0, to: clockMinutes(e.endTime) ?? null }))
    .sort((a, b) => a.from - b.from), [dayLog])
  const timelineMins = timeline.reduce(
    (s, r) => s + (r.to !== null && r.to > r.from ? r.to - r.from : r.e.minutes), 0)

  // Free text in, day updated. Each fragment either names something the day
  // already asks for — logged against THAT item — or it does not, and becomes
  // an unplanned entry that lives on this date alone.
  async function runQuickLog() {
    const text = quickText.trim()
    if (!text || busy) return
    setBusy('quick')
    const targets: MatchTarget[] = [
      ...activeRoutines.map(r => ({ kind: 'routine' as const, id: r.id, title: r.title })),
      ...tasks.map(t => ({ kind: 'goal' as const, id: t.goal.id, title: t.goal.title })),
    ]
    const added: DartLogEntry[] = []
    let matched = 0, unplanned = 0, skipped = 0, ignored = 0
    try {
      // A dictated REFLECTION is full of commas and contains no activities, so
      // splitting it produced one junk row per clause. A fragment only earns a
      // log row when it carries an effort signal (duration, count, clock) or
      // names something the day asks for. Everything else is prose, and prose
      // belongs in a lesson, not the day's ledger.
      const frags = splitFragments(text).map(frag => {
        const eff  = parseEffort(frag)
        const span = parseClock(frag)
        const hit  = eff.text ? bestMatch(eff.text, targets) : null
        const mins = eff.minutes || spanMinutes(span)
        return { frag, eff, span, hit, mins, isActivity: !!(mins || eff.units || hit) }
      })
      const activities = frags.filter(f => f.isActivity)
      ignored = frags.length - activities.length

      // Nothing measurable at all ⇒ log nothing. The text still goes through
      // lesson extraction below, which is where a reflection actually belongs.
      const HARD_CAP = 8
      for (const { frag, eff, span, hit, mins } of activities.slice(0, HARD_CAP)) {
        const { text: what, units } = eff
        if (hit?.kind === 'routine') {
          // Already ticked ⇒ leave it be rather than double-logging the day.
          if (doneRoutineIds.has(hit.id)) { skipped++; continue }
          const r = activeRoutines.find(x => x.id === hit.id)!
          added.push(await addLogEntry(
            date, 'routine', r.id, r.title, mins || r.minutes, 0, '', span.start, span.end))
          matched++
        } else if (hit?.kind === 'goal') {
          const g = tasks.find(t => t.goal.id === hit.id)!
          added.push(await addLogEntry(
            date, 'goal', g.goal.id, g.goal.title, mins, units, '', span.start, span.end))
          matched++
        } else {
          const { title, notes, mood } = await condense(frag, what)
          added.push(await addLogEntry(
            date, 'adhoc', '', title, mins, units, notes, span.start, span.end, mood))
          unplanned++
        }
      }
      if (activities.length > HARD_CAP) ignored += activities.length - HARD_CAP
      if (added.length) setLog(prev => [...prev, ...added])
      setQuickText('')

      // Runs whether or not anything was logged — a pure reflection logs zero
      // rows and is exactly the input most likely to carry a lesson.
      // Best-effort: a failure here must not cost the entries already saved.
      let learned = false
      try {
        const lesson = await extractLesson(text)
        if (lesson) {
          await addLesson({ ...lesson, source: `ai:${date}` })
          learned = true
        }
      } catch { /* the log is saved; the lesson is a bonus */ }

      const parts = [
        matched   ? `${matched} matched` : '',
        unplanned ? `${unplanned} unplanned` : '',
        skipped   ? `${skipped} already done` : '',
        learned   ? '1 lesson' : '',
        ignored   ? `${ignored} not an activity` : '',
      ].filter(Boolean)
      toast(
        parts.length ? parts.join(' · ') : 'Nothing to log',
        added.length || learned ? 'success' : 'info',
      )
    } catch (e) {
      toast(`Could not log: ${(e as Error).message}`, 'error')
    } finally { setBusy(null) }
  }

  // Bulk escape hatch: a bad dictation can produce a screenful of rows, and
  // removing them one ✕ at a time is worse than the mistake.
  async function clearAdhoc() {
    if (busy || adhocEntries.length === 0) return
    setBusy('clear-adhoc')
    try {
      const ids = adhocEntries.map(e => e.id)
      await deleteLogEntries(ids)
      const gone = new Set(ids)
      setLog(prev => prev.filter(e => !gone.has(e.id)))
      toast(`Cleared ${ids.length} unplanned`, 'success')
    } catch (e) {
      toast(`Could not clear: ${(e as Error).message}`, 'error')
    } finally { setBusy(null) }
  }

  async function removeAdhoc(entry: DartLogEntry) {
    if (busy) return
    setBusy(entry.id)
    try {
      await deleteLogEntries([entry.id])
      setLog(prev => prev.filter(e => e.id !== entry.id))
    } catch (e) {
      toast(`Could not remove: ${(e as Error).message}`, 'error')
    } finally { setBusy(null) }
  }

  function shiftDay(delta: number) {
    const n = parseIso(date)
    n.setDate(n.getDate() + delta)
    setDate(isoDate(n))
  }

  async function toggleRoutine(r: DartRoutine) {
    if (busy) return
    setBusy(r.id)
    try {
      const existing = dayLog.filter(e => e.kind === 'routine' && e.refId === r.id)
      if (existing.length > 0) {
        await deleteLogEntries(existing.map(e => e.id))
        const gone = new Set(existing.map(e => e.id))
        setLog(prev => prev.filter(e => !gone.has(e.id)))
      } else {
        const entry = await addLogEntry(date, 'routine', r.id, r.title, r.minutes)
        setLog(prev => [...prev, entry])
      }
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`, 'error')
    } finally { setBusy(null) }
  }

  async function logGoal(t: GoalTask, minutes: number, units = 0) {
    if (busy || (minutes <= 0 && units <= 0)) return
    setBusy(t.goal.id)
    try {
      const entry = await addLogEntry(date, 'goal', t.goal.id, t.goal.title, minutes, units)
      setLog(prev => [...prev, entry])
    } catch (e) {
      toast(`Could not log: ${(e as Error).message}`, 'error')
    } finally { setBusy(null) }
  }

  async function clearGoalDay(t: GoalTask) {
    if (busy) return
    setBusy(t.goal.id)
    try {
      const mine = dayLog.filter(e => e.kind === 'goal' && e.refId === t.goal.id)
      await deleteLogEntries(mine.map(e => e.id))
      const gone = new Set(mine.map(e => e.id))
      setLog(prev => prev.filter(e => !gone.has(e.id)))
    } catch (e) {
      toast(`Could not clear: ${(e as Error).message}`, 'error')
    } finally { setBusy(null) }
  }

  return (
    <div className="dart-today-wrap">
      {/* ── Main column ──────────────────────────────────── */}
      <div className="dart-body dart-today">
        <div className="dart-dayhead">
          <div className="dart-daynav">
            <button className="dart-navbtn" onClick={() => shiftDay(-1)} title="Previous day">‹</button>
            <div className="dart-daytitle">
              <div className="dart-dayname">{DAY_NAMES[d.getDay()]}</div>
              <div className="dart-daydate">{MONTH_NAMES[d.getMonth()]} {d.getDate()}</div>
            </div>
            <button className="dart-navbtn" onClick={() => shiftDay(1)} title="Next day">›</button>
            {date !== todayIso && (
              <button className="dart-todaybtn" onClick={() => setDate(todayIso)}>Back to today</button>
            )}
            <div className="dart-ringwrap" title={`${pct}% of what today asked`}>
              <Ring pct={pct} />
              <div className="dart-ringlbl"><b>{doneCount}</b>/{totalCount}</div>
            </div>
          </div>

          {/* The day's budget lives in the side column, under the grid — the
              header is kept to the one thing to act on next. */}

          {/* The one line that says what to do next. */}
          <div className="dart-focus">
            {mustTasks.length > 0 ? (
              <div className="dart-focus-row must">
                <span className="dart-focus-tag">must do now</span>
                <span className="dart-focus-main">{mustTasks[0].goal.title}</span>
                <span className="dart-focus-ask">{askText(mustTasks[0])}</span>
              </div>
            ) : nextRoutine ? (
              <div className="dart-focus-row next">
                <span className="dart-focus-tag">next up</span>
                <span className="dart-focus-main">{nextRoutine.routine.title}</span>
                <span className="dart-focus-ask">
                  {nextRoutine.routine.minutes > 0 && fmtMins(nextRoutine.routine.minutes)} · {nextRoutine.block.title}
                </span>
              </div>
            ) : (
              <div className="dart-focus-row clear">
                <span className="dart-focus-tag">clear</span>
                <span className="dart-focus-main">Everything the day asked for is done.</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Quick log ──────────────────────────────────── */}
        <section className={`dart-quick${quickOpen ? ' open' : ''}`}>
          <button className="dart-quick-hd" onClick={() => setQuickOpen(o => !o)}>
            <span className="dart-quick-caret">{quickOpen ? '▾' : '▸'}</span>
            <span className="dart-quick-title">＋ Log what you did</span>
          </button>
          {quickOpen && (
            <div className="dart-quick-body">
              <textarea
                className="dart-quick-input"
                rows={2}
                value={quickText}
                onChange={e => setQuickText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runQuickLog() }}
                placeholder="meditated 15m, read 20 min, chased a prod bug 1h30"
              />
              <div className="dart-quick-actions">
                <span className="dart-quick-hint">
                  Names something today asks for → ticked against it. Anything else → unplanned, this date only.
                </span>
                <button
                  className="dart-quick-btn"
                  disabled={busy === 'quick' || !quickText.trim()}
                  onClick={runQuickLog}
                >{busy === 'quick' ? '…' : 'Log'}</button>
              </div>
            </div>
          )}
        </section>

        {/* ── Unplanned (this date only) ─────────────────── */}
        {adhocEntries.length > 0 && (
          <section className="dart-section">
            <div className="dart-section-hd">
              <span className="dart-section-title">✳️ Unplanned</span>
              <span className="dart-section-meta">
                <b>{fmtMins(adhocEntries.reduce((s, e) => s + e.minutes, 0))}</b>
              </span>
              <span className="dart-blockcount">{adhocEntries.length}</span>
              {adhocEntries.length > 1 && (
                <button
                  className="dart-clear-adhoc" disabled={busy === 'clear-adhoc'}
                  onClick={clearAdhoc}
                  title={`Remove all ${adhocEntries.length} unplanned entries for this date`}
                >{busy === 'clear-adhoc' ? '…' : 'clear all'}</button>
              )}
            </div>
            <div className="dart-section-sub">work the day never asked for — kept on this date only</div>
            <ul className="dart-adhoc-list">
              {adhocEntries.map(e => (
                <li key={e.id} className="dart-adhoc">
                  <div className="dart-adhoc-hd">
                    <span className="dart-adhoc-title">{e.title}</span>
                    <span className="dart-adhoc-mins">
                      {e.minutes ? fmtMins(e.minutes) : ''}
                      {e.units ? ` · ${fmtUnits(e.units, '')}` : ''}
                    </span>
                    <button
                      className="dart-rchip-x" disabled={busy === e.id}
                      onClick={() => removeAdhoc(e)} title="Remove"
                    >✕</button>
                  </div>
                  {e.notes && (
                    <ul className="dart-adhoc-notes">
                      {e.notes.split('\n').filter(Boolean).map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Goal tasks ─────────────────────────────────── */}
        {tasks.length > 0 && (
          <section className="dart-section">
            <div className="dart-section-hd">
              <span className="dart-section-title">🎯 From your goals</span>
              <span className="dart-section-meta">{fmtMins(askedGoals)} asked</span>
            </div>
            <ul className="dart-cards">
              {tasks.map(t => (
                <GoalTaskCard
                  key={t.goal.id} task={t}
                  open={openId === t.goal.id}
                  onToggleOpen={() => setOpenId(id => id === t.goal.id ? null : t.goal.id)}
                  busy={busy === t.goal.id}
                  onLog={(m, u) => logGoal(t, m, u)}
                  onClear={() => clearGoalDay(t)}
                />
              ))}
            </ul>
          </section>
        )}

        {/* ── Routine blocks ─────────────────────────────── */}
        {blocks.map(b => {
          const items  = byBlock.get(b.id) ?? []
          const mins   = items.reduce((s, r) => s + r.minutes, 0)
          const ticked = items.filter(r => doneRoutineIds.has(r.id)).length
          if (items.length === 0 && !editing) return null
          const complete = items.length > 0 && ticked === items.length
          return (
            <section className={`dart-section${complete ? ' complete' : ''}`} key={b.id}>
              <div className="dart-section-hd">
                <span className="dart-section-title">{b.title}</span>
                <span className="dart-section-meta"><b>{fmtMins(mins)}</b></span>
                <span className={`dart-blockcount${complete ? ' done' : ''}`}>{ticked}/{items.length}</span>
                {editing && <BlockEditActions block={b} setBlocks={setBlocks} setRoutines={setRoutines} toast={toast} />}
              </div>
              {b.subtitle && <div className="dart-section-sub">{b.subtitle}</div>}
              <ul className="dart-chips">
                {items.map(r => {
                  const isDone = doneRoutineIds.has(r.id)
                  return (
                    <li key={r.id} className={`dart-rchip${isDone ? ' done' : ''}`}>
                      <button
                        className="dart-rchip-btn" disabled={busy === r.id}
                        onClick={() => toggleRoutine(r)} aria-pressed={isDone}
                      >
                        <span className="dart-rchip-tick">{isDone ? '✓' : ''}</span>
                        <span className="dart-rchip-title">{r.title}</span>
                        {r.minutes > 0 && <span className="dart-rchip-mins">{fmtMins(r.minutes)}</span>}
                      </button>
                      {editing && <RoutineEditActions routine={r} setRoutines={setRoutines} toast={toast} />}
                    </li>
                  )
                })}
              </ul>
              {editing && <AddRoutineRow blockId={b.id} setRoutines={setRoutines} toast={toast} />}
            </section>
          )
        })}

        <div className="dart-today-foot">
          <button className="dart-editbtn" onClick={() => setEdit(e => !e)}>
            {editing ? 'Done editing' : '⚙ Edit routine'}
          </button>
          {editing && <AddBlockRow setBlocks={setBlocks} toast={toast} />}
        </div>
      </div>

      {/* ── Side column: timeline, then consistency ──────── */}
      <aside className="dart-side">
        {/* Only entries that stated a clock window appear — a duration alone
            has no position on a day, and guessing one would invent history. */}
        <div className="dart-tl">
          <div className="dart-tl-hd">
            <span className="dart-tl-title">🕒 Timeline</span>
            {timelineMins > 0 && <span className="dart-tl-total">{fmtMins(timelineMins)}</span>}
          </div>
          {timeline.length === 0 ? (
            <div className="dart-tl-empty">
              No times yet. Say <i>"from six to nine"</i> in the log box and it lands here.
            </div>
          ) : (
            <ul className="dart-tl-list">
              {timeline.map(({ e, from, to }, i) => {
                const prev = timeline[i - 1]
                // A gap only counts once both sides are anchored in clock time.
                const gap  = prev?.to !== null && prev?.to !== undefined && from - prev.to >= 30
                  ? from - prev.to : 0
                const mood = e.kind === 'adhoc' ? e.mood : 'good'
                return (
                  <li key={e.id}>
                    {gap > 0 && (
                      <div className="dart-tl-gap" title="Unaccounted time">
                        <span>{fmtMins(gap)} unaccounted</span>
                      </div>
                    )}
                    <div className={`dart-tl-row mood-${mood}`}>
                      <div className="dart-tl-when">
                        <span className="dart-tl-t1">{e.startTime}</span>
                        {e.endTime && <span className="dart-tl-t2">{e.endTime}</span>}
                      </div>
                      <div className="dart-tl-what">
                        <span className="dart-tl-name" title={e.title}>{shortTitle(e.title)}</span>
                        <span className="dart-tl-kind">
                          {e.kind === 'adhoc' ? 'unplanned' : e.kind}
                          {to !== null && to > from ? ` · ${fmtMins(to - from)}` : e.minutes ? ` · ${fmtMins(e.minutes)}` : ''}
                        </span>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <ConsistencyGrid
          log={log} routines={routines}
          selectedDate={date} onSelectDate={setDate}
        />

        <div className="dart-budget">
          <div className="dart-budget-hd">
            {date === todayIso ? 'Today' : `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`}
          </div>
          <div className="dart-stats">
            <Stat value={fmtMins(asked)} label="asked of today" tone="ask" />
            <Stat value={fmtMins(done)}  label="done" tone={done > 0 ? 'good' : 'flat'} />
            <Stat value={fmtMins(left)}  label="left" tone={left > 0 ? 'warn' : 'good'} />
            <Stat value={`${doneCount}/${totalCount}`} label="activities" tone="flat" />
          </div>
          <div className="dart-progress"><div className="dart-progress-fill" style={{ width: `${pct}%` }} /></div>
          {extra > 0 && (
            <div className="dart-extra">+{fmtMins(extra)} logged beyond what today asked for</div>
          )}
        </div>
      </aside>
    </div>
  )
}

// The day's ask, split so the number can be set apart from what it counts.
interface Ask { value: string; unit: string; kind: 'time' | 'work'; behind: boolean }

function asksOf(t: GoalTask): Ask[] {
  const out: Ask[] = []
  if (t.time.tracked && t.time.todayShare > 0) {
    // The value already carries its unit ("8h"), so the label names the
    // vertical instead — matching the time / work wording used on the bars.
    out.push({ value: fmtMins(t.time.todayShare), unit: 'time', kind: 'time', behind: t.time.behind })
  }
  if (t.work.tracked && t.work.todayShare > 0) {
    const n = Math.round(t.work.todayShare)
    const label = t.goal.unitLabel || 'units'
    out.push({
      value: String(n),
      unit: n === 1 && label.endsWith('s') ? label.slice(0, -1) : label,
      kind: 'work', behind: t.work.behind,
    })
  }
  return out
}

function askText(t: GoalTask): string {
  return asksOf(t).map(a => a.kind === 'time' ? a.value : `${a.value} ${a.unit}`).join(' · ')
}

// How much runway is left, plus how loudly to say it. Under three days the
// deadline is the most important thing on the card, so it escalates.
function deadlineOf(t: GoalTask): { text: string; urgency: 'now' | 'soon' | 'calm' } {
  if (t.goal.frequency === 'total' || t.goal.endDate) {
    return {
      text:    t.daysLeft === 1 ? 'last day' : `${t.daysLeft} days left`,
      urgency: t.daysLeft <= 1 ? 'now' : t.daysLeft <= 3 ? 'soon' : 'calm',
    }
  }
  return { text: t.period.label, urgency: t.period.days <= 1 ? 'soon' : 'calm' }
}

function Ring({ pct }: { pct: number }) {
  const R = 26, C = 2 * Math.PI * R
  return (
    <svg className="dart-ring" viewBox="0 0 64 64" width="64" height="64" aria-hidden>
      <circle cx="32" cy="32" r={R} className="dart-ring-bg" />
      <circle
        cx="32" cy="32" r={R} className="dart-ring-fg"
        strokeDasharray={`${(pct / 100) * C} ${C}`}
        transform="rotate(-90 32 32)"
      />
    </svg>
  )
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div className={`dart-stat${tone ? ' t-' + tone : ''}`}>
      <div className="dart-stat-v">{value}</div>
      <div className="dart-stat-l">{label}</div>
    </div>
  )
}

// Collapsed: status, title, today's ask, runway — the four things worth seeing
// at a glance. Opened: the two progress verticals and the log controls.
function GoalTaskCard({ task, open, onToggleOpen, busy, onLog, onClear }: {
  task: GoalTask; open: boolean; onToggleOpen: () => void; busy: boolean
  onLog: (minutes: number, units: number) => void; onClear: () => void
}) {
  const [mins, setMins]   = useState('')
  const [units, setUnits] = useState('')
  const { time, work, goal, status } = task
  const label = goal.unitLabel || 'units'

  const satisfied = status === 'done' || ([time, work]
    .filter(v => v.tracked && v.todayShare > 0)
    .every(v => v.todayDone >= v.todayShare)
    && [time, work].some(v => v.tracked && v.todayShare > 0))
  const asks = asksOf(task)
  const dl   = deadlineOf(task)

  const pctOf = (v: { done: number; target: number }) =>
    v.target === 0 ? 0 : Math.min(100, Math.round((v.done / v.target) * 100))

  function submit() {
    const m = Number(mins) || 0, u = Number(units) || 0
    if (m <= 0 && u <= 0) return
    onLog(m, u); setMins(''); setUnits('')
  }

  return (
    <li className={`dart-card s-${satisfied ? 'done' : status}${open ? ' open' : ''}`}>
      <div className="dart-card-hd" onClick={onToggleOpen} role="button" tabIndex={0}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleOpen() } }}>
        <button
          className="dart-card-tick" disabled={busy} aria-pressed={satisfied}
          title={satisfied ? 'Clear today’s entries' : 'Log today’s share'}
          onClick={e => { e.stopPropagation(); satisfied ? onClear() : onLog(time.todayShare, work.todayShare) }}
        >{satisfied ? '✓' : ''}</button>

        {/* One row: status · runway · title · today's ask. It wraps to more
            lines only when the window is too narrow to hold it. */}
        <div className="dart-card-main">
          <span className={`dart-badge b-${satisfied ? 'done' : status}`}>
            {satisfied ? 'done' : status === 'must' ? 'must do' : 'could do'}
          </span>
          <span className={`dart-card-dl u-${dl.urgency}`}>{dl.text}</span>
          <span className="dart-card-title">{goal.title}</span>
          {!satisfied && asks.length > 0 && (
            <span className="dart-asks">
              {asks.map(a => (
                <span className={`dart-ask k-${a.kind}${a.behind ? ' behind' : ''}`} key={a.kind}>
                  <b className="dart-ask-v">{a.value}</b>
                  <span className="dart-ask-u">{a.unit}</span>
                </span>
              ))}
            </span>
          )}
        </div>

        <span className={`dart-card-caret${open ? ' open' : ''}`}>▾</span>
      </div>

      {open && (
        <div className="dart-card-body">
          <div className="dart-card-why">{task.why}</div>
          {time.tracked && (
            <div className="dart-goal-prog">
              <span className="dart-vlabel">time</span>
              <div className="dart-goal-bar"><div className="dart-goal-bar-fill" style={{ width: `${pctOf(time)}%` }} /></div>
              <span className="dart-goal-prog-t">{fmtMins(time.done)}/{fmtMins(time.target)} {task.period.label}</span>
            </div>
          )}
          {work.tracked && (
            <div className="dart-goal-prog">
              <span className="dart-vlabel">work</span>
              <div className="dart-goal-bar"><div className="dart-goal-bar-fill work" style={{ width: `${pctOf(work)}%` }} /></div>
              <span className="dart-goal-prog-t">
                {Math.round(work.done)}/{fmtUnits(work.target, label)} {task.period.label}
              </span>
            </div>
          )}
          <div className="dart-card-actions">
            {time.tracked && (
              <input className="dart-mins-input" type="number" min="0" placeholder="min"
                     value={mins} onChange={e => setMins(e.target.value)}
                     onKeyDown={e => { if (e.key === 'Enter') submit() }} />
            )}
            {work.tracked && (
              <input className="dart-mins-input" type="number" min="0" placeholder="amt" title={label}
                     value={units} onChange={e => setUnits(e.target.value)}
                     onKeyDown={e => { if (e.key === 'Enter') submit() }} />
            )}
            <button className="dart-minibtn" disabled={busy || !(Number(mins) > 0 || Number(units) > 0)}
                    onClick={submit}>Log</button>
            {(time.todayDone > 0 || work.todayDone > 0) && (
              <span className="dart-goal-today">
                {time.todayDone > 0 && fmtMins(time.todayDone)}
                {time.todayDone > 0 && work.todayDone > 0 && ' · '}
                {work.todayDone > 0 && fmtUnits(work.todayDone, label)} today
              </span>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

// ── Routine editing (only rendered while Today is in ⚙ edit mode) ────────────

function BlockEditActions({ block, setBlocks, setRoutines, toast }: {
  block: DartBlock
  setBlocks:   React.Dispatch<React.SetStateAction<DartBlock[]>>
  setRoutines: React.Dispatch<React.SetStateAction<DartRoutine[]>>
  toast: Toast
}) {
  async function rename() {
    const title = window.prompt('Block name', block.title)
    if (title === null) return
    const subtitle = window.prompt('One-line reason this block exists', block.subtitle) ?? block.subtitle
    try {
      const updated = await updateBlock({ ...block, title: title.trim() || block.title, subtitle })
      setBlocks(prev => prev.map(b => b.id === updated.id ? updated : b))
    } catch (e) { toast(`Rename failed: ${(e as Error).message}`, 'error') }
  }
  async function remove() {
    if (!window.confirm(`Delete the “${block.title}” block and every activity in it?`)) return
    try {
      await deleteBlock(block.id)
      setBlocks(prev => prev.filter(b => b.id !== block.id))
      setRoutines(prev => prev.filter(r => r.blockId !== block.id))
    } catch (e) { toast(`Delete failed: ${(e as Error).message}`, 'error') }
  }
  return (
    <span className="dart-edit-actions">
      <button className="dart-minibtn" onClick={rename}>Rename</button>
      <button className="dart-minibtn danger" onClick={remove}>Delete</button>
    </span>
  )
}

function RoutineEditActions({ routine, setRoutines, toast }: {
  routine: DartRoutine
  setRoutines: React.Dispatch<React.SetStateAction<DartRoutine[]>>
  toast: Toast
}) {
  async function edit() {
    const title = window.prompt('Activity', routine.title)
    if (title === null) return
    const mins = window.prompt('Minutes', String(routine.minutes))
    if (mins === null) return
    try {
      const updated = await updateRoutine({
        ...routine,
        title:   title.trim() || routine.title,
        minutes: Math.max(0, parseInt(mins, 10) || 0),
      })
      setRoutines(prev => prev.map(r => r.id === updated.id ? updated : r))
    } catch (e) { toast(`Save failed: ${(e as Error).message}`, 'error') }
  }
  async function remove() {
    if (!window.confirm(`Remove “${routine.title}” from the routine?`)) return
    try {
      await deleteRoutine(routine.id)
      setRoutines(prev => prev.filter(r => r.id !== routine.id))
    } catch (e) { toast(`Delete failed: ${(e as Error).message}`, 'error') }
  }
  return (
    <span className="dart-edit-actions">
      <button className="dart-minibtn" onClick={edit}>Edit</button>
      <button className="dart-minibtn danger" onClick={remove}>✕</button>
    </span>
  )
}

function AddRoutineRow({ blockId, setRoutines, toast }: {
  blockId: string
  setRoutines: React.Dispatch<React.SetStateAction<DartRoutine[]>>
  toast: Toast
}) {
  const [title, setTitle] = useState('')
  const [mins, setMins]   = useState('')
  const [busy, setBusy]   = useState(false)

  async function add() {
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const r = await addRoutine(blockId, title.trim(), Math.max(0, parseInt(mins, 10) || 0))
      setRoutines(prev => [...prev, r])
      setTitle(''); setMins('')
    } catch (e) { toast(`Add failed: ${(e as Error).message}`, 'error') }
    finally { setBusy(false) }
  }

  return (
    <div className="dart-addrow">
      <input
        className="rf-input" placeholder="Add an activity…" value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') add() }}
      />
      <input
        className="dart-mins-input" type="number" min="0" placeholder="min" value={mins}
        onChange={e => setMins(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') add() }}
      />
      <button className="dart-minibtn" disabled={!title.trim() || busy} onClick={add}>Add</button>
    </div>
  )
}

function AddBlockRow({ setBlocks, toast }: {
  setBlocks: React.Dispatch<React.SetStateAction<DartBlock[]>>
  toast: Toast
}) {
  const [title, setTitle] = useState('')
  const [sub, setSub]     = useState('')
  const [busy, setBusy]   = useState(false)

  async function add() {
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const b = await addBlock(title.trim(), sub.trim())
      setBlocks(prev => [...prev, b])
      setTitle(''); setSub('')
    } catch (e) { toast(`Add failed: ${(e as Error).message}`, 'error') }
    finally { setBusy(false) }
  }

  return (
    <div className="dart-addrow dart-addblock">
      <input
        className="rf-input" placeholder="New block (e.g. Afternoon Reset)" value={title}
        onChange={e => setTitle(e.target.value)}
      />
      <input
        className="rf-input" placeholder="why this block exists" value={sub}
        onChange={e => setSub(e.target.value)}
      />
      <button className="dart-minibtn" disabled={!title.trim() || busy} onClick={add}>Add block</button>
    </div>
  )
}

// ── Goals ────────────────────────────────────────────────────────────────────

interface GoalDraft {
  title: string; notes: string; startDate: string; endDate: string
  frequency: GoalFrequency; targetHours: string
  targetUnits: string; unitLabel: string
  priority: GoalPriority; active: boolean
}

function emptyDraft(): GoalDraft {
  return {
    title: '', notes: '', startDate: isoDate(new Date()), endDate: '',
    frequency: 'daily', targetHours: '1', targetUnits: '', unitLabel: '',
    priority: 'could', active: true,
  }
}

function draftFrom(g: DartGoal): GoalDraft {
  return {
    title: g.title, notes: g.notes, startDate: g.startDate, endDate: g.endDate,
    frequency: g.frequency,
    targetHours:  g.targetMinutes ? String(g.targetMinutes / 60) : '',
    targetUnits:  g.targetUnits ? String(g.targetUnits) : '',
    unitLabel:    g.unitLabel,
    priority: g.priority, active: g.active,
  }
}

// Where a goal stands right now. Beyond the live must/could/done, a goal can
// also be outside its own window — those read as neutral, not as failures.
type GoalState = 'must' | 'could' | 'done' | 'paused' | 'ended' | 'upcoming'

function goalStateOf(g: DartGoal, log: DartLogEntry[], todayIso: string): {
  state: GoalState; task: GoalTask; note: string; runway: string
} {
  const task = goalTask(g, log, todayIso)
  const w    = goalWindow(g, log, todayIso)

  let state: GoalState
  if (!g.active)                            state = 'paused'
  else if (w.expired)                       state = 'ended'
  else if (g.startDate && todayIso < g.startDate) state = 'upcoming'
  else                                      state = task.status

  const runway =
    state === 'paused'   ? 'paused'
  : state === 'ended'    ? `ended ${-(w.daysToEnd ?? 0)}d ago`
  : state === 'upcoming' ? `starts ${g.startDate}`
  : w.daysToEnd === null ? task.period.label
  : w.daysToEnd === 0    ? 'ends today'
  : `${w.daysToEnd + 1} days left`

  const note =
    state === 'paused'   ? 'Not on the Today list while paused.'
  : state === 'ended'    ? 'Window closed — push the date or retarget to revive it.'
  : state === 'upcoming' ? `Starts ${g.startDate}.`
  : task.why

  return { state, task, note, runway }
}

const STATE_LABEL: Record<GoalState, string> = {
  must: 'must do', could: 'could do', done: 'done',
  paused: 'paused', ended: 'ended', upcoming: 'upcoming',
}

function GoalsPanel({ goals, log, setGoals, toast }: {
  goals: DartGoal[]; log: DartLogEntry[]
  setGoals: React.Dispatch<React.SetStateAction<DartGoal[]>>
  toast: Toast
}) {
  const [editingId, setEditingId] = useState<string | null>(null)   // 'NEW' for the create form
  const [draft, setDraft]         = useState<GoalDraft>(emptyDraft)
  const [busy, setBusy]           = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const [openId, setOpenId]       = useState<string | null>(null)
  const todayIso = isoDate(new Date())

  // Same ordering as Today: what is urgent floats to the top.
  const ORDER: Record<GoalState, number> = {
    must: 0, could: 1, done: 2, upcoming: 3, ended: 4, paused: 5,
  }
  const shown = useMemo(() => goals
    .filter(g => showInactive || g.active)
    .map(g => ({ g, ...goalStateOf(g, log, todayIso) }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.g.title.localeCompare(b.g.title)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [goals, log, todayIso, showInactive])

  const mustCount = shown.filter(x => x.state === 'must').length

  function startNew() { setDraft(emptyDraft()); setEditingId('NEW') }
  function startEdit(g: DartGoal) { setDraft(draftFrom(g)); setEditingId(g.id) }

  async function save() {
    const hours = Number(draft.targetHours) || 0
    const units = Number(draft.targetUnits) || 0
    if (!draft.title.trim()) { toast('Give the goal a title.', 'error'); return }
    // Either vertical alone is a valid goal — but not neither.
    if (hours <= 0 && units <= 0) {
      toast('Set a target: hours, a countable amount, or both.', 'error'); return
    }
    if (units > 0 && !draft.unitLabel.trim()) {
      toast('Name what you are counting (e.g. problems).', 'error'); return
    }
    if (draft.frequency === 'total' && !draft.endDate) {
      toast('A total goal needs an end date to spread the target over.', 'error'); return
    }
    if (draft.endDate && draft.endDate < draft.startDate) {
      toast('The end date is before the start date.', 'error'); return
    }
    setBusy(true)
    try {
      const fields = {
        title:         draft.title.trim(),
        notes:         draft.notes.trim(),
        startDate:     draft.startDate,
        endDate:       draft.endDate,
        frequency:     draft.frequency,
        targetMinutes: Math.round(hours * 60),
        targetUnits:   units,
        unitLabel:     draft.unitLabel.trim(),
        priority:      draft.priority,
        active:        draft.active,
      }
      if (editingId === 'NEW') {
        const created = await addGoal(fields)
        setGoals(prev => [...prev, created])
      } else {
        const existing = goals.find(g => g.id === editingId)
        if (!existing) throw new Error('Goal not found')
        const updated = await updateGoal({ ...existing, ...fields })
        setGoals(prev => prev.map(g => g.id === updated.id ? updated : g))
      }
      setEditingId(null)
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove(g: DartGoal) {
    if (!window.confirm(`Delete “${g.title}”? Time already logged against it stays in the Log tab.`)) return
    try {
      await deleteGoal(g.id)
      setGoals(prev => prev.filter(x => x.id !== g.id))
      if (editingId === g.id) setEditingId(null)
    } catch (e) { toast(`Delete failed: ${(e as Error).message}`, 'error') }
  }

  return (
    <div className="dart-body dart-goals">
      <div className="dart-goals-bar">
        <button className="rf-btn-save" onClick={startNew}>＋ New goal</button>
        <label className="dart-inline-check">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show paused
        </label>
        <span className="dart-goals-count">
          {mustCount > 0 && <b className="dart-goals-must">{mustCount} must do</b>}
          {shown.length} goal{shown.length === 1 ? '' : 's'}
        </span>
      </div>

      {editingId === 'NEW' && (
        <GoalForm
          draft={draft} setDraft={setDraft} busy={busy}
          onSave={save} onCancel={() => setEditingId(null)} title="New goal"
        />
      )}

      {shown.length === 0 ? (
        <div className="col-empty">
          No goals yet. A goal needs a start date, a frequency, and a target —
          hours, a countable amount, or both. That is what puts it on the Today list.
        </div>
      ) : (
        <ul className="dart-cards">
          {shown.map(({ g, state, task, note, runway }) => (
            editingId === g.id ? (
              <li key={g.id}>
                <GoalForm
                  draft={draft} setDraft={setDraft} busy={busy}
                  onSave={save} onCancel={() => setEditingId(null)} title="Edit goal"
                />
              </li>
            ) : (
              <GoalCard
                key={g.id} goal={g} state={state} task={task} note={note} runway={runway}
                log={log} todayIso={todayIso}
                open={openId === g.id}
                onToggleOpen={() => setOpenId(id => id === g.id ? null : g.id)}
                onEdit={() => startEdit(g)} onDelete={() => remove(g)}
              />
            )
          ))}
        </ul>
      )}
    </div>
  )
}

// Mirrors the Today card: headline collapsed, detail on open, coloured only by
// state — never per-goal — so the palette keeps meaning the same thing everywhere.
function GoalCard({
  goal, state, task, note, runway, log, todayIso, open, onToggleOpen, onEdit, onDelete,
}: {
  goal: DartGoal; state: GoalState; task: GoalTask; note: string; runway: string
  log: DartLogEntry[]; todayIso: string
  open: boolean; onToggleOpen: () => void; onEdit: () => void; onDelete: () => void
}) {
  const w      = goalWindow(goal, log, todayIso)
  const label  = goal.unitLabel || 'units'
  const { time, work, period } = task
  const critical = state === 'must' || state === 'ended'

  const pctOf = (v: { done: number; target: number }) =>
    v.target === 0 ? 0 : Math.min(100, Math.round((v.done / v.target) * 100))

  return (
    <li className={`dart-card s-${state}${open ? ' open' : ''}`}>
      <div className="dart-card-hd" onClick={onToggleOpen} role="button" tabIndex={0}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleOpen() } }}>
        <div className="dart-card-main">
          <div className="dart-card-top">
            <span className={`dart-badge b-${state}`}>{STATE_LABEL[state]}</span>
            <span className="dart-card-dl">{runway}</span>
            <span className="dart-freq">{goal.frequency}</span>
          </div>
          <div className="dart-card-title">{goal.title}</div>

          {/* The numbers are the point of this page — big, bold, coloured. */}
          <div className="dart-metrics">
            {work.tracked && (
              <Metric
                done={String(Math.round(work.done))} target={String(Math.round(work.target))}
                unit={label} pct={pctOf(work)} kind="work" behind={work.behind}
              />
            )}
            {time.tracked && (
              <Metric
                done={fmtMins(time.done)} target={fmtMins(time.target)}
                unit={period.label} pct={pctOf(time)} kind="time" behind={time.behind}
              />
            )}
          </div>

          <div className={`dart-card-note${critical ? ' critical' : ''}`}>{note}</div>
        </div>
        <span className={`dart-card-caret${open ? ' open' : ''}`}>▾</span>
      </div>

      {open && (
        <div className="dart-card-body">
          {goal.notes && <div className="dart-goal-card-notes">{goal.notes}</div>}
          {time.tracked && (
            <div className="dart-goal-prog">
              <span className="dart-vlabel">time</span>
              <div className="dart-goal-bar"><div className="dart-goal-bar-fill" style={{ width: `${pctOf(time)}%` }} /></div>
              <span className="dart-goal-prog-t">{fmtMins(time.done)}/{fmtMins(time.target)} {period.label}</span>
            </div>
          )}
          {work.tracked && (
            <div className="dart-goal-prog">
              <span className="dart-vlabel">work</span>
              <div className="dart-goal-bar"><div className="dart-goal-bar-fill work" style={{ width: `${pctOf(work)}%` }} /></div>
              <span className="dart-goal-prog-t">
                {Math.round(work.done)}/{fmtUnits(work.target, label)} {period.label}
              </span>
            </div>
          )}
          <div className="dart-goal-card-meta">
            <span>{goal.startDate || '—'} → {goal.endDate || 'open-ended'}</span>
            <span>baseline {goal.priority === 'must' ? 'must do' : 'could do'}</span>
            <span>
              {fmtMins(w.totalMinutes)}
              {w.totalUnits > 0 && ` · ${fmtUnits(w.totalUnits, label)}`}
              {' '}logged all-time
            </span>
          </div>
          <div className="dart-card-actions">
            <button className="dart-minibtn" onClick={onEdit}>Edit</button>
            <button className="dart-minibtn danger" onClick={onDelete}>Delete</button>
          </div>
        </div>
      )}
    </li>
  )
}

// done / target, with the achieved number carrying the weight.
function Metric({ done, target, unit, pct, kind, behind }: {
  done: string; target: string; unit: string; pct: number
  kind: 'time' | 'work'; behind: boolean
}) {
  return (
    <div className={`dart-metric k-${kind}${behind ? ' behind' : ''}`}>
      <div className="dart-metric-nums">
        <span className="dart-metric-done">{done}</span>
        <span className="dart-metric-slash">/</span>
        <span className="dart-metric-target">{target}</span>
      </div>
      <div className="dart-metric-meta">
        <span className="dart-metric-pct">{pct}%</span>
        <span className="dart-metric-unit">{unit}</span>
      </div>
    </div>
  )
}

function GoalForm({ draft, setDraft, busy, onSave, onCancel, title }: {
  draft: GoalDraft; setDraft: React.Dispatch<React.SetStateAction<GoalDraft>>
  busy: boolean; onSave: () => void; onCancel: () => void; title: string
}) {
  const set = <K extends keyof GoalDraft>(k: K, v: GoalDraft[K]) => setDraft(p => ({ ...p, [k]: v }))
  const per = draft.frequency === 'daily'  ? 'per day'
            : draft.frequency === 'weekly' ? 'per week'
            : draft.frequency === 'monthly' ? 'per month'
            : 'in total'

  return (
    <div className="dart-goal-form">
      <div className="col-hd">{title}</div>
      <label className="dart-field">
        <span>Goal</span>
        <input className="rf-input" value={draft.title} placeholder="e.g. Grind DP problems"
               onChange={e => set('title', e.target.value)} />
      </label>
      <label className="dart-field">
        <span>Notes</span>
        <textarea className="rf-input" rows={2} value={draft.notes}
                  placeholder="what finishing this actually looks like"
                  onChange={e => set('notes', e.target.value)} />
      </label>
      <div className="dart-field-row">
        <label className="dart-field">
          <span>Start</span>
          <input className="rf-input" type="date" value={draft.startDate}
                 onChange={e => set('startDate', e.target.value)} />
        </label>
        <label className="dart-field">
          <span>Tentative end</span>
          <input className="rf-input" type="date" value={draft.endDate}
                 onChange={e => set('endDate', e.target.value)} />
        </label>
      </div>
      <div className="dart-field-row">
        <label className="dart-field">
          <span>Frequency</span>
          <select className="rf-input" value={draft.frequency}
                  onChange={e => set('frequency', e.target.value as GoalFrequency)}>
            <option value="total">Total by the end date</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <label className="dart-field">
          <span>Target hours {per}</span>
          <input className="rf-input" type="number" min="0" step="0.25" placeholder="none"
                 value={draft.targetHours}
                 onChange={e => set('targetHours', e.target.value)} />
        </label>
        <label className="dart-field">
          <span>Baseline</span>
          <select className="rf-input" value={draft.priority}
                  onChange={e => set('priority', e.target.value as GoalPriority)}>
            <option value="could">Could do — pace decides</option>
            <option value="must">Must do — always</option>
          </select>
        </label>
      </div>
      {/* The work vertical. Left blank, the goal is chased on hours alone;
          filled in with no hours, it is chased on output alone. */}
      <div className="dart-field-row">
        <label className="dart-field">
          <span>Target amount {per}</span>
          <input className="rf-input" type="number" min="0" step="1" placeholder="none"
                 value={draft.targetUnits}
                 onChange={e => set('targetUnits', e.target.value)} />
        </label>
        <label className="dart-field">
          <span>Counting what?</span>
          <input className="rf-input" placeholder="problems, topics, chapters…"
                 value={draft.unitLabel}
                 onChange={e => set('unitLabel', e.target.value)} />
        </label>
      </div>
      <label className="dart-inline-check">
        <input type="checkbox" checked={draft.active} onChange={e => set('active', e.target.checked)} />
        Active — show on Today
      </label>
      <div className="dart-form-actions">
        <button className="rf-btn-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="mgmt-save-btn" onClick={onSave} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}
