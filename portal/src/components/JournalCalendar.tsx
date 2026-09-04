// Which days have a journal, at a glance.
//
// Defaults to today −15 … +15 as a day grid; the window widens to 3, 6 or 12
// months to answer the different question — not "what did I write on Tuesday"
// but "am I actually keeping this up". Past days with nothing written are the
// point of the view, so they are drawn, not omitted.

import { useEffect, useMemo, useState } from 'react'
import { isoDate, parseIso } from '../lib/dartPlan'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DOW    = ['M','','W','','F','','']

export interface Window { key: string; label: string; before: number; after: number }

export const WINDOWS: Window[] = [
  { key: '30d', label: '±15 days', before: 15,  after: 15 },
  { key: '3m',  label: '3 months', before: 90,  after: 0 },
  { key: '6m',  label: '6 months', before: 180, after: 0 },
  { key: '1y',  label: '1 year',   before: 365, after: 0 },
]

interface Props {
  dates:       Set<string>          // days that have an entry
  selected:    string
  onSelect:    (iso: string) => void
  windowKey:   string
  onWindow:    (key: string) => void
  /** Reported upward so the insight generator can use the same range. */
  onRangeChange?: (from: string, to: string) => void
}

export default function JournalCalendar({
  dates, selected, onSelect, windowKey, onWindow, onRangeChange,
}: Props) {
  const [offset, setOffset] = useState(0)          // weeks scrolled back
  const win = WINDOWS.find(w => w.key === windowKey) ?? WINDOWS[0]
  const todayIso = isoDate(new Date())

  const columns = useMemo(() => {
    const shift = offset * 7
    const first = new Date(); first.setDate(first.getDate() - win.before - shift)
    first.setDate(first.getDate() - ((first.getDay() + 6) % 7))          // back to Monday
    const last  = new Date(); last.setDate(last.getDate() + win.after - shift)
    last.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)))       // on to Sunday
    const weeks = Math.round((last.getTime() - first.getTime()) / 86400000 + 1) / 7
    const cols: string[][] = []
    for (let w = 0; w < weeks; w++) {
      const monday = new Date(first); monday.setDate(first.getDate() + w * 7)
      cols.push(Array.from({ length: 7 }, (_, d) => {
        const day = new Date(monday); day.setDate(monday.getDate() + d)
        return isoDate(day)
      }))
    }
    return cols
  }, [offset, win])

  const from = columns[0][0]
  const to   = columns[columns.length - 1][6]

  // Written / missed only ever counts days that have actually happened.
  const stats = useMemo(() => {
    let written = 0, elapsed = 0
    for (const col of columns) for (const iso of col) {
      if (iso > todayIso) continue
      elapsed++
      if (dates.has(iso)) written++
    }
    const pct = elapsed === 0 ? 0 : Math.round((written / elapsed) * 100)
    return { written, elapsed, missed: elapsed - written, pct }
  }, [columns, dates, todayIso])

  const streak = useMemo(() => {
    const cur = parseIso(todayIso)
    if (!dates.has(todayIso)) cur.setDate(cur.getDate() - 1)
    let n = 0
    while (dates.has(isoDate(cur))) { n++; cur.setDate(cur.getDate() - 1) }
    return n
  }, [dates, todayIso])

  // In an effect, not in render: this sets state in the parent, and doing that
  // mid-render warns and can loop.
  useEffect(() => { onRangeChange?.(from, to) }, [from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  const monthLabels = columns.map((col, i) => {
    const m = parseIso(col[3]).getMonth()
    if (i === 0) return MONTHS[m]
    return m !== parseIso(columns[i - 1][3]).getMonth() ? MONTHS[m] : ''
  })
  const dense = columns.length > 20      // long windows need smaller cells

  return (
    <div className="cg-wrap jc-wrap">
      <div className="cg-hd">
        <span className="cg-title">Journalled</span>
        <div className="cg-nav">
          <button className="cg-navbtn" onClick={() => setOffset(o => o + 4)} title="Earlier">‹</button>
          <button
            className="cg-navbtn" disabled={offset === 0}
            onClick={() => setOffset(o => Math.max(0, o - 4))} title="Later"
          >›</button>
          {offset !== 0 && <button className="cg-now" onClick={() => setOffset(0)}>now</button>}
        </div>
      </div>

      <div className="jc-windows">
        {WINDOWS.map(w => (
          <button
            key={w.key} className={`th-mode${w.key === windowKey ? ' active' : ''}`}
            onClick={() => { onWindow(w.key); setOffset(0) }}
          >{w.label}</button>
        ))}
      </div>

      <div className="cg-stats">
        <div className="cg-stat"><b>{streak}</b><span>day streak</span></div>
        <div className="cg-stat"><b>{stats.written}</b><span>written</span></div>
        <div className="cg-stat"><b>{stats.pct}%</b><span>of days</span></div>
      </div>

      <div className="cg-scroll">
        <div className="cg-months">
          <span className="cg-dowcol" />
          {monthLabels.map((m, i) => (
            <span className={`cg-month${dense ? ' dense' : ''}`} key={i}>{m}</span>
          ))}
        </div>
        <div className="cg-body">
          <div className="cg-dowcol">{DOW.map((d, i) => <span className="cg-dow" key={i}>{d}</span>)}</div>
          {columns.map((week, wi) => (
            <div className="cg-col" key={wi}>
              {week.map(iso => {
                const has    = dates.has(iso)
                const future = iso > todayIso
                const cls = [
                  'cg-cell', dense ? 'dense' : '',
                  has ? 'l4' : future ? 'future' : 'l0',
                  !has && !future ? 'missed' : '',
                  iso === selected ? 'sel' : '',
                  iso === todayIso ? 'today' : '',
                ].filter(Boolean).join(' ')
                return (
                  <button
                    key={iso} className={cls}
                    title={`${iso}${future ? '' : has ? ' · journalled' : ' · nothing written'}`}
                    onClick={() => onSelect(iso)}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="cg-legend">
        <span className="cg-cell l4" /><span>written</span>
        <span className="cg-cell l0 missed" /><span>missed</span>
        <span className="cg-cell future" /><span>ahead</span>
      </div>
    </div>
  )
}
