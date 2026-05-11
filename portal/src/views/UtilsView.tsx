import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addHourlyActivity, addLesson, addReminder, addToDo, addToDoComment,
  appendToDoTreeBatch,
  deleteActivity, deleteLesson, deleteToDo, deleteToDoComment,
  loadActivitiesInRange, loadActivityForDate, loadAllActivities, loadAllToDoComments,
  loadLessons, loadToDos, updateLesson, updateToDo, updateToDoComment,
  upsertSingleton,
} from '../adapters/utilsRepo'
import type { ActivityEntry, ActivityKind, Lesson, ToDoComment, ToDoItem } from '../adapters/utilsRepo'
import { useToast } from '../components/Toast'
import EphemeralAIChat from '../components/EphemeralAIChat'
import { LLM } from '../lib/llm'
import { generateToDoHierarchy } from '../lib/todoGen'
import type { ToDoDraft } from '../lib/todoGen'

type SubTab = 'todo' | 'activity'

export default function UtilsView() {
  const [tab, setTab] = useState<SubTab>('activity')

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

      <div className={`utils-body${tab === 'activity' || tab === 'todo' ? ' utils-body-flush' : ''}`}>
        {tab === 'todo'     && <ToDoPanel />}
        {tab === 'activity' && <ActivityPanel />}
      </div>
    </div>
  )
}

// ── ToDo (3-pane: Actions | Tree/List | Detail) ──────────────────────────────

type TodoView = 'tree' | 'flat'

function ToDoPanel() {
  const { toast } = useToast()
  const [items, setItems]                 = useState<ToDoItem[]>([])
  const [comments, setComments]           = useState<ToDoComment[]>([])
  const [loading, setLoading]             = useState(true)
  const [busy, setBusy]                   = useState(false)
  const [selectedId, setSelectedId]       = useState<string | null>(null)
  const [viewMode, setViewMode]           = useState<TodoView>('tree')
  const [filter, setFilter]               = useState('')
  const [showDone, setShowDone]           = useState(true)
  const [manageMode, setManageMode]       = useState(false)
  const [manageSel, setManageSel]         = useState<Set<string>>(new Set())
  const [bulkMoveOpen, setBulkMoveOpen]   = useState(false)
  const [bulkMoveParent, setBulkMoveParent] = useState('')

  // AI generate
  const [genCtx, setGenCtx]               = useState('')
  const [genBusy, setGenBusy]             = useState(false)
  const [genErr, setGenErr]               = useState('')
  const [genDrafts, setGenDrafts]         = useState<ToDoDraft[] | null>(null)
  const [genRoot, setGenRoot]             = useState<{ title: string; description: string } | null>(null)
  const [genRaw, setGenRaw]               = useState('')   // raw LLM reply for debug surfacing

  // Actions (left) column starts hidden — strip with ▸ / ＋ / ✨ icons.
  const [actionsCollapsed, setActionsCollapsed] = useState(true)

  // Collapse / expand state for the middle tree (per todo id).
  const [collapsed, setCollapsed]         = useState<Set<string>>(new Set())
  function toggleCollapse(id: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function collapseAllParents() {
    const all = new Set<string>()
    for (const t of items) {
      if ((childrenOf.get(t.id) ?? []).length > 0) all.add(t.id)
    }
    setCollapsed(all)
  }
  function expandAll() { setCollapsed(new Set()) }

  // Detail-pane edit toggles
  const [descEditing, setDescEditing]     = useState(false)
  const [descDraft, setDescDraft]         = useState('')
  const [titleEditing, setTitleEditing]   = useState(false)
  const [titleDraft, setTitleDraft]       = useState('')
  const [moveOpen, setMoveOpen]           = useState(false)
  const [moveParent, setMoveParent]       = useState('')

  // Comment composer
  const [newCommentDraft, setNewCommentDraft] = useState('')
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editingCommentDraft, setEditingCommentDraft] = useState('')

  // Draggable dividers
  const [col1Width, setCol1Width] = useState(220)
  const [col2Width, setCol2Width] = useState(360)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragLeft  = useRef(false)
  const dragRight = useRef(false)

  useEffect(() => {
    Promise.all([loadToDos(), loadAllToDoComments()])
      .then(([list, cs]) => {
        setItems(list)
        setComments(cs)
        // Land fully collapsed: every distinct non-empty parentId in the
        // list is, by definition, a parent that has children — so adding
        // them all to `collapsed` hides every subtree until the user opens
        // one explicitly.
        const parents = new Set<string>()
        for (const t of list) if (t.parentId) parents.add(t.parentId)
        setCollapsed(parents)
        setLoading(false)
      })
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

  const itemsById = useMemo(() => {
    const m = new Map<string, ToDoItem>()
    for (const t of items) m.set(t.id, t)
    return m
  }, [items])

  const selected = selectedId ? itemsById.get(selectedId) ?? null : null

  // Rebuild title/desc drafts when selection or item changes externally.
  useEffect(() => {
    setTitleEditing(false); setDescEditing(false)
    setMoveOpen(false); setEditingCommentId(null)
    setDescDraft(selected?.description ?? '')
    setTitleDraft(selected?.title ?? '')
    setMoveParent(selected?.parentId ?? '')
  }, [selectedId, selected?.id])

  // Comments for the selected todo, sorted newest-first.
  const selectedComments = useMemo(
    () => selected
      ? comments.filter(c => c.todoId === selected.id)
                .slice().sort((a, b) => (b.createdAt).localeCompare(a.createdAt))
      : [],
    [comments, selected],
  )

  // Filter — title or description match. Tree view: keep ancestors of any
  // matching node so the path stays visible.
  const filterLower = filter.trim().toLowerCase()
  const matches = useMemo(() => {
    const out = new Set<string>()
    for (const t of items) {
      if (!showDone && t.done) continue
      const hay = `${t.title} ${t.description ?? ''}`.toLowerCase()
      if (!filterLower || hay.includes(filterLower)) out.add(t.id)
    }
    if (filterLower || !showDone) {
      // Walk up ancestors so the tree renders the path.
      const expand = new Set(out)
      for (const id of out) {
        let cur = itemsById.get(id)
        while (cur && cur.parentId) {
          expand.add(cur.parentId)
          cur = itemsById.get(cur.parentId)
        }
      }
      return expand
    }
    return null   // null means no filter active
  }, [items, filterLower, showDone, itemsById])

  const visibleFlat = useMemo(() => {
    return items
      .filter(t => (showDone || !t.done))
      .filter(t => !filterLower || `${t.title} ${t.description ?? ''}`.toLowerCase().includes(filterLower))
      .sort((a, b) => (a.title.toLowerCase()).localeCompare(b.title.toLowerCase()))
  }, [items, showDone, filterLower])

  // ── Mutations ─────────────────────────────────────────────────────────
  async function addTopLevel() {
    setBusy(true)
    try {
      const created = await addToDo('', 'New task')
      setItems(prev => [...prev, created])
      setSelectedId(created.id)
      setTitleEditing(true); setTitleDraft(created.title)
    } catch (e) { toast(`Add failed: ${(e as Error).message}`, 'error') }
    finally { setBusy(false) }
  }

  async function addChild(parentId: string) {
    setBusy(true)
    try {
      const created = await addToDo(parentId, 'New sub-task')
      setItems(prev => [...prev, created])
      setSelectedId(created.id)
    } catch (e) { toast(`Add failed: ${(e as Error).message}`, 'error') }
    finally { setBusy(false) }
  }

  async function toggleDone(t: ToDoItem) {
    const updated = { ...t, done: !t.done }
    setItems(prev => prev.map(x => x.id === t.id ? updated : x))
    try { await updateToDo(updated) }
    catch (e) {
      setItems(prev => prev.map(x => x.id === t.id ? t : x))
      toast(`Save failed: ${(e as Error).message}`, 'error')
    }
  }

  async function saveTitle() {
    if (!selected) return
    const next = titleDraft.trim()
    if (!next || next === selected.title) { setTitleEditing(false); return }
    const updated = { ...selected, title: next }
    setItems(prev => prev.map(x => x.id === updated.id ? updated : x))
    setTitleEditing(false)
    try { await updateToDo(updated) }
    catch (e) { toast(`Rename failed: ${(e as Error).message}`, 'error') }
  }

  async function saveDescription() {
    if (!selected) return
    const next = descDraft
    if (next === (selected.description ?? '')) { setDescEditing(false); return }
    const updated = { ...selected, description: next }
    setItems(prev => prev.map(x => x.id === updated.id ? updated : x))
    setDescEditing(false)
    try { await updateToDo(updated) }
    catch (e) { toast(`Save failed: ${(e as Error).message}`, 'error') }
  }

  async function moveSelected() {
    if (!selected) return
    if (moveParent === selected.parentId) { setMoveOpen(false); return }
    if (isDescendant(selected.id, moveParent, childrenOf)) {
      toast('Cannot move under its own descendant', 'error'); return
    }
    const updated = { ...selected, parentId: moveParent }
    setItems(prev => prev.map(x => x.id === updated.id ? updated : x))
    setMoveOpen(false)
    try { await updateToDo(updated) }
    catch (e) { toast(`Move failed: ${(e as Error).message}`, 'error') }
  }

  function toggleManage() {
    setManageMode(m => !m)
    setManageSel(new Set())
    setBulkMoveOpen(false)
  }
  function toggleSel(id: string) {
    setManageSel(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function moveSibling(t: ToDoItem, dir: -1 | 1) {
    const siblings = (childrenOf.get(t.parentId) ?? []).slice().sort((a, b) => a.position - b.position)
    const idx = siblings.findIndex(s => s.id === t.id)
    const swapIdx = idx + dir
    if (swapIdx < 0 || swapIdx >= siblings.length) return
    const other = siblings[swapIdx]
    const a = { ...t, position: other.position }
    const b = { ...other, position: t.position }
    setItems(prev => prev.map(x => x.id === a.id ? a : x.id === b.id ? b : x))
    try { await Promise.all([updateToDo(a), updateToDo(b)]) }
    catch (e) {
      // Rollback on failure.
      setItems(prev => prev.map(x => x.id === t.id ? t : x.id === other.id ? other : x))
      toast(`Reorder failed: ${(e as Error).message}`, 'error')
    }
  }

  async function bulkDelete() {
    if (manageSel.size === 0 || busy) return
    if (!window.confirm(`Delete ${manageSel.size} item${manageSel.size === 1 ? '' : 's'} and any sub-tasks?`)) return
    setBusy(true)
    try {
      for (const id of manageSel) await deleteToDo(id)
      const refreshed = await loadToDos()
      setItems(refreshed)
      if (selectedId && !refreshed.find(x => x.id === selectedId)) setSelectedId(null)
      const n = manageSel.size
      setManageSel(new Set())
      toast(`Deleted ${n} item${n === 1 ? '' : 's'}`, 'success')
    } catch (e) { toast(`Delete failed: ${(e as Error).message}`, 'error') }
    finally { setBusy(false) }
  }

  async function bulkMove() {
    if (manageSel.size === 0 || busy) return
    // Drop selections that would land under their own descendant or themselves.
    const toMove = items.filter(t => manageSel.has(t.id)).filter(t =>
      t.id !== bulkMoveParent && !isDescendant(t.id, bulkMoveParent, childrenOf),
    )
    if (toMove.length === 0) {
      toast('No valid items to move (would form a cycle).', 'error'); return
    }
    setBusy(true)
    try {
      const destSiblings = (childrenOf.get(bulkMoveParent) ?? []).filter(c => !manageSel.has(c.id))
      let nextPos = destSiblings.length > 0 ? Math.max(...destSiblings.map(s => s.position)) + 1 : 0
      const updated = toMove.map(t => ({ ...t, parentId: bulkMoveParent, position: nextPos++ }))
      setItems(prev => prev.map(x => updated.find(u => u.id === x.id) ?? x))
      for (const u of updated) await updateToDo(u)
      setManageSel(new Set())
      setBulkMoveOpen(false)
      toast(`Moved ${updated.length} item${updated.length === 1 ? '' : 's'}`, 'success')
    } catch (e) {
      toast(`Move failed: ${(e as Error).message}`, 'error')
      const refreshed = await loadToDos().catch(() => null)
      if (refreshed) setItems(refreshed)
    }
    finally { setBusy(false) }
  }

  async function removeSelected() {
    if (!selected) return
    const kids = (childrenOf.get(selected.id) ?? []).length
    if (!window.confirm(kids > 0
      ? `Delete "${selected.title}" and ${kids} sub-task${kids === 1 ? '' : 's'}?`
      : `Delete "${selected.title}"?`)) return
    try {
      await deleteToDo(selected.id)
      const refreshed = await loadToDos()
      setItems(refreshed)
      setSelectedId(null)
    } catch (e) { toast(`Delete failed: ${(e as Error).message}`, 'error') }
  }

  async function submitNewComment() {
    if (!selected || !newCommentDraft.trim()) return
    try {
      const c = await addToDoComment(selected.id, newCommentDraft)
      setComments(prev => [...prev, c])
      setNewCommentDraft('')
    } catch (e) { toast(`Comment failed: ${(e as Error).message}`, 'error') }
  }

  async function commitCommentEdit(c: ToDoComment) {
    const next = editingCommentDraft.trim()
    setEditingCommentId(null); setEditingCommentDraft('')
    if (!next || next === c.content) return
    try {
      const updated = await updateToDoComment({ ...c, content: next })
      setComments(prev => prev.map(x => x.id === c.id ? updated : x))
    } catch (e) { toast(`Update failed: ${(e as Error).message}`, 'error') }
  }

  async function removeComment(c: ToDoComment) {
    if (!window.confirm('Delete this comment?')) return
    try {
      await deleteToDoComment(c.id)
      setComments(prev => prev.filter(x => x.id !== c.id))
    } catch (e) { toast(`Delete failed: ${(e as Error).message}`, 'error') }
  }

  // AI generation: take the context, ask for a hierarchy, preview, accept.
  async function runGenerate() {
    if (!genCtx.trim() || genBusy) return
    if (!LLM.isConfigured()) {
      setGenErr('Configure Azure OpenAI in Settings → AI Assistant.'); return
    }
    setGenBusy(true); setGenErr(''); setGenRaw('')
    try {
      const result = await generateToDoHierarchy(genCtx)
      setGenRaw(result.raw)
      if (result.reason === 'ok') {
        setGenDrafts(result.drafts)
        setGenRoot({ title: result.rootTitle, description: result.rootDescription })
      } else {
        setGenDrafts(null)
        setGenRoot(null)
        setGenErr(reasonToMessage(result.reason))
        // eslint-disable-next-line no-console
        console.warn('[todo Generate] failed:', result.reason, '\nRaw reply:\n', result.raw)
      }
    } catch (e) {
      setGenErr(`Generate failed: ${(e as Error).message}`)
      // eslint-disable-next-line no-console
      console.error('[todo Generate] threw:', e)
    }
    finally { setGenBusy(false) }
  }

  async function acceptDrafts() {
    if (!genDrafts || !genRoot) return
    setBusy(true)
    try {
      // Wrap the whole tree under one LLM-named root + ISO-date suffix so
      // the user can fold a whole batch of generated work behind a single
      // parent. One :append call writes everything.
      const stamp = new Date().toISOString().slice(0, 10)
      const wrapped = [{
        title:       `${genRoot.title} · ${stamp}`,
        description: genRoot.description,
        children:    genDrafts,
      }]
      const created = await appendToDoTreeBatch(wrapped, '')
      setItems(prev => [...prev, ...created])
      setGenDrafts(null); setGenRoot(null); setGenCtx('')
      toast(`Created ${created.length} todo${created.length === 1 ? '' : 's'} under a new root`, 'success')
    } catch (e) { toast(`Save failed: ${(e as Error).message}`, 'error') }
    finally { setBusy(false) }
  }

  // Dividers.
  function leftDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    dragLeft.current = true; document.body.classList.add('resizing-h')
  }
  function leftMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragLeft.current) return
    const r = wrapRef.current?.getBoundingClientRect(); if (!r) return
    setCol1Width(Math.max(180, Math.min(380, e.clientX - r.left)))
  }
  function leftUp(e: React.PointerEvent<HTMLDivElement>) {
    dragLeft.current = false; e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }
  function rightDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    dragRight.current = true; document.body.classList.add('resizing-h')
  }
  function rightMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRight.current) return
    const r = wrapRef.current?.getBoundingClientRect(); if (!r) return
    const minDetail = 320
    const max = Math.max(220, r.width - col1Width - minDetail)
    setCol2Width(Math.max(220, Math.min(max, e.clientX - r.left - col1Width)))
  }
  function rightUp(e: React.PointerEvent<HTMLDivElement>) {
    dragRight.current = false; e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  function renderRowActions(t: ToDoItem) {
    const siblings = (childrenOf.get(t.parentId) ?? []).slice().sort((a, b) => a.position - b.position)
    const idx = siblings.findIndex(s => s.id === t.id)
    const canUp   = idx > 0
    const canDown = idx >= 0 && idx < siblings.length - 1
    return (
      <span className="todo3-actions">
        {manageMode && (
          <>
            <button
              onClick={e => { e.stopPropagation(); moveSibling(t, -1) }}
              disabled={busy || !canUp}
              title="Move up among siblings"
            >↑</button>
            <button
              onClick={e => { e.stopPropagation(); moveSibling(t, +1) }}
              disabled={busy || !canDown}
              title="Move down among siblings"
            >↓</button>
          </>
        )}
        <button
          onClick={e => { e.stopPropagation(); addChild(t.id) }}
          disabled={busy}
          title="Add sub-task"
        >＋</button>
      </span>
    )
  }

  function renderSelCheckbox(t: ToDoItem) {
    if (!manageMode) return null
    return (
      <input
        type="checkbox"
        className="todo3-sel"
        checked={manageSel.has(t.id)}
        onChange={e => { e.stopPropagation(); toggleSel(t.id) }}
        onClick={e => e.stopPropagation()}
        title="Select for bulk action"
      />
    )
  }

  // Tree renderer.
  function renderTree(parentId: string, depth: number): React.ReactNode {
    const list = childrenOf.get(parentId) ?? []
    const visible = list.filter(t => !matches || matches.has(t.id))
    if (visible.length === 0) return null
    return (
      <ul className={depth === 0 ? 'todo3-list todo3-root' : 'todo3-list'}>
        {visible.map(t => {
          const kids = childrenOf.get(t.id) ?? []
          const hasKids = kids.length > 0
          const isCollapsed = collapsed.has(t.id)
          const hasDesc = !!(t.description ?? '').trim()
          const cmtCount = comments.filter(c => c.todoId === t.id).length
          return (
            <li key={t.id} className={`todo3-row${t.done ? ' done' : ''}${selectedId === t.id ? ' sel' : ''}${manageSel.has(t.id) ? ' marked' : ''}`}>
              <div className="todo3-line" onClick={() => setSelectedId(t.id)}>
                {hasKids ? (
                  <button
                    className="todo3-caret"
                    onClick={e => { e.stopPropagation(); toggleCollapse(t.id) }}
                    title={isCollapsed ? `Expand (${kids.length} children)` : 'Collapse'}
                  >{isCollapsed ? '▸' : '▾'}</button>
                ) : (
                  <span className="todo3-caret-spacer" />
                )}
                {manageMode ? renderSelCheckbox(t) : (
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={e => { e.stopPropagation(); toggleDone(t) }}
                    onClick={e => e.stopPropagation()}
                    title="Mark done"
                  />
                )}
                <span className="todo3-title">{t.title || 'Untitled'}</span>
                {isCollapsed && hasKids && <span className="todo3-kid-count" title="Hidden children">{kids.length}</span>}
                {hasDesc && <span className="todo3-icon" title={t.description}>ℹ</span>}
                {cmtCount > 0 && <span className="todo3-icon todo3-icon-cmt" title={`${cmtCount} comment${cmtCount === 1 ? '' : 's'}`}>💬<span className="todo3-cnt">{cmtCount}</span></span>}
                {renderRowActions(t)}
              </div>
              {hasKids && !isCollapsed && renderTree(t.id, depth + 1)}
            </li>
          )
        })}
      </ul>
    )
  }

  function renderFlat(): React.ReactNode {
    if (visibleFlat.length === 0) return <div className="col-empty">No matches</div>
    return (
      <ul className="todo3-list todo3-root">
        {visibleFlat.map(t => {
          const hasDesc = !!(t.description ?? '').trim()
          const cmtCount = comments.filter(c => c.todoId === t.id).length
          const path = pathOf(t, itemsById)
          return (
            <li key={t.id} className={`todo3-row${t.done ? ' done' : ''}${selectedId === t.id ? ' sel' : ''}${manageSel.has(t.id) ? ' marked' : ''}`}>
              <div className="todo3-line" onClick={() => setSelectedId(t.id)}>
                {manageMode ? renderSelCheckbox(t) : (
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={e => { e.stopPropagation(); toggleDone(t) }}
                    onClick={e => e.stopPropagation()}
                    title="Mark done"
                  />
                )}
                <span className="todo3-flat-text">
                  {path.length > 1 && <span className="todo3-flat-path">{path.slice(0, -1).join(' / ')} / </span>}
                  <span className="todo3-title">{t.title || 'Untitled'}</span>
                </span>
                {hasDesc && <span className="todo3-icon" title={t.description}>ℹ</span>}
                {cmtCount > 0 && <span className="todo3-icon todo3-icon-cmt" title={`${cmtCount} comment${cmtCount === 1 ? '' : 's'}`}>💬<span className="todo3-cnt">{cmtCount}</span></span>}
                {renderRowActions(t)}
              </div>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className="todo3-wrap browse-body-wrap" ref={wrapRef}>
      {/* ── Col 1 — Actions (collapsible) ──────────────── */}
      {actionsCollapsed ? (
        <div className="todo3-actions-col todo3-actions-strip">
          <button
            className="notes-strip-btn"
            onClick={() => setActionsCollapsed(false)}
            title="Show Actions panel"
          >▸</button>
          <button
            className="notes-strip-btn"
            onClick={() => { setActionsCollapsed(false); addTopLevel() }}
            disabled={busy}
            title="Add new top-level todo"
          >＋</button>
          <button
            className="notes-strip-btn"
            onClick={() => setActionsCollapsed(false)}
            title="Open AI Generate"
          >✨</button>
        </div>
      ) : (
        <div className="todo3-actions-col" style={{ width: col1Width }}>
          <div className="col-hd todo3-actions-hd">
            <span>Actions</span>
            <button
              className="panel-toggle-btn"
              onClick={() => setActionsCollapsed(true)}
              title="Hide Actions panel"
            >◂</button>
          </div>
          <div className="todo3-action-stack">
            <button className="rf-btn-save" onClick={addTopLevel} disabled={busy}>＋ Add new</button>
          </div>
          <div className="col-hd" style={{ marginTop: 12 }}>Generate</div>
          <div className="todo3-gen">
            <textarea
              className="rf-textarea"
              rows={5}
              placeholder="Describe a goal or context — AI will break it into a hierarchy of todos."
              value={genCtx}
              onChange={e => setGenCtx(e.target.value)}
              disabled={genBusy}
            />
            <button
              className="rf-btn-cancel"
              onClick={runGenerate}
              disabled={genBusy || !genCtx.trim()}
            >{genBusy ? 'Generating…' : '✨ Generate'}</button>
            {genErr && <div className="login-error">{genErr}</div>}
            {genErr && genRaw && (
              <details className="todo3-gen-raw">
                <summary>Show raw AI reply</summary>
                <pre>{genRaw}</pre>
              </details>
            )}
            {genDrafts && genRoot && (
              <div className="todo3-gen-preview">
                <div className="col-hd">Preview ({countDrafts(genDrafts) + 1})</div>
                <div className="todo3-gen-root">
                  <span className="todo3-gen-root-icon">📁</span>
                  <span className="todo3-gen-root-title">{genRoot.title}</span>
                  <span className="todo3-gen-root-stamp">· {new Date().toISOString().slice(0, 10)}</span>
                </div>
                {genRoot.description && (
                  <div className="todo3-gen-root-desc">{genRoot.description}</div>
                )}
                <div className="todo3-gen-tree">{renderDraftTree(genDrafts, 0)}</div>
                <div className="todo3-gen-actions">
                  <button className="rf-btn-cancel" onClick={() => { setGenDrafts(null); setGenRoot(null) }}>Discard</button>
                  <button className="mgmt-save-btn" onClick={acceptDrafts} disabled={busy}>Add all</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!actionsCollapsed && (
        <div
          className="qa-divider"
          onPointerDown={leftDown} onPointerMove={leftMove}
          onPointerUp={leftUp} onPointerCancel={leftUp}
        />
      )}

      {/* ── Col 2 — List ─────────────────────────────────── */}
      <div className="todo3-list-col" style={{ width: col2Width }}>
        <div className="todo3-list-hd">
          <div className="view-mode-toggle">
            <button
              className={`vm-btn${viewMode === 'tree' ? ' active' : ''}`}
              onClick={() => setViewMode('tree')}
              title="Tree view"
            >⊞</button>
            <button
              className={`vm-btn${viewMode === 'flat' ? ' active' : ''}`}
              onClick={() => setViewMode('flat')}
              title="Flat view"
            >≡</button>
          </div>
          {viewMode === 'tree' && (
            <button
              className="vm-btn todo3-collapse-all"
              onClick={() => (collapsed.size > 0 ? expandAll() : collapseAllParents())}
              title={collapsed.size > 0 ? 'Expand all rows' : 'Collapse all — show only top-level parents'}
            >{collapsed.size > 0 ? '▾ All' : '▸ All'}</button>
          )}
          <input
            className="col-search"
            placeholder="Filter title / description"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
          <label className="todo3-show-done" title="Hide completed">
            <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />
            Done
          </label>
          <button
            className={`vm-btn todo3-manage-btn${manageMode ? ' active' : ''}`}
            onClick={toggleManage}
            title={manageMode ? 'Exit manage mode' : 'Manage — multi-select, reorder, bulk move / delete'}
          >⚙</button>
        </div>

        {manageMode && (
          <div className="todo3-manage-bar">
            <span className="todo3-manage-count">{manageSel.size} selected</span>
            <button
              className="rf-btn-cancel"
              disabled={manageSel.size === 0 || busy}
              onClick={bulkDelete}
              title="Delete all selected items (with their sub-tasks)"
            >✕ Delete</button>
            <button
              className={`rf-btn-cancel${bulkMoveOpen ? ' active' : ''}`}
              disabled={manageSel.size === 0 || busy}
              onClick={() => setBulkMoveOpen(o => !o)}
              title="Move all selected items under a new parent"
            >↧ Move</button>
            <button
              className="rf-btn-cancel"
              disabled={manageSel.size === 0}
              onClick={() => setManageSel(new Set())}
            >Clear</button>
          </div>
        )}

        {manageMode && bulkMoveOpen && (
          <div className="todo3-bulk-move">
            <label>Move under
              <select value={bulkMoveParent} onChange={e => setBulkMoveParent(e.target.value)}>
                <option value="">(top level)</option>
                {items
                  .filter(t => !manageSel.has(t.id))
                  .sort((a, b) => a.title.localeCompare(b.title))
                  .map(t => <option key={t.id} value={t.id}>{pathOf(t, itemsById).join(' / ')}</option>)}
              </select>
            </label>
            <div className="todo3-bulk-move-actions">
              <button className="rf-btn-cancel" onClick={() => setBulkMoveOpen(false)}>Cancel</button>
              <button className="mgmt-save-btn" onClick={bulkMove} disabled={busy}>
                Move {manageSel.size} here
              </button>
            </div>
          </div>
        )}
        <div className="todo3-list-body">
          {loading ? (
            <div className="col-empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="col-empty">No tasks yet — use ＋ Add new or ✨ Generate.</div>
          ) : viewMode === 'tree' ? (
            renderTree('', 0) ?? <div className="col-empty">No matches</div>
          ) : (
            renderFlat()
          )}
        </div>
      </div>

      <div
        className="qa-divider"
        onPointerDown={rightDown} onPointerMove={rightMove}
        onPointerUp={rightUp} onPointerCancel={rightUp}
      />

      {/* ── Col 3 — Detail ──────────────────────────────── */}
      <div className="browse-main todo3-detail-col">
        {!selected ? (
          <div className="mgmt-empty">Select a todo from the list to see its info, comments, and edit actions.</div>
        ) : (
          <div className="todo3-detail">
            <div className="todo3-detail-hd">
              <button
                className="mgmt-back-btn"
                onClick={() => setSelectedId(null)}
                title="Back to list"
              >←</button>
              <input
                type="checkbox"
                checked={selected.done}
                onChange={() => toggleDone(selected)}
              />
              {titleEditing ? (
                <input
                  autoFocus
                  className="rf-input"
                  value={titleDraft}
                  onChange={e => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={e => {
                    if (e.key === 'Enter')       { e.preventDefault(); saveTitle() }
                    else if (e.key === 'Escape') { setTitleEditing(false); setTitleDraft(selected.title) }
                  }}
                />
              ) : (
                <h2 className={`todo3-detail-title${selected.done ? ' done' : ''}`}
                    onDoubleClick={() => { setTitleEditing(true); setTitleDraft(selected.title) }}
                    title="Double-click to edit"
                >{selected.title || 'Untitled'}</h2>
              )}
              <span style={{ flex: 1 }} />
              {!titleEditing && (
                <button
                  className="bci-edit-btn bci-edit-btn-hd"
                  onClick={() => { setTitleEditing(true); setTitleDraft(selected.title) }}
                  title="Edit title"
                >✎</button>
              )}
              <button
                className={`bci-edit-btn bci-edit-btn-hd${moveOpen ? ' active' : ''}`}
                onClick={() => { setMoveOpen(o => !o); setMoveParent(selected.parentId) }}
                title="Move to a different parent"
              >↧</button>
              <button
                className="bci-edit-btn bci-edit-btn-hd"
                onClick={removeSelected}
                title="Delete this todo"
              >🗑</button>
            </div>

            {moveOpen && (
              <div className="todo3-move">
                <label>Move under
                  <select value={moveParent} onChange={e => setMoveParent(e.target.value)}>
                    <option value="">(top level)</option>
                    {items
                      .filter(t => t.id !== selected.id && !isDescendant(selected.id, t.id, childrenOf))
                      .sort((a, b) => a.title.localeCompare(b.title))
                      .map(t => <option key={t.id} value={t.id}>{pathOf(t, itemsById).join(' / ')}</option>)}
                  </select>
                </label>
                <div className="todo3-move-actions">
                  <button className="rf-btn-cancel" onClick={() => setMoveOpen(false)}>Cancel</button>
                  <button className="mgmt-save-btn" onClick={moveSelected}>Move</button>
                </div>
              </div>
            )}

            {/* Description */}
            <section className="todo3-section">
              <div className="todo3-section-hd">
                <span>ℹ Description</span>
                {!descEditing ? (
                  <button className="bci-edit-btn" onClick={() => { setDescEditing(true); setDescDraft(selected.description ?? '') }} title="Edit">✎</button>
                ) : (
                  <>
                    <button className="rf-btn-cancel" onClick={() => { setDescEditing(false); setDescDraft(selected.description ?? '') }}>Cancel</button>
                    <button className="mgmt-save-btn" onClick={saveDescription}>Save</button>
                  </>
                )}
              </div>
              {descEditing ? (
                <textarea
                  className="rf-textarea"
                  rows={6}
                  value={descDraft}
                  onChange={e => setDescDraft(e.target.value)}
                  placeholder="Why this matters, what done looks like, gotchas…"
                />
              ) : (
                <p className={`todo3-section-body${(selected.description ?? '').trim() ? '' : ' dim'}`}>
                  {(selected.description ?? '').trim() || '— add a description so future-you remembers what this means —'}
                </p>
              )}
            </section>

            {/* Comments / progress log */}
            <section className="todo3-section">
              <div className="todo3-section-hd">
                <span>💬 Progress log ({selectedComments.length})</span>
              </div>
              <div className="todo3-comment-add">
                <textarea
                  className="rf-textarea"
                  rows={2}
                  placeholder="Log progress, notes, blockers…"
                  value={newCommentDraft}
                  onChange={e => setNewCommentDraft(e.target.value)}
                />
                <button className="rf-btn-save" onClick={submitNewComment} disabled={!newCommentDraft.trim()}>
                  Post
                </button>
              </div>
              {selectedComments.length === 0 ? (
                <p className="todo3-section-body dim">No log entries yet.</p>
              ) : (
                <ul className="todo3-comment-list">
                  {selectedComments.map(c => {
                    const editing = editingCommentId === c.id
                    return (
                      <li key={c.id} className="todo3-comment">
                        <div className="todo3-comment-hd">
                          <span className="todo3-comment-ts">{fmtCommentTs(c.createdAt)}</span>
                          <span style={{ flex: 1 }} />
                          {editing ? (
                            <>
                              <button className="rf-btn-cancel" onClick={() => { setEditingCommentId(null); setEditingCommentDraft('') }}>Cancel</button>
                              <button className="mgmt-save-btn" onClick={() => commitCommentEdit(c)}>Save</button>
                            </>
                          ) : (
                            <>
                              <button className="bci-edit-btn" onClick={() => { setEditingCommentId(c.id); setEditingCommentDraft(c.content) }} title="Edit">✎</button>
                              <button className="bci-edit-btn" onClick={() => removeComment(c)} title="Delete">✕</button>
                            </>
                          )}
                        </div>
                        {editing ? (
                          <textarea
                            className="rf-textarea"
                            rows={3}
                            value={editingCommentDraft}
                            onChange={e => setEditingCommentDraft(e.target.value)}
                            autoFocus
                          />
                        ) : (
                          <p className="todo3-comment-body">{c.content}</p>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

// ── ToDo helpers ─────────────────────────────────────────────────────────────

function reasonToMessage(r: 'ok' | 'empty_context' | 'parse_failed' | 'no_todos_key' | 'empty_list'): string {
  switch (r) {
    case 'empty_context':  return 'Add some context before generating.'
    case 'parse_failed':   return 'AI returned non-JSON output. See the raw reply below — you may need to refine the AI Skill instruction (Avatar → AI Skills → ToDo Generator).'
    case 'no_todos_key':   return 'AI returned JSON but no "todos" array. Check the raw reply below.'
    case 'empty_list':     return 'AI returned an empty list. Try giving more detail or a different angle.'
    default:               return 'Generate finished with an unexpected state.'
  }
}

function isDescendant(rootId: string, candidateId: string, childrenOf: Map<string, ToDoItem[]>): boolean {
  if (!candidateId) return false
  if (candidateId === rootId) return true
  const stack = [...(childrenOf.get(rootId) ?? []).map(c => c.id)]
  while (stack.length) {
    const id = stack.pop()!
    if (id === candidateId) return true
    for (const c of childrenOf.get(id) ?? []) stack.push(c.id)
  }
  return false
}

function pathOf(t: ToDoItem, itemsById: Map<string, ToDoItem>): string[] {
  const out: string[] = []
  let cur: ToDoItem | undefined = t
  while (cur) {
    out.unshift(cur.title || 'Untitled')
    cur = cur.parentId ? itemsById.get(cur.parentId) : undefined
  }
  return out
}

function fmtCommentTs(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function countDrafts(drafts: ToDoDraft[]): number {
  let n = 0
  const stack = [...drafts]
  while (stack.length) {
    const t = stack.pop()!
    n++
    for (const c of t.children) stack.push(c)
  }
  return n
}

function renderDraftTree(drafts: ToDoDraft[], depth: number): React.ReactNode {
  if (drafts.length === 0) return null
  return (
    <ul className={depth === 0 ? 'todo3-list todo3-root' : 'todo3-list'}>
      {drafts.map((d, i) => (
        <li key={i} className="todo3-row">
          <div className="todo3-line">
            <span className="todo3-title">{d.title}</span>
            {d.description && <span className="todo3-icon" title={d.description}>ℹ</span>}
          </div>
          {d.children.length > 0 && renderDraftTree(d.children, depth + 1)}
        </li>
      ))}
    </ul>
  )
}

// ── Activity Log ─────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type ActivitySubTab = 'log' | 'lessons'

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
  const [notWorkedDraft, setNotWorkedDraft] = useState('')
  const [rawDraft, setRawDraft]       = useState('')
  const [viewMode, setViewMode]       = useState<'view' | 'edit'>('view')
  const [reminderDraft, setReminderDraft] = useState('')
  const [busy, setBusy]               = useState(false)

  // Sub-tabs: "Log" (Calendar + Day editor) | "Lessons" (records list + detail)
  const [subTab, setSubTab]           = useState<ActivitySubTab>('log')
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(null)
  const [lessonListWidth, setLessonListWidth] = useState(320)   // px, draggable
  const lessonsWrapRef                = useRef<HTMLDivElement>(null)
  const isLessonDragging              = useRef(false)

  // 3-pane controls (Notes-style).
  const [leftCollapsed, setLeftColl]  = useState(true)
  const [col1Ratio, setCol1Ratio]     = useState(18)
  const [col2EndRatio, setCol2EndRatio] = useState(48)
  const [dayExpanded, setDayExpanded] = useState(false)
  const [calExpanded, setCalExpanded] = useState(false)
  const [aiOpen, setAiOpen]           = useState(false)
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
        setNotWorkedDraft(list.find(e => e.kind === 'not_worked')?.content ?? '')
        setRawDraft(list.find(e => e.kind === 'raw')?.content ?? '')
        setViewMode('view')
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

  // Lessons learned — independent tab; lazy-loaded the first time the user
  // opens the Lessons side mode.
  const [lessons, setLessons]               = useState<Lesson[]>([])
  const [lessonsLoaded, setLessonsLoaded]   = useState(false)
  const [editingLessonId, setEditingLessonId] = useState<string | null>(null)
  const [genOpen, setGenOpen]               = useState(false)
  const [genFrom, setGenFrom]               = useState(() => isoDate(addDays(today, -7)))
  const [genTo, setGenTo]                   = useState(() => isoDate(today))
  const [genBusy, setGenBusy]               = useState(false)

  useEffect(() => {
    if (subTab !== 'lessons' || lessonsLoaded) return
    loadLessons()
      .then(list => { setLessons(list); setLessonsLoaded(true) })
      .catch(e => toast(`Load lessons failed: ${(e as Error).message}`, 'error'))
  }, [subTab, lessonsLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

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

  function lessonDividerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    isLessonDragging.current = true; document.body.classList.add('resizing-h')
  }
  function lessonDividerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isLessonDragging.current) return
    const wrap = lessonsWrapRef.current; if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const ACTIONS_W  = 200    // matches .lessons-actions-col width
    const MIN_LIST   = 200
    const MIN_DETAIL = 320
    const x = e.clientX - rect.left - ACTIONS_W
    const max = Math.max(MIN_LIST, rect.width - ACTIONS_W - MIN_DETAIL)
    setLessonListWidth(Math.max(MIN_LIST, Math.min(max, x)))
  }
  function lessonDividerUp(e: React.PointerEvent<HTMLDivElement>) {
    isLessonDragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  const col2Width = Math.max(0, col2EndRatio - col1Ratio)
  const todayIso  = isoDate(today)

  const selectedLesson = lessons.find(l => l.id === selectedLessonId) ?? null

  return (
    <div className="activity-panel-wrap">
      <div className="activity-subtabs">
        <button
          className={`activity-subtab${subTab === 'log' ? ' active' : ''}`}
          onClick={() => setSubTab('log')}
        >📋 Log</button>
        <button
          className={`activity-subtab${subTab === 'lessons' ? ' active' : ''}`}
          onClick={() => setSubTab('lessons')}
        >💡 Lessons</button>
      </div>

      {subTab === 'lessons' ? (
        <div className="lessons-3pane browse-body-wrap" ref={lessonsWrapRef}>
          {/* ── Col 1 — Actions ─────────────────────────────── */}
          <div className="lessons-actions-col">
            <div className="col-hd">Actions</div>
            <div className="lessons-actions-stack">
              <button
                className="rf-btn-save"
                onClick={() => {
                  setEditingLessonId('NEW')
                  setSelectedLessonId(null)
                  setGenOpen(false)
                }}
              >＋ New lesson</button>
              <button
                className="rf-btn-cancel"
                onClick={() => { setGenOpen(o => !o); setEditingLessonId(null) }}
              >✨ Generate from range</button>
            </div>
            {genOpen && (
              <div className="lessons-gen-form">
                <label>From <input type="date" value={genFrom} onChange={e => setGenFrom(e.target.value)} /></label>
                <label>To   <input type="date" value={genTo}   onChange={e => setGenTo(e.target.value)}   /></label>
                <div className="lessons-gen-actions">
                  <button
                    className="rf-btn-cancel"
                    onClick={() => setGenOpen(false)}
                    disabled={genBusy}
                  >Cancel</button>
                  <button
                    className="mgmt-save-btn"
                    onClick={generateLessons}
                    disabled={genBusy || !genFrom || !genTo || genFrom > genTo}
                  >{genBusy ? 'Generating…' : 'Generate'}</button>
                </div>
              </div>
            )}
          </div>

          {/* ── Col 2 — List ────────────────────────────────── */}
          <div className="lessons-list-col" style={{ width: lessonListWidth }}>
            <div className="col-hd">Lessons learned</div>
            {!lessonsLoaded ? (
              <div className="col-empty">Loading…</div>
            ) : lessons.length === 0 ? (
              <div className="col-empty">No lessons yet. Use ＋ New lesson or ✨ Generate.</div>
            ) : (
              <ul className="lessons-list">
                {lessons.map(l => (
                  <li key={l.id} className="lessons-item">
                    <button
                      className={`lessons-row-btn${selectedLessonId === l.id ? ' sel' : ''}`}
                      onClick={() => { setSelectedLessonId(l.id); setEditingLessonId(null) }}
                    >
                      <div className="lessons-row-q">{l.problem || '(no problem)'}</div>
                      {l.worked && <div className="lessons-row-w">✓ {l.worked}</div>}
                      {l.notWorked && <div className="lessons-row-x">✕ {l.notWorked}</div>}
                      <div className="lessons-row-meta">
                        {l.source.startsWith('ai:') ? `✨ ${l.source.slice(3)}` : 'manual'}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Divider — drag to resize List vs Detail */}
          <div
            className="qa-divider"
            onPointerDown={lessonDividerDown}
            onPointerMove={lessonDividerMove}
            onPointerUp={lessonDividerUp}
            onPointerCancel={lessonDividerUp}
          />

          {/* ── Col 3 — Detail / Preview ────────────────────── */}
          <div className={`browse-main lessons-detail-col${
            (selectedLessonId !== null || editingLessonId === 'NEW') ? ' has-selection' : ''
          }`}>
            {editingLessonId === 'NEW' ? (
              <div className="lesson-detail-wrap">
                <div className="lesson-detail-hd">
                  <button
                    className="mgmt-back-btn"
                    onClick={() => setEditingLessonId(null)}
                    title="Back to lessons list"
                  >←</button>
                  <h2>New lesson</h2>
                </div>
                <LessonEditor
                  key="new"
                  initial={{ id: '', problem: '', notWorked: '', worked: '', source: 'manual', createdAt: '', updatedAt: '' }}
                  onCancel={() => setEditingLessonId(null)}
                  onSave={async draft => {
                    try {
                      const created = await addLesson(draft)
                      setLessons(prev => [created, ...prev])
                      setEditingLessonId(null)
                      setSelectedLessonId(created.id)
                      toast('Lesson saved', 'success')
                    } catch (err) {
                      toast(`Save failed: ${(err as Error).message}`, 'error')
                    }
                  }}
                />
              </div>
            ) : selectedLesson ? (
              editingLessonId === selectedLesson.id ? (
                <div className="lesson-detail-wrap">
                  <div className="lesson-detail-hd">
                    <button
                      className="mgmt-back-btn"
                      onClick={() => { setEditingLessonId(null); setSelectedLessonId(null) }}
                      title="Back to lessons list"
                    >←</button>
                    <h2>Edit lesson</h2>
                    <span style={{ flex: 1 }} />
                    <button
                      className="bci-edit-btn bci-edit-btn-hd"
                      onClick={() => setEditingLessonId(null)}
                      title="Cancel edit"
                    >✕</button>
                  </div>
                  <LessonEditor
                    initial={selectedLesson}
                    onCancel={() => setEditingLessonId(null)}
                    onSave={async draft => {
                      try {
                        const updated = await updateLesson({ ...selectedLesson, ...draft })
                        setLessons(prev => prev.map(x => x.id === selectedLesson.id ? updated : x))
                        setEditingLessonId(null)
                        toast('Lesson updated', 'success')
                      } catch (err) {
                        toast(`Save failed: ${(err as Error).message}`, 'error')
                      }
                    }}
                    onDelete={async () => {
                      if (!window.confirm('Delete this lesson?')) return
                      try {
                        await deleteLesson(selectedLesson.id)
                        setLessons(prev => prev.filter(x => x.id !== selectedLesson.id))
                        setEditingLessonId(null)
                        setSelectedLessonId(null)
                        toast('Deleted', 'success')
                      } catch (err) {
                        toast(`Delete failed: ${(err as Error).message}`, 'error')
                      }
                    }}
                  />
                </div>
              ) : (
                <LessonPreview
                  lesson={selectedLesson}
                  onEdit={() => setEditingLessonId(selectedLesson.id)}
                  onClose={() => setSelectedLessonId(null)}
                />
              )
            ) : (
              <div className="mgmt-empty">Select a lesson on the left to view it, or use ＋ New / ✨ Generate.</div>
            )}
          </div>
        </div>
      ) : (
      <div className="activity-3pane browse-body-wrap" ref={bodyWrapRef}>
      {/* ── Col 1: Recent ───────────────────────────────────── */}
      {!dayExpanded && !calExpanded && (
        <div className={`browse-col-tags${leftCollapsed ? ' collapsed' : ''}`}
             style={leftCollapsed ? undefined : { width: `${col1Ratio}%` }}>
          {leftCollapsed ? (
            <div className="notes-strip">
              <button
                className="notes-strip-btn active"
                onClick={() => setLeftColl(false)}
                title="Recent activity"
              >🕐</button>
              <button
                className="notes-strip-btn"
                onClick={() => setLeftColl(false)}
                title="Expand"
              >▸</button>
            </div>
          ) : (
            <>
              <div className="left-tab-bar">
                <span className="left-tab active">Recent</span>
                <button className="panel-toggle-btn" onClick={() => setLeftColl(true)} title="Collapse">◂</button>
              </div>
              <ul className="activity-side-list">
                {recent.length === 0 && <li className="col-empty">Nothing yet</li>}
                {recent.map(e => (
                  <li key={e.id} onClick={() => setSelected(e.date)}>
                    <div className="activity-side-title">{kindLabel(e.kind)} · {e.content || '(empty)'}</div>
                    <div className="activity-side-meta">{prettyDate(e.date)}</div>
                  </li>
                ))}
              </ul>
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
              className={`bci-edit-btn bci-edit-btn-hd${aiOpen ? ' active' : ''}`}
              onClick={() => setAiOpen(o => !o)}
              title={aiOpen ? 'Close Ask AI' : 'Ask AI about this day'}
            >✨ AI</button>
            {viewMode === 'view' ? (
              <button
                className="bci-edit-btn bci-edit-btn-hd"
                onClick={() => setViewMode('edit')}
                title="Edit this day"
              >✎</button>
            ) : (
              <button
                className="bci-edit-btn bci-edit-btn-hd active"
                onClick={() => setViewMode('view')}
                title="Done — return to preview"
              >✓ Done</button>
            )}
            <button
              className={`bci-edit-btn bci-edit-btn-hd${dayExpanded ? ' active' : ''}`}
              onClick={() => toggleDayExpand()}
              title={dayExpanded ? 'Restore' : 'Expand viewer'}
            >{dayExpanded ? '⤡' : '⤢'}</button>
          </div>
        </div>
        <div className="activity-day-body">
          {loading ? (
            <div className="col-empty">Loading…</div>
          ) : viewMode === 'view' ? (
            <ActivityPreview
              date={selected}
              topTask={topTaskDraft}
              notWorked={notWorkedDraft}
              wins={winsDraft}
              improvements={improveDraft}
              raw={rawDraft}
              reminders={entries.filter(e => e.kind === 'reminder')}
              hourly={hourly}
              onEdit={() => setViewMode('edit')}
            />
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
                label="What didn't work"
                value={notWorkedDraft}
                onChange={setNotWorkedDraft}
                onSave={() => saveSingleton('not_worked', notWorkedDraft)}
                busy={busy}
                multiline
                placeholder="Approaches, assumptions, or strategies that did not work today"
              />
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
              <SingletonField
                label="Raw log"
                value={rawDraft}
                onChange={setRawDraft}
                onSave={() => saveSingleton('raw', rawDraft)}
                busy={busy}
                multiline
                placeholder="Free-form brain dump for the day — paste, dictate, or let AI populate this"
              />
            </>
          )}
        </div>
      </div>
      )}
      </div>
      )}

      <EphemeralAIChat
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        title={`Ask AI · ${prettyDate(selected)}`}
        systemPrompt={buildActivitySystemPrompt(selected, entries)}
        maxTokens={3000}
        onApply={applyAIResponse}
      />
    </div>
  )

  // ── Generate lessons from a date range via LLM ───────────────────────
  async function generateLessons() {
    if (!LLM.isConfigured()) {
      toast('Configure Azure OpenAI in Settings → AI Assistant.', 'error')
      return
    }
    setGenBusy(true)
    try {
      const acts = await loadActivitiesInRange(genFrom, genTo)
      const usable = acts.filter(e => e.kind === 'hourly' || e.kind === 'not_worked')
      if (usable.length === 0) {
        toast('No hourly entries or "what didn\'t work" notes in that range.', 'info')
        setGenBusy(false)
        return
      }
      const reply = await LLM.chat([
        { role: 'system', content: buildLessonsRangePrompt(genFrom, genTo) },
        { role: 'user',   content: formatActivitiesForPrompt(usable) },
      ], 1500)
      const parsed = parseLessonsJson(reply)
      if (!parsed || !Array.isArray(parsed.lessons) || parsed.lessons.length === 0) {
        toast('AI returned no lessons. Try a different range.', 'info')
        setGenBusy(false)
        return
      }
      const source = `ai:${genFrom}..${genTo}`
      let count = 0
      const created: Lesson[] = []
      for (const item of parsed.lessons) {
        if (!item || typeof item !== 'object') continue
        const problem    = typeof item.problem    === 'string' ? item.problem    : ''
        const notWorked  = typeof item.not_worked === 'string' ? item.not_worked : ''
        const worked     = typeof item.worked     === 'string' ? item.worked     : ''
        if (!problem.trim() && !notWorked.trim() && !worked.trim()) continue
        try {
          const l = await addLesson({ problem, notWorked, worked, source })
          created.push(l)
          count++
        } catch (err) {
          toast(`Save lesson failed: ${(err as Error).message}`, 'error')
        }
      }
      if (count > 0) {
        setLessons(prev => [...created, ...prev])
        setGenOpen(false)
        toast(`Generated ${count} lesson${count === 1 ? '' : 's'}`, 'success')
      }
    } catch (err) {
      toast(`Generate failed: ${(err as Error).message}`, 'error')
    } finally {
      setGenBusy(false)
    }
  }

  // ── Apply parsed AI JSON → form drafts + auto-create rows ────────────
  // For each key the AI provided, the matching field in the form is replaced.
  // Singletons go into drafts (user blurs to save); hourly + reminder lists
  // for the selected day are wiped and re-created from the AI's set.
  async function applyAIResponse(raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const p = raw as Record<string, any>
    const updates: string[] = []
    const skipped: string[] = []

    // Singletons → set the draft (user reviews, then blurs to save).
    function applySingleton(
      key: string,
      setter: (v: string) => void,
      value: any,
      label: string,
    ) {
      if (!(key in p)) return
      const v = typeof value === 'string' ? value.trim() : ''
      setter(v)
      updates.push(label)
    }
    applySingleton('top_task',     setTopTaskDraft,   p.top_task,     'top task')
    applySingleton('wins',         setWinsDraft,      p.wins,         'wins')
    applySingleton('improvements', setImproveDraft,   p.improvements, 'improvements')
    applySingleton('not_worked',   setNotWorkedDraft, p.not_worked,   "what didn't work")
    applySingleton('raw_log',      setRawDraft,       p.raw_log,      'raw log')

    // Lessons + 1% improvement: append into improvements draft if AI didn't
    // already set `improvements` directly.
    const aiSetImprove = typeof p.improvements === 'string' && p.improvements.trim()
    const extras: string[] = []
    if (Array.isArray(p.lessons_learned)) {
      const arr = p.lessons_learned.filter((s: any) => typeof s === 'string' && s.trim())
      if (arr.length > 0) extras.push('Lessons learned:\n' + arr.map((s: string) => `• ${s}`).join('\n'))
    }
    if (p.one_percent_improvement && typeof p.one_percent_improvement === 'object') {
      const opi = p.one_percent_improvement
      const lines: string[] = []
      if (typeof opi.today === 'string' && opi.today.trim())        lines.push(`Today: ${opi.today.trim()}`)
      if (typeof opi.fix_tomorrow === 'string' && opi.fix_tomorrow.trim()) lines.push(`Tomorrow: ${opi.fix_tomorrow.trim()}`)
      if (lines.length > 0) extras.push('1% improvement:\n' + lines.join('\n'))
    }
    if (extras.length > 0 && !aiSetImprove) {
      setImproveDraft(prev => (prev.trim() ? prev + '\n\n' : '') + extras.join('\n\n'))
      updates.push('lessons + 1%')
    }

    // Hourly — replace the day's hourly entries with the AI's set.
    if (Array.isArray(p.hourly) && p.hourly.length > 0) {
      const existing = entries.filter(e => e.kind === 'hourly')
      for (const e of existing) {
        try {
          await deleteActivity(e.id)
          setEntries(prev => prev.filter(x => x.id !== e.id))
          syncCache(prev => prev.filter(x => x.id !== e.id))
        } catch (err) {
          toast(`Hourly clear failed: ${(err as Error).message}`, 'error')
        }
      }
      let count = 0
      for (const h of p.hourly) {
        if (!h || typeof h !== 'object') continue
        const time = typeof h.time === 'string' ? h.time.trim() : ''
        const partsArr: string[] = []
        if (typeof h.what_i_did === 'string' && h.what_i_did.trim()) partsArr.push(h.what_i_did.trim())
        if (typeof h.done === 'string' && h.done.trim() && h.done !== h.what_i_did) partsArr.push(`done: ${h.done.trim()}`)
        if (typeof h.expected === 'string' && h.expected.trim())     partsArr.push(`expected: ${h.expected.trim()}`)
        const text = partsArr.join(' · ')
        if (!text) continue
        try {
          const e = await addHourlyActivity(selected, time, text)
          setEntries(prev => [...prev, e])
          syncCache(prev => [...prev, e])
          count++
        } catch (err) {
          toast(`Hourly add failed: ${(err as Error).message}`, 'error')
        }
      }
      if (count > 0) updates.push(`${count} hourly`)
    }

    // Reminders — replace the day's reminders with the AI's set.
    if (Array.isArray(p.reminders) && p.reminders.length > 0) {
      const existing = entries.filter(e => e.kind === 'reminder')
      for (const e of existing) {
        try {
          await deleteActivity(e.id)
          setEntries(prev => prev.filter(x => x.id !== e.id))
          syncCache(prev => prev.filter(x => x.id !== e.id))
        } catch (err) {
          toast(`Reminder clear failed: ${(err as Error).message}`, 'error')
        }
      }
      let count = 0
      for (const r of p.reminders) {
        if (typeof r !== 'string' || !r.trim()) continue
        try {
          const e = await addReminder(selected, r.trim())
          syncCache(prev => [...prev, e])
          count++
        } catch (err) {
          toast(`Reminder add failed: ${(err as Error).message}`, 'error')
        }
      }
      if (count > 0) updates.push(`${count} reminder${count === 1 ? '' : 's'}`)
    }

    // Goal — no storage yet; surface so it's not silently lost.
    if (p.goal && typeof p.goal === 'object') {
      const g = p.goal
      const hasGoal = (typeof g.title === 'string' && g.title.trim())
                    || (typeof g.target_date === 'string' && g.target_date.trim())
                    || (Array.isArray(g.contributions_today) && g.contributions_today.length > 0)
      if (hasGoal) skipped.push('goal (no field yet)')
    }

    if (updates.length === 0 && skipped.length === 0) {
      toast('Nothing to apply — response was empty', 'info')
      return
    }

    // Reload the day from the source so the rendered Activity Log reflects
    // the AI-applied state (hourly + reminder rows recreated, drafts may be
    // out of sync with stored singletons).
    try {
      const fresh = await loadActivityForDate(selected)
      setEntries(fresh)
      // Re-seed drafts from whatever is now stored, falling back to the AI
      // value the user just saw applied (since singletons aren't persisted
      // until blur).
      const find = (k: ActivityKind) => fresh.find(e => e.kind === k)?.content ?? ''
      setTopTaskDraft(typeof p.top_task === 'string'   ? p.top_task   : find('top_task'))
      setWinsDraft(typeof p.wins === 'string'          ? p.wins       : find('wins'))
      setImproveDraft(typeof p.improvements === 'string' ? p.improvements : find('improvements'))
      setNotWorkedDraft(typeof p.not_worked === 'string' ? p.not_worked   : find('not_worked'))
      setRawDraft(typeof p.raw_log === 'string'        ? p.raw_log    : find('raw'))
      // After applying, drop back into Preview so the user sees the populated page.
      setViewMode('view')
    } catch (err) {
      toast(`Reload failed: ${(err as Error).message}`, 'error')
    }

    const msg = [
      updates.length ? `Applied: ${updates.join(', ')}` : '',
      skipped.length ? `Skipped: ${skipped.join(', ')}` : '',
      'Click out of singleton fields to persist them.',
    ].filter(Boolean).join(' · ')
    toast(msg, 'success')
  }
}

function buildActivitySystemPrompt(date: string, entries: ActivityEntry[]): string {
  const top   = entries.find(e => e.kind === 'top_task')?.content?.trim() || ''
  const wins  = entries.find(e => e.kind === 'wins')?.content?.trim() || ''
  const impr  = entries.find(e => e.kind === 'improvements')?.content?.trim() || ''
  const reminders = entries
    .filter(e => e.kind === 'reminder')
    .map(e => `- ${e.content}`)
    .join('\n')
  const hourly = entries
    .filter(e => e.kind === 'hourly')
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(e => `- ${e.time || '—'}: ${e.content}`)
    .join('\n')

  return [
    `You are an Activity Log parser. The user is logging information about their day (${prettyDate(date)} — ${date}). Their input may be free-form text, voice-to-text dictation, or a casual brain-dump describing what they did, what they expected, what they finished, lessons learned, improvements, and contributions toward a longer-term goal.`,
    ``,
    `YOUR ONLY JOB: parse the user's message and return a STRICT JSON object that matches the schema below. Output VALID JSON ONLY — no prose, no commentary, no markdown code fences, no leading/trailing text. The first character of your reply must be "{" and the last must be "}".`,
    ``,
    `Schema (always include every key; use "" or [] when absent — never invent data):`,
    `{`,
    `  "date": "${date}",                       // ALWAYS this exact value — entries are saved against the day the user is viewing`,
    `  "top_task": "",                             // the single most important task for the day`,
    `  "goal": {`,
    `    "title": "",                              // longer-term / multi-day goal the user is working toward`,
    `    "target_date": "",                        // YYYY-MM-DD if mentioned, else ""`,
    `    "contributions_today": []                 // concrete actions today that moved this goal forward`,
    `  },`,
    `  "hourly": [                                 // one item per time-slot the user described`,
    `    {`,
    `      "time": "",                             // 24h "HH:MM" if mentioned, else ""`,
    `      "what_i_did": "",                       // the concrete action taken`,
    `      "expected": "",                         // what was planned/expected for this slot`,
    `      "done": ""                              // what was actually completed`,
    `    }`,
    `  ],`,
    `  "lessons_learned": [],                      // short bullets — one sentence each`,
    `  "one_percent_improvement": {`,
    `    "today": "",                              // a tiny improvement that could apply right now`,
    `    "fix_tomorrow": ""                        // a single concrete change to try tomorrow`,
    `  },`,
    `  "wins": "",                                 // short paragraph — what went well`,
    `  "improvements": "",                         // short paragraph — what could be better`,
    `  "reminders": [],                            // future reminders the user mentioned`,
    `  "raw_log": ""                               // free-form re-narration of the day in the user's own voice — preserve specifics, names, timestamps so the user can re-read what they said`,
    `}`,
    ``,
    `Rules:`,
    `1. Output JSON only. No \`\`\`json fences. No prose before or after.`,
    `2. Times: 24-hour "HH:MM". If absent, use "".`,
    `3. The "date" field MUST be exactly "${date}". Even if the user mentions another day (e.g. "yesterday"), do not change it — that day's editor is what gets populated.`,
    `4. Be faithful — never embellish or add facts the user did not state.`,
    `5. Group related fragments into a single hourly entry when appropriate.`,
    `6. If the user is just chatting or asking a question (not logging), still return the schema with all fields empty except "date".`,
    ``,
    `--- Current day context (already saved, for reference only — do NOT duplicate into your output unless the user explicitly mentions them again) ---`,
    `Top task: ${top || '(not set)'}`,
    `Reminders:\n${reminders || '(none)'}`,
    `Hourly entries:\n${hourly || '(none)'}`,
    `What went well: ${wins || '(not filled)'}`,
    `Where to improve: ${impr || '(not filled)'}`,
  ].join('\n')
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

function addDays(d: Date, n: number): Date {
  const c = new Date(d); c.setDate(c.getDate() + n); return c
}

// ── Activity Preview (read-only render of one day) ───────────────────────────

function ActivityPreview({
  date, topTask, notWorked, wins, improvements, raw, reminders, hourly, onEdit,
}: {
  date:         string
  topTask:      string
  notWorked:    string
  wins:         string
  improvements: string
  raw:          string
  reminders:    ActivityEntry[]
  hourly:       ActivityEntry[]
  onEdit:       () => void
}) {
  const empty =
    !topTask.trim() && !notWorked.trim() && !wins.trim() &&
    !improvements.trim() && !raw.trim() &&
    reminders.length === 0 && hourly.length === 0
  if (empty) {
    return (
      <div className="activity-preview activity-preview-empty">
        <p>Nothing logged for {prettyDate(date)} yet.</p>
        <button className="rf-btn-save" onClick={onEdit}>✎ Add entries</button>
      </div>
    )
  }
  return (
    <div className="activity-preview">
      <section className="activity-preview-section">
        <h4>Top task</h4>
        <p className={topTask.trim() ? '' : 'activity-preview-dim'}>
          {topTask.trim() || '—'}
        </p>
      </section>

      <section className="activity-preview-section">
        <h4>Reminders</h4>
        {reminders.length === 0 ? (
          <p className="activity-preview-dim">—</p>
        ) : (
          <ul>{reminders.map(r => <li key={r.id}>⏰ {r.content}</li>)}</ul>
        )}
      </section>

      <section className="activity-preview-section">
        <h4>Hourly activity</h4>
        {hourly.length === 0 ? (
          <p className="activity-preview-dim">—</p>
        ) : (
          <ul>
            {hourly.map(h => (
              <li key={h.id}>
                <span className="activity-preview-time">{h.time || '—'}</span>
                <span className="activity-preview-text">{h.content}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="activity-preview-section">
        <h4>What didn't work</h4>
        <p className={`multiline${notWorked.trim() ? '' : ' activity-preview-dim'}`}>
          {notWorked.trim() || '—'}
        </p>
      </section>

      <section className="activity-preview-section">
        <h4>What went well</h4>
        <p className={`multiline${wins.trim() ? '' : ' activity-preview-dim'}`}>
          {wins.trim() || '—'}
        </p>
      </section>

      <section className="activity-preview-section">
        <h4>Where I can improve</h4>
        <p className={`multiline${improvements.trim() ? '' : ' activity-preview-dim'}`}>
          {improvements.trim() || '—'}
        </p>
      </section>

      <section className="activity-preview-section">
        <h4>Raw log</h4>
        {raw.trim() ? (
          <pre className="activity-preview-raw">{raw}</pre>
        ) : (
          <p className="activity-preview-dim">—</p>
        )}
      </section>
    </div>
  )
}

// ── Lessons learned helpers ──────────────────────────────────────────────────

interface LessonDraftFields {
  problem: string; notWorked: string; worked: string
  source?: string
}

function LessonEditor({
  initial, onSave, onCancel, onDelete,
}: {
  initial: Lesson
  onSave:   (d: LessonDraftFields) => Promise<void>
  onCancel: () => void
  onDelete?: () => Promise<void>
}) {
  const [problem,   setProblem]   = useState(initial.problem)
  const [notWorked, setNotWorked] = useState(initial.notWorked)
  const [worked,    setWorked]    = useState(initial.worked)
  const [busy, setBusy]           = useState(false)
  const dirty =
    problem !== initial.problem || notWorked !== initial.notWorked || worked !== initial.worked

  return (
    <div className="lessons-editor">
      <label className="lessons-edit-lbl">Problem / Expectation</label>
      <textarea
        rows={5} className="rf-textarea lessons-edit-area"
        value={problem}
        onChange={e => setProblem(e.target.value)}
        placeholder="What problem or expectation drove the work?"
      />
      <label className="lessons-edit-lbl">What did not work</label>
      <textarea
        rows={6} className="rf-textarea lessons-edit-area"
        value={notWorked}
        onChange={e => setNotWorked(e.target.value)}
        placeholder="Approaches or assumptions that failed"
      />
      <label className="lessons-edit-lbl">What worked</label>
      <textarea
        rows={6} className="rf-textarea lessons-edit-area"
        value={worked}
        onChange={e => setWorked(e.target.value)}
        placeholder="Strategy that helped accomplish the job"
      />
      <div className="lessons-edit-actions">
        <button className="rf-btn-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          className="mgmt-save-btn"
          disabled={busy || (!dirty && !!initial.id)}
          onClick={async () => {
            setBusy(true)
            try { await onSave({ problem, notWorked, worked, source: initial.source }) }
            finally { setBusy(false) }
          }}
        >{busy ? 'Saving…' : 'Save'}</button>
        {onDelete && (
          <>
            <span style={{ flex: 1 }} />
            <button
              className="rf-btn-cancel ai-skill-delete"
              disabled={busy}
              onClick={async () => { setBusy(true); try { await onDelete() } finally { setBusy(false) } }}
            >Delete</button>
          </>
        )}
      </div>
    </div>
  )
}

function LessonPreview({
  lesson, onEdit, onClose,
}: {
  lesson: Lesson; onEdit: () => void; onClose?: () => void
}) {
  return (
    <div className="lesson-detail-wrap lesson-preview">
      <div className="lesson-detail-hd">
        {onClose && (
          <button
            className="mgmt-back-btn"
            onClick={onClose}
            title="Back to lessons list"
          >←</button>
        )}
        <h2 className="lesson-preview-title">{lesson.problem || 'Untitled lesson'}</h2>
        <span style={{ flex: 1 }} />
        <button
          className="bci-edit-btn bci-edit-btn-hd"
          onClick={onEdit}
          title="Edit lesson"
        >✎</button>
      </div>
      <section className="lesson-preview-section">
        <h4>Problem / Expectation</h4>
        <p className={lesson.problem ? 'multiline' : 'multiline activity-preview-dim'}>
          {lesson.problem || '—'}
        </p>
      </section>
      <section className="lesson-preview-section">
        <h4>What did not work</h4>
        <p className={lesson.notWorked ? 'multiline' : 'multiline activity-preview-dim'}>
          {lesson.notWorked || '—'}
        </p>
      </section>
      <section className="lesson-preview-section">
        <h4>What worked</h4>
        <p className={lesson.worked ? 'multiline' : 'multiline activity-preview-dim'}>
          {lesson.worked || '—'}
        </p>
      </section>
      <div className="lesson-preview-meta">
        Source: {lesson.source.startsWith('ai:') ? `✨ ${lesson.source.slice(3)}` : 'manual'}
        {lesson.createdAt && ` · created ${lesson.createdAt.slice(0, 10)}`}
        {lesson.updatedAt && lesson.updatedAt !== lesson.createdAt && ` · updated ${lesson.updatedAt.slice(0, 10)}`}
      </div>
    </div>
  )
}

function buildLessonsRangePrompt(from: string, to: string): string {
  return [
    `You analyze ACTIVITY LOGS and extract LESSONS LEARNED. The user will provide ONLY two kinds of input for dates from ${from} to ${to}:`,
    `  • Hourly entries — what they did at specific times.`,
    `  • "What didn't work" — strategies, assumptions, or approaches the user noted did not work that day.`,
    `Treat these as the sole source of truth. Ignore everything else.`,
    ``,
    `Your job: identify discrete lessons. A lesson captures a problem the user worked on (inferred from the hourly entries), what did NOT work (taken from the "What didn't work" entries), and what DID work (the strategy that contributed to accomplishment, also inferred from the hourly entries).`,
    ``,
    `Return STRICT JSON ONLY — no prose, no markdown fences, no commentary. First character "{", last character "}". Schema:`,
    `{`,
    `  "lessons": [`,
    `    {`,
    `      "problem":    "the problem or expectation that drove the work",`,
    `      "not_worked": "strategies, approaches, or assumptions that did not work",`,
    `      "worked":     "the strategy that worked / contributed to accomplishment"`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Rules:`,
    `1. Output JSON only. Start with "{" and end with "}". No \`\`\` fences.`,
    `2. Be faithful to the logs — never invent lessons not supported by the input.`,
    `3. Combine related observations across days into a single, well-formed lesson.`,
    `4. If a field has no clear evidence, return "" (empty string) for that field, not made-up content.`,
    `5. If no lessons can be extracted at all, return {"lessons": []}.`,
    `6. Each lesson must be self-contained, concrete, and actionable for next time.`,
    `7. Limit to the most meaningful 1–7 lessons. Prefer fewer high-quality lessons over many shallow ones.`,
  ].join('\n')
}

function formatActivitiesForPrompt(entries: ActivityEntry[]): string {
  // Strict-source feed for Lessons generation: only Hourly entries + the
  // "What didn't work" singleton per date.
  const byDate = new Map<string, ActivityEntry[]>()
  for (const e of entries) {
    if (e.kind !== 'hourly' && e.kind !== 'not_worked') continue
    const arr = byDate.get(e.date) ?? []
    arr.push(e)
    byDate.set(e.date, arr)
  }
  const dates = Array.from(byDate.keys()).sort()
  const out: string[] = []
  for (const d of dates) {
    const items = byDate.get(d)!
    const hourly = items.filter(e => e.kind === 'hourly')
      .sort((a, b) => a.time.localeCompare(b.time))
    const notWorked = items.find(e => e.kind === 'not_worked')?.content?.trim() ?? ''
    if (hourly.length === 0 && !notWorked) continue
    out.push(`### ${d}`)
    if (hourly.length) {
      out.push('Hourly:')
      for (const h of hourly) out.push(`  - ${h.time || '—'}: ${h.content}`)
    }
    if (notWorked) out.push(`What didn't work: ${notWorked}`)
    out.push('')
  }
  return out.join('\n').trim()
}

function parseLessonsJson(s: string): { lessons?: any[] } | null {
  const t = s.trim()
  try { return JSON.parse(t) } catch { /* fall through */ }
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i)
  if (fence) { try { return JSON.parse(fence[1]) } catch { /* */ } }
  const start = t.indexOf('{'), end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) } catch { /* */ }
  }
  return null
}
