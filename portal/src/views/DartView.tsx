// DART — Daily Activity & Results Tracker.
//
//   ☀️ Today    the day as a checklist: the fixed routine blocks plus whatever
//               today's goals ask for, with a must-do / could-do call on each.
//   🎯 Goals    start → tentative end, a frequency, and a time target per period.
//   💭 Thoughts free-typed notes, auto-sorted into buckets and reviewable later.
//
// Everything persists to the DART spreadsheet in the Drive folder
// PGHubTechDART — see adapters/dartRepo.ts. The scheduling rules (what today
// asks for, and whether it is a must) live in lib/dartPlan.ts.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addBlock, addGoal, addLogEntry, addRoutine, addThought,
  deleteBlock, deleteGoal, deleteLogEntries, deleteRoutine, deleteThought,
  loadBlocks, loadGoals, loadLog, loadRoutines, loadThoughts,
  updateBlock, updateGoal, updateRoutine, updateThought,
  MAX_PATH_DEPTH, THOUGHT_BUCKETS,
} from '../adapters/dartRepo'
import type {
  DartBlock, DartGoal, DartLogEntry, DartRoutine, DartThought,
  GoalFrequency, GoalPriority, ThoughtBucket,
} from '../adapters/dartRepo'
import {
  fmtMins, fmtUnits, goalTask, goalTasksFor, goalWindow, isoDate, parseIso,
} from '../lib/dartPlan'
import type { GoalTask } from '../lib/dartPlan'
import { useToast } from '../components/Toast'
import ConsistencyGrid from '../components/ConsistencyGrid'
import { LLM } from '../lib/llm'
import { refineThought, renderThought } from '../lib/thoughtGen'
import { sanitizeHtml } from '../lib/sanitize'
import { buildTrie, TreeNode } from '../components/DocTagTree'

type DartSubTab = 'today' | 'goals' | 'thoughts'

const DAY_NAMES   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export default function DartView() {
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
        <button
          className={`activity-subtab${tab === 'thoughts' ? ' active' : ''}`}
          onClick={() => setTab('thoughts')}
        >💭 Thoughts</button>
      </div>

      {error ? (
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
      ) : tab === 'goals' ? (
        <GoalsPanel goals={goals} log={log} setGoals={setGoals} toast={toast} />
      ) : (
        <ThoughtsPanel toast={toast} />
      )}
    </div>
  )
}

type Toast = ReturnType<typeof useToast>['toast']

// ── Today ────────────────────────────────────────────────────────────────────

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

      {/* ── Side column: consistency ─────────────────────── */}
      <aside className="dart-side">
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

// ── Thoughts ─────────────────────────────────────────────────────────────────

function firstLine(s: string): string {
  const line = s.split('\n').map(x => x.trim()).find(Boolean) ?? ''
  return line.length > 90 ? line.slice(0, 87) + '…' : line
}

type ThoughtView = 'tree' | 'flat'

function ThoughtsPanel({ toast }: { toast: Toast }) {
  const [thoughts, setThoughts] = useState<DartThought[]>([])
  const [loading, setLoading]   = useState(true)
  const [draft, setDraft]       = useState('')
  const [saving, setSaving]     = useState(false)
  const [stage, setStage]       = useState('')          // what the AI is doing
  const [bucketFilter, setBF]   = useState<ThoughtBucket | 'all'>('all')
  const [pathFilter, setPF]     = useState<string>('')  // '' = everything
  const [search, setSearch]     = useState('')
  const [view, setView]         = useState<ThoughtView>('tree')
  // Starts collapsed: the composer and the cards are what the page is for, and
  // the tree is a filter you reach for rather than something to keep open.
  const [navCollapsed, setNav]  = useState(true)
  const [openRaw, setOpenRaw]   = useState<Set<string>>(new Set())
  const [openOrig, setOpenOrig] = useState<Set<string>>(new Set())
  const [busyId, setBusyId]     = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    loadThoughts()
      .then(list => { setThoughts(list); setLoading(false) })
      .catch(e => { setLoading(false); toast(`Load failed: ${(e as Error).message}`, 'error') })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Every path already in use — fed to the model so it files new thoughts into
  // the existing tree instead of growing a parallel branch each time.
  const knownPaths = useMemo(
    () => [...new Set(thoughts.map(t => t.path).filter(Boolean))].sort(),
    [thoughts],
  )

  // One pipeline for both "save new" and "re-process existing".
  async function process(raw: string): Promise<Omit<DartThought, 'id' | 'createdAt' | 'updatedAt'>> {
    const base = {
      date: isoDate(new Date()), raw, rawOriginal: raw,
      bucket: 'Other' as ThoughtBucket, summary: firstLine(raw),
      highlights: [] as string[], path: 'Unfiled', rich: '',
    }
    if (!LLM.isConfigured()) {
      toast('Saved unprocessed — add the Azure key in Settings to clean and sort thoughts.', 'info')
      return base
    }
    setStage('Cleaning up and filing…')
    const refined = await refineThought(raw, knownPaths)
    if (!refined) return base
    setStage('Building the visual card…')
    // A failed render must not lose a good clean-up, so it is caught separately.
    const rich = await renderThought(refined.cleaned).catch(() => '')
    return {
      ...base,
      raw: refined.cleaned, rawOriginal: raw,
      bucket: refined.bucket, summary: refined.summary || firstLine(refined.cleaned),
      highlights: refined.highlights, path: refined.path, rich,
    }
  }

  async function save() {
    const raw = draft.trim()
    if (!raw || saving) return
    setSaving(true)
    try {
      const fields = await process(raw)
      const t = await addThought(fields)
      setThoughts(prev => [t, ...prev])
      setDraft('')
      boxRef.current?.focus()
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false); setStage('')
    }
  }

  // Re-runs both passes from the ORIGINAL capture, never from an already
  // cleaned `raw` — repeated clean-ups of a clean-up drift away from what was
  // actually said.
  async function reprocess(t: DartThought) {
    if (busyId) return
    if (!LLM.isConfigured()) { toast('AI is not configured — add the Azure key in Settings.', 'error'); return }
    setBusyId(t.id)
    try {
      const fields = await process(t.rawOriginal || t.raw)
      const updated = await updateThought({ ...t, ...fields, date: t.date })
      setThoughts(prev => prev.map(x => x.id === updated.id ? updated : x))
    } catch (e) {
      toast(`Re-process failed: ${(e as Error).message}`, 'error')
    } finally {
      setBusyId(null); setStage('')
    }
  }

  async function setBucket(t: DartThought, bucket: ThoughtBucket) {
    try {
      const updated = await updateThought({ ...t, bucket })
      setThoughts(prev => prev.map(x => x.id === updated.id ? updated : x))
    } catch (e) { toast(`Save failed: ${(e as Error).message}`, 'error') }
  }

  async function movePath(t: DartThought) {
    const next = window.prompt(
      `Tree path for this thought (:: separated, max ${MAX_PATH_DEPTH} levels)`, t.path)
    if (next === null) return
    try {
      const updated = await updateThought({ ...t, path: next })
      setThoughts(prev => prev.map(x => x.id === updated.id ? updated : x))
    } catch (e) { toast(`Move failed: ${(e as Error).message}`, 'error') }
  }

  async function remove(t: DartThought) {
    if (!window.confirm('Delete this thought? The original capture goes with it.')) return
    try {
      await deleteThought(t.id)
      setThoughts(prev => prev.filter(x => x.id !== t.id))
    } catch (e) { toast(`Delete failed: ${(e as Error).message}`, 'error') }
  }

  function toggle(set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    set(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const bucketCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of thoughts) m.set(t.bucket, (m.get(t.bucket) ?? 0) + 1)
    return m
  }, [thoughts])

  // Reuses the ::-path trie that backs the Docs / AdsHub tag trees.
  const trie = useMemo(
    () => buildTrie(thoughts.map(t => (t.path ? [t.path] : []))),
    [thoughts],
  )
  const flatPaths = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of thoughts) if (t.path) m.set(t.path, (m.get(t.path) ?? 0) + 1)
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [thoughts])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return thoughts.filter(t =>
      (bucketFilter === 'all' || t.bucket === bucketFilter) &&
      // Selecting a branch includes everything beneath it.
      (!pathFilter || t.path === pathFilter || t.path.startsWith(pathFilter + '::')) &&
      (!q || t.raw.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q)
          || t.path.toLowerCase().includes(q)),
    )
  }, [thoughts, bucketFilter, pathFilter, search])

  return (
    <div className="dart-thoughts-wrap">
      {/* ── Left nav: the thought tree ───────────────────── */}
      {navCollapsed ? (
        <div className="th-nav-strip">
          <button className="th-strip-btn" onClick={() => setNav(false)} title="Show groups">
            <span className="th-strip-icon">▸</span>
            {/* Two captions for two shapes: a vertical word down the desktop
                rail, and a full-width bar naming the active filter when the
                layout stacks. Only ever one is visible. */}
            <span className="th-strip-vert">Groups</span>
            <span className="th-strip-label">
              Groups
              <b>{pathFilter ? pathFilter.split('::').slice(-1)[0] : 'All thoughts'}</b>
            </span>
            <span className="th-strip-n">{shown.length}</span>
          </button>
        </div>
      ) : (
        <div className="th-nav">
          <div className="th-nav-hd">
            <span>Thoughts</span>
            <button className="th-strip-btn" onClick={() => setNav(true)} title="Hide groups">
              <span className="th-strip-icon">◂</span>
              <span className="th-strip-label">Done</span>
            </button>
          </div>
          <div className="th-nav-modes">
            <button className={`th-mode${view === 'tree' ? ' active' : ''}`} onClick={() => setView('tree')}>Tree</button>
            <button className={`th-mode${view === 'flat' ? ' active' : ''}`} onClick={() => setView('flat')}>Flat</button>
          </div>
          <button
            className={`th-nav-all${pathFilter === '' ? ' active' : ''}`}
            onClick={() => setPF('')}
          >All thoughts <span className="tree-cnt">{thoughts.length}</span></button>

          <div className="th-nav-body">
            {view === 'tree' ? (
              Object.keys(trie.children).length === 0 ? (
                <div className="col-empty">No groups yet.</div>
              ) : (
                Object.entries(trie.children)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, node]) => (
                    <TreeNode
                      key={node.fullPath} name={name} node={node}
                      selected={pathFilter ? [pathFilter] : []}
                      onToggle={p => setPF(cur => cur === p ? '' : p)}
                      searchLower=""
                    />
                  ))
              )
            ) : flatPaths.length === 0 ? (
              <div className="col-empty">No groups yet.</div>
            ) : (
              <ul className="th-flat-list">
                {flatPaths.map(([path, n]) => (
                  <li key={path}>
                    <button
                      className={`th-flat-row${pathFilter === path ? ' active' : ''}`}
                      onClick={() => setPF(cur => cur === path ? '' : path)}
                      title={path}
                    >
                      <span className="th-flat-path">
                        {path.split('::').slice(0, -1).map(seg => (
                          <span className="th-flat-parent" key={seg}>{seg}::</span>
                        ))}
                        <span className="th-flat-leaf">{path.split('::').slice(-1)[0]}</span>
                      </span>
                      <span className="tree-cnt">{n}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ── Main column ──────────────────────────────────── */}
      <div className="dart-body dart-thoughts">
        <div className="dart-composer">
          <textarea
            ref={boxRef} className="dart-composer-box" rows={4} value={draft}
            placeholder="What's on your mind? Dump it raw — speech, typos and all. It gets cleaned up, filed in the tree, and turned into a visual card."
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() }}
          />
          <div className="dart-composer-foot">
            <span className="dart-hint">
              {saving && stage ? stage : '⌘/Ctrl + Enter to save · your original capture is always kept'}
            </span>
            <button className="mgmt-save-btn" disabled={!draft.trim() || saving} onClick={save}>
              {saving ? 'Processing…' : 'Save thought'}
            </button>
          </div>
        </div>

        <div className="dart-thought-filters">
          <button className={`dart-fchip${bucketFilter === 'all' ? ' active' : ''}`} onClick={() => setBF('all')}>
            All <span className="dart-fchip-n">{thoughts.length}</span>
          </button>
          {THOUGHT_BUCKETS.map(b => (
            <button
              key={b} className={`dart-fchip${bucketFilter === b ? ' active' : ''}`}
              onClick={() => setBF(b)}
            >{b} <span className="dart-fchip-n">{bucketCounts.get(b) ?? 0}</span></button>
          ))}
          <input
            className="rf-input dart-search" placeholder="Search…" value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {pathFilter && (
          <div className="th-crumb">
            {pathFilter.split('::').join(' › ')}
            <button className="dart-minibtn" onClick={() => setPF('')}>clear</button>
          </div>
        )}

        {loading ? (
          <div className="col-empty">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="col-empty">
            {thoughts.length === 0
              ? 'Nothing yet. Dump a thought above — it gets cleaned up, filed, and rendered as a card you can actually re-read.'
              : 'No thoughts match this filter.'}
          </div>
        ) : (
          <ul className="dart-thought-list">
            {shown.map(t => (
              <li className="dart-thought" key={t.id}>
                <div className="dart-thought-hd">
                  <span className="dart-thought-date">{t.date}</span>
                  <select
                    className="dart-bucket-select" value={t.bucket}
                    onChange={e => setBucket(t, e.target.value as ThoughtBucket)}
                  >
                    {THOUGHT_BUCKETS.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                  <button className="th-path-btn" onClick={() => movePath(t)} title="Change tree path">
                    {t.path ? t.path.split('::').join(' › ') : 'Unfiled'}
                  </button>
                  <span className="dart-thought-spacer" />
                  <button className="dart-minibtn" disabled={busyId === t.id} onClick={() => reprocess(t)}>
                    {busyId === t.id ? '…' : '✨ Re-process'}
                  </button>
                  <button className="dart-minibtn" onClick={() => toggle(setOpenRaw, t.id)}>
                    {openRaw.has(t.id) ? 'Hide text' : 'Text'}
                  </button>
                  <button className="dart-minibtn danger" onClick={() => remove(t)}>✕</button>
                </div>

                {t.summary && <div className="dart-thought-summary">{t.summary}</div>}

                {t.rich ? (
                  <div
                    className="th-rich"
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(t.rich) }}
                  />
                ) : (
                  t.highlights.length > 0 && (
                    <ul className="dart-highlights">
                      {t.highlights.map((h, i) => <li key={i}>{h}</li>)}
                    </ul>
                  )
                )}

                {t.rich && t.highlights.length > 0 && (
                  <ul className="dart-highlights">
                    {t.highlights.map((h, i) => <li key={i}>{h}</li>)}
                  </ul>
                )}

                {openRaw.has(t.id) && (
                  <div className="th-raw-wrap">
                    <div className="th-raw-hd">
                      <span>Cleaned capture</span>
                      {t.rawOriginal && t.rawOriginal !== t.raw && (
                        <button className="dart-minibtn" onClick={() => toggle(setOpenOrig, t.id)}>
                          {openOrig.has(t.id) ? 'Hide original' : 'Show original'}
                        </button>
                      )}
                    </div>
                    <pre className="dart-thought-raw">{t.raw}</pre>
                    {openOrig.has(t.id) && (
                      <>
                        <div className="th-raw-hd"><span>Original, exactly as captured</span></div>
                        <pre className="dart-thought-raw original">{t.rawOriginal}</pre>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
