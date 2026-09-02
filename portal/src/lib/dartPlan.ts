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
