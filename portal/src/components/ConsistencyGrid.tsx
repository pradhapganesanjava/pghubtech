// 3½ months of consistency, as a GitHub-style shaded grid.
//
// One column per week (Monday at the top), one cell per day, shaded by how much
// time was logged. A ring marks a day where the whole routine was ticked —
// that is the habit half of consistency, which raw minutes alone would hide.
// Clicking a cell drives the Today view's date, so the grid doubles as the
// date picker; ‹ › slide the window back through history.

import { useMemo, useState } from 'react'
import type { DartLogEntry, DartRoutine } from '../adapters/dartRepo'
import { fmtMins, isoDate, parseIso } from '../lib/dartPlan'

// The window sits around today rather than ending at it: recent history to
// judge consistency by, plus the runway ahead, where the goal deadlines live.
const DAYS_BEFORE = 45
const DAYS_AFTER  = 15
const SLIDE_STEP  = 3               // weeks moved per arrow press
const MONTHS     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DOW        = ['M','','W','','F','','']

export interface DayStat {
  date:     string
  minutes:  number
  units:    number
  ticks:    number     // routines completed
  goalMins: number
}

// Shade bands. Deliberately coarse — the grid answers "did I show up, and
// roughly how hard", not "exactly how many minutes".
function shortDate(iso: string): string {
  const d = parseIso(iso)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

function level(m: number): number {
  if (m <= 0)   return 0
  if (m < 30)   return 1
  if (m < 90)   return 2
  if (m < 180)  return 3
  return 4
}

export function buildDayStats(log: DartLogEntry[]): Map<string, DayStat> {
  const m = new Map<string, DayStat>()
  for (const e of log) {
    const d = m.get(e.date) ?? { date: e.date, minutes: 0, units: 0, ticks: 0, goalMins: 0 }
    d.minutes += e.minutes
    d.units   += e.units
    if (e.kind === 'routine') d.ticks += 1
    else                      d.goalMins += e.minutes
    m.set(e.date, d)
  }
  return m
}

// Consecutive days with any activity, counting back from today. Today not yet
// started doesn't break a streak — the day isn't over — so it counts back from
// yesterday in that case.
export function streakOf(stats: Map<string, DayStat>, todayIso: string): number {
  const has = (iso: string) => (stats.get(iso)?.minutes ?? 0) > 0
  const cur = parseIso(todayIso)
  if (!has(todayIso)) cur.setDate(cur.getDate() - 1)
  let n = 0
  for (;;) {
    if (!has(isoDate(cur))) break
    n++
    cur.setDate(cur.getDate() - 1)
  }
  return n
}

interface Props {
  log:          DartLogEntry[]
  routines:     DartRoutine[]
  selectedDate: string
  onSelectDate: (iso: string) => void
}

export default function ConsistencyGrid({ log, routines, selectedDate, onSelectDate }: Props) {
  // How many weeks back the window is scrolled. 0 = ending this week.
  const [offset, setOffset] = useState(0)
  const todayIso = isoDate(new Date())

  const stats       = useMemo(() => buildDayStats(log), [log])
  const routineTotal = routines.filter(r => r.active).length

  // Columns run oldest → newest, each a Monday→Sunday week. The requested span
  // (today −45 … +15) is padded out to whole weeks so a cell's row is always
  // its weekday — that alignment is what makes "I always skip Sundays" visible.
  const columns = useMemo(() => {
    const shift = offset * 7
    const first = new Date(); first.setDate(first.getDate() - DAYS_BEFORE - shift)
    first.setDate(first.getDate() - ((first.getDay() + 6) % 7))     // back to Monday
    const last  = new Date(); last.setDate(last.getDate() + DAYS_AFTER - shift)
    last.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)))  // on to Sunday

    const weeks = Math.round((last.getTime() - first.getTime()) / 86400000 + 1) / 7
    const cols: string[][] = []
    for (let w = 0; w < weeks; w++) {
      const monday = new Date(first)
      monday.setDate(first.getDate() + w * 7)
      const week: string[] = []
      for (let d = 0; d < 7; d++) {
        const day = new Date(monday)
        day.setDate(monday.getDate() + d)
        week.push(isoDate(day))
      }
      cols.push(week)
    }
    return cols
  }, [offset])

  const firstDay = columns[0][0]
  const lastDay  = columns[columns.length - 1][6]

  const windowStats = useMemo(() => {
    let active = 0, minutes = 0, fullRoutine = 0
    for (const col of columns) for (const iso of col) {
      if (iso > todayIso) continue
      const s = stats.get(iso)
      if (!s) continue
      if (s.minutes > 0) active++
      minutes += s.minutes
      if (routineTotal > 0 && s.ticks >= routineTotal) fullRoutine++
    }
    return { active, minutes, fullRoutine }
  }, [columns, stats, todayIso, routineTotal])

  const streak = useMemo(() => streakOf(stats, todayIso), [stats, todayIso])

  // A month label sits above the first column belonging to a new month. The
  // month is taken from the column's MIDWEEK day, not its Monday: a week
  // running Aug 31 → Sep 6 is a September column, and keying off the Monday
  // would drop the current month's label entirely.
  const monthLabels = columns.map((col, i) => {
    const m = parseIso(col[3]).getMonth()
    if (i === 0) return MONTHS[m]
    return m !== parseIso(columns[i - 1][3]).getMonth() ? MONTHS[m] : ''
  })

  return (
    <div className="cg-wrap">
      <div className="cg-hd">
        <span className="cg-title">Consistency</span>
        <div className="cg-nav">
          <button className="cg-navbtn" onClick={() => setOffset(o => o + SLIDE_STEP)} title="Earlier">‹</button>
          <button
            className="cg-navbtn" disabled={offset === 0}
            onClick={() => setOffset(o => Math.max(0, o - SLIDE_STEP))} title="Later"
          >›</button>
          {offset !== 0 && (
            <button className="cg-now" onClick={() => setOffset(0)}>now</button>
          )}
        </div>
      </div>
      <div
        className="cg-range"
        title={`Showing ${firstDay} → ${lastDay}. The requested ${DAYS_BEFORE} days back and `
             + `${DAYS_AFTER} ahead are padded out to whole Monday–Sunday weeks so every `
             + `row stays a weekday.`}
      >
        <span>{shortDate(firstDay)} – {shortDate(lastDay)}</span>
        {offset === 0 && (
          <span className="cg-range-note">{DAYS_BEFORE}d back · {DAYS_AFTER}d ahead</span>
        )}
      </div>

      <div className="cg-stats">
        <div className="cg-stat"><b>{streak}</b><span>day streak</span></div>
        <div className="cg-stat"><b>{windowStats.active}</b><span>active days</span></div>
        <div className="cg-stat"><b>{fmtMins(windowStats.minutes)}</b><span>logged</span></div>
      </div>

      <div className="cg-scroll">
        <div className="cg-months">
          <span className="cg-dowcol" />
          {monthLabels.map((m, i) => <span className="cg-month" key={i}>{m}</span>)}
        </div>
        <div className="cg-body">
          <div className="cg-dowcol">
            {DOW.map((d, i) => <span className="cg-dow" key={i}>{d}</span>)}
          </div>
          {columns.map((week, wi) => (
            <div className="cg-col" key={wi}>
              {week.map(iso => {
                const s      = stats.get(iso)
                const future = iso > todayIso
                const full   = !!s && routineTotal > 0 && s.ticks >= routineTotal
                const cls = [
                  'cg-cell',
                  `l${future ? 0 : level(s?.minutes ?? 0)}`,
                  future ? 'future' : '',
                  full ? 'full' : '',
                  iso === selectedDate ? 'sel' : '',
                  iso === todayIso ? 'today' : '',
                ].filter(Boolean).join(' ')
                const title = future ? `${iso} · upcoming` : [
                  iso,
                  s?.minutes ? fmtMins(s.minutes) : 'nothing logged',
                  s?.ticks ? `${s.ticks}/${routineTotal} routine` : '',
                  s?.units ? `${Math.round(s.units)} units of work` : '',
                ].filter(Boolean).join(' · ')
                return (
                  <button
                    key={iso} className={cls} title={title}
                    onClick={() => onSelectDate(iso)}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="cg-legend">
        <span>less</span>
        {[0, 1, 2, 3, 4].map(l => <span className={`cg-cell l${l}`} key={l} />)}
        <span>more</span>
      </div>
      <div className="cg-legend cg-legend-ring">
        <span className="cg-cell l2 full" /><span>full routine ({windowStats.fullRoutine} days)</span>
      </div>
    </div>
  )
}
