import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addHourlyActivity, addReminder, addToDo, deleteActivity, deleteToDo,
  loadActivityForDate, loadAllActivities, loadToDos, updateToDo, upsertSingleton,
} from '../adapters/utilsRepo'
import type { ActivityEntry, ActivityKind, ToDoItem } from '../adapters/utilsRepo'
import { useToast } from '../components/Toast'

type SubTab = 'todo' | 'activity'

export default function UtilsView() {
  const [tab, setTab] = useState<SubTab>('todo')

  return (
    <div className="utils-wrap">
      <div className="utils-tabbar">
        <button
          className={`utils-tab${tab === 'todo' ? ' active' : ''}`}
          onClick={() => setTab('todo')}
        >✓ ToDo</button>
        <button
          className={`utils-tab${tab === 'activity' ? ' active' : ''}`}
          onClick={() => setTab('activity')}
        >📅 Activity Log</button>
      </div>

      <div className={`utils-body${tab === 'activity' ? ' utils-body-flush' : ''}`}>
        {tab === 'todo'     && <ToDoPanel />}
        {tab === 'activity' && <ActivityPanel />}
      </div>
    </div>
  )
}

// ── ToDo ─────────────────────────────────────────────────────────────────────

function ToDoPanel() {
  const { toast } = useToast()
  const [items, setItems] = useState<ToDoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState('')

  useEffect(() => {
    loadToDos()
      .then(list => { setItems(list); setLoading(false) })
      .catch(e => { setLoading(false); toast(`Load failed: ${(e as Error).message}`, 'error') })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const childrenOf = useMemo(() => {
    const m = new Map<string, ToDoItem[]>()
    items.forEach(t => {
      const list = m.get(t.parentId) ?? []
      list.push(t)
      m.set(t.parentId, list)
    })
    m.forEach(arr => arr.sort((a, b) => a.position - b.position))
    return m
  }, [items])

  async function add(parentId: string, title: string) {
    setBusy(true)
    try {
      const created = await addToDo(parentId, title)
      setItems(prev => [...prev, created])
    } catch (e) {
      toast(`Add failed: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }
  async function toggleDone(t: ToDoItem) {
    const updated = { ...t, done: !t.done }
    setItems(prev => prev.map(x => x.id === t.id ? updated : x))
    try { await updateToDo(updated) }
    catch (e) {
      setItems(prev => prev.map(x => x.id === t.id ? t : x))   // rollback
      toast(`Save failed: ${(e as Error).message}`, 'error')
    }
  }
  function startEdit(t: ToDoItem) { setEditingId(t.id); setEditingDraft(t.title) }
  async function commitEdit(t: ToDoItem) {
    const next = editingDraft.trim()
    setEditingId(null); setEditingDraft('')
    if (!next || next === t.title) return
    const updated = { ...t, title: next }
    setItems(prev => prev.map(x => x.id === t.id ? updated : x))
    try { await updateToDo(updated) }
    catch (e) { toast(`Rename failed: ${(e as Error).message}`, 'error') }
  }
  async function remove(t: ToDoItem) {
    const kids = (childrenOf.get(t.id) ?? []).length
    const msg  = kids > 0 ? `Delete "${t.title}" and ${kids} sub-task${kids === 1 ? '' : 's'}?`
                          : `Delete "${t.title}"?`
    if (!window.confirm(msg)) return
    try {
      await deleteToDo(t.id)
      const refreshed = await loadToDos()
      setItems(refreshed)
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'error')
    }
  }

  function renderTree(parentId: string): React.ReactElement {
    const list = childrenOf.get(parentId) ?? []
    return (
      <ul className={parentId === '' ? 'todo-list todo-list-root' : 'todo-list'}>
        {list.map(t => {
          const isEditing = editingId === t.id
          const kids = childrenOf.get(t.id) ?? []
          return (
            <li key={t.id} className={`todo-row${t.done ? ' done' : ''}`}>
              <div className="todo-line">
                <input
                  type="checkbox"
                  checked={t.done}
                  onChange={() => toggleDone(t)}
                />
                {isEditing ? (
                  <input
                    autoFocus
                    className="rf-input todo-rename-input"
                    value={editingDraft}
                    onChange={e => setEditingDraft(e.target.value)}
                    onBlur={() => commitEdit(t)}
                    onKeyDown={e => {
                      if (e.key === 'Enter')       { e.preventDefault(); commitEdit(t) }
                      else if (e.key === 'Escape') { e.preventDefault(); setEditingId(null) }
                    }}
                  />
                ) : (
                  <span
                    className="todo-title"
                    onDoubleClick={() => startEdit(t)}
                    title="Double-click to edit"
                  >{t.title}</span>
                )}
                <span className="todo-actions">
                  <button onClick={() => add(t.id, 'New sub-task')} disabled={busy} title="Add sub-task">＋</button>
                  <button onClick={() => remove(t)} disabled={busy} title="Delete" className="todo-rm">✕</button>
                </span>
              </div>
              {kids.length > 0 && renderTree(t.id)}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className="todo-panel">
      <form
        className="todo-add-row"
        onSubmit={e => {
          e.preventDefault()
          if (!draft.trim()) return
          add('', draft.trim())
          setDraft('')
        }}
      >
        <input
          className="rf-input"
          placeholder="Add a task and press Enter…"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          disabled={busy}
        />
        <button className="rf-btn-save" type="submit" disabled={busy || !draft.trim()}>Add</button>
      </form>
      {loading
        ? <div className="col-empty">Loading…</div>
        : items.length === 0
          ? <div className="col-empty">No tasks yet — add one above.</div>
          : renderTree('')}
    </div>
  )
}

// ── Activity Log ─────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type ActivitySideMode = 'recent' | 'reminder' | 'priority'

function ActivityPanel() {
  const { toast } = useToast()
  const today = new Date(); today.setHours(0,0,0,0)
  const [cursor, setCursor]           = useState<Date>(new Date(today))
  const [selected, setSelected]       = useState<string>(isoDate(today))
  const [entries, setEntries]         = useState<ActivityEntry[]>([])
  const [allEntries, setAllEntries]   = useState<ActivityEntry[]>([])
  const [loading, setLoading]         = useState(false)
  const [hourTime, setHourTime]       = useState('')
  const [hourText, setHourText]       = useState('')
  const [topTaskDraft, setTopTaskDraft] = useState('')
  const [winsDraft, setWinsDraft]     = useState('')
  const [improveDraft, setImproveDraft] = useState('')
  const [reminderDraft, setReminderDraft] = useState('')
  const [busy, setBusy]               = useState(false)

  // 3-pane controls (Notes-style).
  const [leftCollapsed, setLeftColl]  = useState(true)
  const [sideMode, setSideMode]       = useState<ActivitySideMode>('recent')
  const [col1Ratio, setCol1Ratio]     = useState(18)
  const [col2EndRatio, setCol2EndRatio] = useState(48)
  const [dayExpanded, setDayExpanded] = useState(false)
  const [calExpanded, setCalExpanded] = useState(false)
  // The two expand toggles are mutually exclusive — turning one on cancels
  // the other so the layout never gets into a weird half-state.
  function toggleCalExpand() {
    setCalExpanded(c => {
      const next = !c
      if (next) setDayExpanded(false)
      return next
    })
  }
  function toggleDayExpand() {
    setDayExpanded(d => {
      const next = !d
      if (next) setCalExpanded(false)
      return next
    })
  }
  const bodyWrapRef                   = useRef<HTMLDivElement>(null)
  const isLeftDragging                = useRef(false)
  const isMidDragging                 = useRef(false)

  // Load all activities (drives recent/reminder/priority + calendar markers).
  useEffect(() => {
    loadAllActivities()
      .then(setAllEntries)
      .catch(e => toast(`Load all activities failed: ${(e as Error).message}`, 'error'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load entries for the selected day.
  useEffect(() => {
    setLoading(true)
    loadActivityForDate(selected)
      .then(list => {
        setEntries(list)
        setTopTaskDraft(list.find(e => e.kind === 'top_task')?.content ?? '')
        setWinsDraft(list.find(e => e.kind === 'wins')?.content ?? '')
        setImproveDraft(list.find(e => e.kind === 'improvements')?.content ?? '')
      })
      .catch(e => toast(`Load failed: ${(e as Error).message}`, 'error'))
      .finally(() => setLoading(false))
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  const hourly = useMemo(
    () => entries.filter(e => e.kind === 'hourly').sort((a, b) => a.time.localeCompare(b.time)),
    [entries],
  )
  const monthCells = useMemo(() => buildMonthCells(cursor), [cursor])

  // Per-date markers: which kinds are present on each ISO date.
  const markersByDate = useMemo(() => {
    const m = new Map<string, { task: boolean; reminder: boolean; entry: boolean }>()
    for (const e of allEntries) {
      const cur = m.get(e.date) ?? { task: false, reminder: false, entry: false }
      if (e.kind === 'top_task' || e.kind === 'hourly') cur.task = true
      if (e.kind === 'reminder')                        cur.reminder = true
      cur.entry = true
      m.set(e.date, cur)
    }
    return m
  }, [allEntries])

  // Side-panel data
  const recent = useMemo(
    () => allEntries.slice().sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt)).slice(0, 30),
    [allEntries],
  )
  const reminders = useMemo(
    () => allEntries.filter(e => e.kind === 'reminder')
      .slice().sort((a, b) => a.date.localeCompare(b.date)),
    [allEntries],
  )
  const priorities = useMemo(
    () => allEntries.filter(e => e.kind === 'top_task')
      .slice().sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30),
    [allEntries],
  )

  // ── Mutations (refresh allEntries cache on each) ─────────────────────────
  function syncCache(updater: (prev: ActivityEntry[]) => ActivityEntry[]) {
    setAllEntries(updater)
  }

  async function saveSingleton(kind: ActivityKind, content: string) {
    setBusy(true)
    try {
      const e = await upsertSingleton(selected, kind, content)
      setEntries(prev => {
        const without = prev.filter(x => !(x.date === selected && x.kind === kind))
        return [...without, e]
      })
      syncCache(prev => {
        const without = prev.filter(x => !(x.date === selected && x.kind === kind))
        return [...without, e]
      })
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`, 'error')
    } finally { setBusy(false) }
  }
  async function addHourly() {
    if (!hourText.trim()) return
    setBusy(true)
    try {
      const e = await addHourlyActivity(selected, hourTime.trim(), hourText.trim())
      setEntries(prev => [...prev, e])
      syncCache(prev => [...prev, e])
      setHourTime(''); setHourText('')
    } catch (err) {
      toast(`Add failed: ${(err as Error).message}`, 'error')
    } finally { setBusy(false) }
  }
  async function removeEntry(e: ActivityEntry) {
    if (!window.confirm('Delete this entry?')) return
    try {
      await deleteActivity(e.id)
      setEntries(prev => prev.filter(x => x.id !== e.id))
      syncCache(prev => prev.filter(x => x.id !== e.id))
    } catch (err) {
      toast(`Delete failed: ${(err as Error).message}`, 'error')
    }
  }
  async function submitReminder() {
    const txt = reminderDraft.trim()
    if (!txt) return
    setBusy(true)
    try {
      const e = await addReminder(selected, txt)
      syncCache(prev => [...prev, e])
      setReminderDraft('')
      toast('Reminder saved', 'success')
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`, 'error')
    } finally { setBusy(false) }
  }

  // ── Dividers ─────────────────────────────────────────────────────────────
  function leftDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    isLeftDragging.current = true; document.body.classList.add('resizing-h')
  }
  function leftMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isLeftDragging.current) return
    const c = bodyWrapRef.current; if (!c) return
    const r = c.getBoundingClientRect()
    const pct = ((e.clientX - r.left) / r.width) * 100
    setCol1Ratio(Math.min(Math.max(pct, 12), Math.min(40, col2EndRatio - 12)))
  }
  function leftUp(e: React.PointerEvent<HTMLDivElement>) {
    isLeftDragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }
  function midDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    isMidDragging.current = true; document.body.classList.add('resizing-h')
  }
  function midMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isMidDragging.current) return
    const c = bodyWrapRef.current; if (!c) return
    const r = c.getBoundingClientRect()
    const pct = ((e.clientX - r.left) / r.width) * 100
    setCol2EndRatio(Math.min(Math.max(pct, Math.max(col1Ratio + 12, 28)), 80))
  }
  function midUp(e: React.PointerEvent<HTMLDivElement>) {
    isMidDragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  const col2Width = Math.max(0, col2EndRatio - col1Ratio)
  const todayIso  = isoDate(today)

  return (
    <div className="activity-3pane browse-body-wrap" ref={bodyWrapRef}>
      {/* ── Col 1: Recent / Reminder / Priority ─────────────────── */}
      {!dayExpanded && !calExpanded && (
        <div className={`browse-col-tags${leftCollapsed ? ' collapsed' : ''}`}
             style={leftCollapsed ? undefined : { width: `${col1Ratio}%` }}>
          {leftCollapsed ? (
            <div className="notes-strip">
              <button
                className={`notes-strip-btn${sideMode === 'recent' ? ' active' : ''}`}
                onClick={() => { setSideMode('recent'); setLeftColl(false) }}
                title="Recent"
              >🕐</button>
              <button
                className={`notes-strip-btn${sideMode === 'reminder' ? ' active' : ''}`}
                onClick={() => { setSideMode('reminder'); setLeftColl(false) }}
                title="Reminders"
              >⏰</button>
              <button
                className={`notes-strip-btn${sideMode === 'priority' ? ' active' : ''}`}
                onClick={() => { setSideMode('priority'); setLeftColl(false) }}
                title="Priorities"
              >⭐</button>
              <button
                className="notes-strip-btn"
                onClick={() => setLeftColl(false)}
                title="Expand"
              >▸</button>
            </div>
          ) : (
            <>
              <div className="left-tab-bar">
                {(['recent','reminder','priority'] as ActivitySideMode[]).map(m => (
                  <button
                    key={m}
                    className={`left-tab${sideMode === m ? ' active' : ''}`}
                    onClick={() => setSideMode(m)}
                  >{m === 'recent' ? 'Recent' : m === 'reminder' ? 'Reminder' : 'Priority'}</button>
                ))}
                <button className="panel-toggle-btn" onClick={() => setLeftColl(true)} title="Collapse">◂</button>
              </div>

              {sideMode === 'recent' && (
                <ul className="activity-side-list">
                  {recent.length === 0 && <li className="col-empty">Nothing yet</li>}
                  {recent.map(e => (
                    <li key={e.id} onClick={() => setSelected(e.date)}>
                      <div className="activity-side-title">{kindLabel(e.kind)} · {e.content || '(empty)'}</div>
                      <div className="activity-side-meta">{prettyDate(e.date)}</div>
                    </li>
                  ))}
                </ul>
              )}

              {sideMode === 'reminder' && (
                <ul className="activity-side-list">
                  {reminders.length === 0 && <li className="col-empty">No reminders</li>}
                  {reminders.map(e => (
                    <li key={e.id} onClick={() => setSelected(e.date)}>
                      <div className="activity-side-title">⏰ {e.content || '(empty)'}</div>
                      <div className="activity-side-meta">{prettyDate(e.date)}{e.date < todayIso ? ' · past' : e.date === todayIso ? ' · today' : ' · upcoming'}</div>
                    </li>
                  ))}
                </ul>
              )}

              {sideMode === 'priority' && (
                <ul className="activity-side-list">
                  {priorities.length === 0 && <li className="col-empty">No top tasks logged yet</li>}
                  {priorities.map(e => (
                    <li key={e.id} onClick={() => setSelected(e.date)}>
                      <div className="activity-side-title">⭐ {e.content || '(empty)'}</div>
                      <div className="activity-side-meta">{prettyDate(e.date)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {/* Divider 1 */}
      {!dayExpanded && !calExpanded && !leftCollapsed && (
        <div className="qa-divider"
             onPointerDown={leftDown} onPointerMove={leftMove}
             onPointerUp={leftUp} onPointerCancel={leftUp}/>
      )}

      {/* ── Col 2: month calendar with markers ───────────────────── */}
      {!dayExpanded && (
        <div
          className="activity-cal-col"
          style={{ width: calExpanded ? '100%' : `${col2Width}%` }}
        >
          <div
            className="activity-cal-hd"
            onDoubleClick={toggleCalExpand}
            title="Double-click to expand / restore the calendar"
          >
            <button
              className="rf-btn-cancel"
              onClick={() => setCursor(addMonths(cursor, -1))}
              onDoubleClick={e => e.stopPropagation()}
            >‹</button>
            <span className="activity-cal-title">{cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            <button
              className="rf-btn-cancel"
              onClick={() => setCursor(addMonths(cursor, +1))}
              onDoubleClick={e => e.stopPropagation()}
            >›</button>
            <button
              className="rf-btn-cancel"
              onClick={() => { setCursor(new Date(today)); setSelected(todayIso) }}
              onDoubleClick={e => e.stopPropagation()}
              title="Jump to today"
            >Today</button>
            <button
              className={`bci-edit-btn bci-edit-btn-hd${calExpanded ? ' active' : ''}`}
              onClick={toggleCalExpand}
              onDoubleClick={e => e.stopPropagation()}
              title={calExpanded ? 'Restore' : 'Expand calendar'}
            >{calExpanded ? '⤡' : '⤢'}</button>
          </div>
          <div className="activity-cal-grid">
            {['S','M','T','W','T','F','S'].map((d,i) => (
              <div key={`h${i}`} className="cal-dow">{d}</div>
            ))}
            {monthCells.map(c => {
              const iso = isoDate(c.date)
              const mk  = markersByDate.get(iso)
              return (
                <button
                  key={iso}
                  className={`cal-cell${c.outside ? ' outside' : ''}${iso === todayIso ? ' today' : ''}${iso === selected ? ' sel' : ''}`}
                  onClick={() => setSelected(iso)}
                  title={iso}
                >
                  <span className="cal-cell-day">{c.date.getDate()}</span>
                  {mk && (
                    <span className="cal-markers">
                      {mk.task     && <span className="cal-mk cal-mk-t" title="Tasks">T</span>}
                      {mk.reminder && <span className="cal-mk cal-mk-r" title="Reminder">R</span>}
                      {!mk.task && !mk.reminder && mk.entry && <span className="cal-mk cal-mk-dot">·</span>}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <div className="activity-cal-hint">
            <input
              type="date"
              value={selected}
              onChange={e => {
                setSelected(e.target.value)
                const d = new Date(`${e.target.value}T00:00`)
                if (!isNaN(d.getTime())) setCursor(d)
              }}
            />
          </div>
        </div>
      )}

      {/* Divider 2 */}
      {!dayExpanded && !calExpanded && (
        <div className="qa-divider"
             onPointerDown={midDown} onPointerMove={midMove}
             onPointerUp={midUp} onPointerCancel={midUp}/>
      )}

      {/* ── Col 3: day editor ─────────────────────────────────────── */}
      {!calExpanded && (
      <div className="browse-main">
        <div className="col-hd doc-detail-hd activity-day-bar"
             onDoubleClick={() => toggleDayExpand()}
             title="Double-click to expand / restore">
          <span style={{ fontWeight: 600 }}>{prettyDate(selected)}</span>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}
               onDoubleClick={e => e.stopPropagation()}>
            <button
              className={`bci-edit-btn bci-edit-btn-hd${dayExpanded ? ' active' : ''}`}
              onClick={() => toggleDayExpand()}
              title={dayExpanded ? 'Restore' : 'Expand viewer'}
            >{dayExpanded ? '⤡' : '⤢'}</button>
            <button
              className="detail-close-btn"
              onClick={() => { setSelected(todayIso); setCursor(new Date(today)); setDayExpanded(false) }}
              title="Jump to today"
            >Today</button>
          </div>
        </div>
        <div className="activity-day-body">
          {loading ? (
            <div className="col-empty">Loading…</div>
          ) : (
            <>
              <SingletonField
                label="Top task to accomplish"
                value={topTaskDraft}
                onChange={setTopTaskDraft}
                onSave={() => saveSingleton('top_task', topTaskDraft)}
                busy={busy}
                placeholder="What's the most important thing today?"
              />

              <h4 className="activity-section-hd">Reminders</h4>
              <ul className="activity-hourly-list">
                {entries.filter(e => e.kind === 'reminder').length === 0 &&
                  <li className="col-empty">No reminders for this day.</li>}
                {entries.filter(e => e.kind === 'reminder').map(e => (
                  <li key={e.id} className="activity-hourly-row">
                    <span className="activity-hour-time">⏰</span>
                    <span className="activity-hour-text">{e.content}</span>
                    <button className="todo-rm" onClick={() => removeEntry(e)} title="Delete">✕</button>
                  </li>
                ))}
              </ul>
              <div className="activity-hour-add">
                <input
                  className="rf-input"
                  placeholder="Add a reminder for this day…"
                  value={reminderDraft}
                  onChange={e => setReminderDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitReminder() } }}
                  disabled={busy}
                />
                <button
                  className="rf-btn-save"
                  onClick={submitReminder}
                  disabled={busy || !reminderDraft.trim()}
                >Add</button>
              </div>

              <h4 className="activity-section-hd">Hourly activity</h4>
              <ul className="activity-hourly-list">
                {hourly.length === 0 && <li className="col-empty">No entries yet.</li>}
                {hourly.map(e => (
                  <li key={e.id} className="activity-hourly-row">
                    <span className="activity-hour-time">{e.time || '—'}</span>
                    <span className="activity-hour-text">{e.content}</span>
                    <button className="todo-rm" onClick={() => removeEntry(e)} title="Delete">✕</button>
                  </li>
                ))}
              </ul>
              <div className="activity-hour-add">
                <input
                  type="time"
                  value={hourTime}
                  onChange={e => setHourTime(e.target.value)}
                  disabled={busy}
                />
                <input
                  className="rf-input"
                  placeholder="What happened? (free text)"
                  value={hourText}
                  onChange={e => setHourText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addHourly() } }}
                  disabled={busy}
                />
                <button
                  className="rf-btn-save"
                  onClick={addHourly}
                  disabled={busy || !hourText.trim()}
                >Add</button>
              </div>

              <SingletonField
                label="What went well"
                value={winsDraft}
                onChange={setWinsDraft}
                onSave={() => saveSingleton('wins', winsDraft)}
                busy={busy}
                multiline
                placeholder="Wins, progress, anything that worked"
              />
              <SingletonField
                label="Where can I improve"
                value={improveDraft}
                onChange={setImproveDraft}
                onSave={() => saveSingleton('improvements', improveDraft)}
                busy={busy}
                multiline
                placeholder="What I'd do differently next time"
              />
            </>
          )}
        </div>
      </div>
      )}
    </div>
  )
}

function kindLabel(k: ActivityKind): string {
  return k === 'top_task'    ? '⭐'
       : k === 'reminder'    ? '⏰'
       : k === 'wins'        ? '✓'
       : k === 'improvements'? '↻'
       : '•'
}

function SingletonField({
  label, value, onChange, onSave, busy, multiline, placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onSave:   () => void
  busy:     boolean
  multiline?: boolean
  placeholder?: string
}) {
  return (
    <div className="activity-singleton">
      <label className="activity-singleton-lbl">{label}</label>
      {multiline ? (
        <textarea
          className="rf-textarea"
          rows={3}
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={onSave}
          disabled={busy}
          placeholder={placeholder}
        />
      ) : (
        <input
          className="rf-input"
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={onSave}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onSave() } }}
          disabled={busy}
          placeholder={placeholder}
        />
      )}
    </div>
  )
}

// ── Calendar helpers ─────────────────────────────────────────────────────────

function buildMonthCells(cursor: Date): { date: Date; outside: boolean }[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const startDow = first.getDay()                                // 0..6 (Sun..Sat)
  const start = new Date(first); start.setDate(first.getDate() - startDow)
  const cells: { date: Date; outside: boolean }[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i)
    cells.push({ date: d, outside: d.getMonth() !== cursor.getMonth() })
  }
  return cells
}

function addMonths(d: Date, n: number): Date {
  const c = new Date(d)
  c.setDate(1)
  c.setMonth(c.getMonth() + n)
  return c
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00`)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}
