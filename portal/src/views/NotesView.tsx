import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addNode, createNote, deleteNode, deleteNote, listNotes, loadNodes,
  renameNote, updateNode,
} from '../adapters/notesRepo'
import type { Note, NoteNode } from '../adapters/notesRepo'
import { blobToDataUri } from '../lib/driveImages'
import PageBlocksEditor, {
  parseBlocks, renderBlocksAsHtml, serializeBlocks,
} from '../components/PageBlocksEditor'
import type { PageBlock } from '../components/PageBlocksEditor'
import { sanitizeHtml } from '../lib/sanitize'
import { useToast } from '../components/Toast'

type SidebarMode = 'notes' | 'recent'

// Inline trash SVG so CSS `color` actually paints it.
function TrashIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="currentColor" aria-hidden focusable="false"
    >
      <path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 0 1 0 2h-1.06l-1.13 12.41A2 2 0 0 1 15.82 21H8.18a2 2 0 0 1-2-1.59L5.06 7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 2v0h4V5h-4zm-3 4 1.05 11.6.05.21.18.19h7.44l.18-.19.05-.21L17 9H7zm3 2a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1zm4 0a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z"/>
    </svg>
  )
}

export default function NotesView() {
  const { toast } = useToast()
  const [mode, setMode]                 = useState<SidebarMode>('notes')
  const [notes, setNotes]               = useState<Note[]>([])
  const [openNote, setOpenNote]         = useState<Note | null>(null)
  const [nodes, setNodes]               = useState<NoteNode[]>([])
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle]     = useState('')
  const [blocks, setBlocks]             = useState<PageBlock[]>([])
  const [pageMode, setPageMode]         = useState<'view' | 'edit'>('view')
  const [pageExpanded, setPageExpanded] = useState(false)
  const [dirty, setDirty]               = useState(false)
  const [busy, setBusy]                 = useState(false)
  const [search, setSearch]             = useState('')
  const [loadingNotes, setLoadingNotes] = useState(true)
  const [loadingNote, setLoadingNote]   = useState(false)
  // Land collapsed by default on every device — the dropdown in Col 2 lets
  // the user switch notes without expanding Col 1 first. Click the icons in
  // the strip (📓 / 🕐) to expand into the matching mode.
  const [leftCollapsed, setLeftColl]    = useState(true)
  const [expanded, setExpanded]         = useState<Set<string>>(new Set())
  const [deleteMode, setDeleteMode]     = useState(false)
  const [viewMode, setViewMode]         = useState<'tree' | 'flat'>('tree')
  // Two draggable dividers, expressed as % of the body-wrap width:
  //   col1Ratio       — width of the Notes/Recent column.
  //   col2EndRatio    — right edge of the tree column (col2 width = end - col1).
  // Col3 (the editor) takes whatever's left.
  const [col1Ratio, setCol1Ratio]       = useState(18)
  const [col2EndRatio, setCol2EndRatio] = useState(44)
  // When true, col3 (editor) is hidden and col2 expands to fill the space.
  const [rightHidden, setRightHidden]   = useState(false)
  const bodyWrapRef                     = useRef<HTMLDivElement>(null)
  const isLeftDragging                  = useRef(false)
  const isMidDragging                   = useRef(false)

  // Inline rename state — keyed by the note/node id being edited.
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [editingNoteDraft, setEditNote]   = useState('')
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [editingNodeDraft, setEditNode]   = useState('')

  // ── Draggable dividers ─────────────────────────────────────────────────
  function handleLeftDividerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    isLeftDragging.current = true
    document.body.classList.add('resizing-h')
  }
  function handleLeftDividerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isLeftDragging.current) return
    const c = bodyWrapRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    const pct = ((e.clientX - r.left) / r.width) * 100
    // col1 must leave at least 8% for col2 + 20% for col3
    const max = Math.min(40, col2EndRatio - 12)
    setCol1Ratio(Math.min(Math.max(pct, 12), max))
  }
  function handleLeftDividerUp(e: React.PointerEvent<HTMLDivElement>) {
    isLeftDragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  function handleMidDividerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    isMidDragging.current = true
    document.body.classList.add('resizing-h')
  }
  function handleMidDividerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isMidDragging.current) return
    const c = bodyWrapRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    const pct = ((e.clientX - r.left) / r.width) * 100
    // col2 ends at this %; must leave room for col1 (>= col1+12) and col3 (>= 20)
    const min = Math.max(col1Ratio + 12, 24)
    const max = 80
    setCol2EndRatio(Math.min(Math.max(pct, min), max))
  }
  function handleMidDividerUp(e: React.PointerEvent<HTMLDivElement>) {
    isMidDragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    listNotes()
      .then(list => { setNotes(list); setLoadingNotes(false) })
      .catch(e => { setLoadingNotes(false); toast(`Failed to list notes: ${(e as Error).message}`, 'error') })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-pick the first available note on first load so the user lands on
  // a populated tree instead of a "Pick a note" empty state.
  useEffect(() => {
    if (openNote) return
    if (notes.length === 0) return
    selectNote(notes[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes])

  async function selectNote(n: Note) {
    if (openNote?.id === n.id) return
    setOpenNote(n)
    setActiveNodeId(null)
    setDraftTitle(''); setBlocks([]); setDirty(false)
    setExpanded(new Set())
    setLoadingNote(true)
    try {
      const list = await loadNodes(n.id)
      setNodes(list)
      // Auto-expand the first level so the tree isn't blank.
      const top = list.filter(x => x.parentId === '').map(x => x.id)
      setExpanded(new Set(top))
    } catch (e) {
      toast(`Failed to open note: ${(e as Error).message}`, 'error')
    } finally {
      setLoadingNote(false)
    }
  }

  // ── Tree derivations ─────────────────────────────────────────────────────
  const childrenOf = useMemo(() => {
    const m = new Map<string, NoteNode[]>()
    nodes.forEach(n => {
      const list = m.get(n.parentId) ?? []
      list.push(n)
      m.set(n.parentId, list)
    })
    m.forEach(arr => arr.sort((a, b) => a.position - b.position))
    return m
  }, [nodes])

  const activeNode: NoteNode | null = useMemo(
    () => activeNodeId ? nodes.find(n => n.id === activeNodeId) ?? null : null,
    [activeNodeId, nodes],
  )

  // ── Open a node in the editor ────────────────────────────────────────────
  function openNode(node: NoteNode, forceEdit = false) {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    setActiveNodeId(node.id)
    setDraftTitle(node.title)
    setBlocks(parseBlocks(node.content))
    setDirty(false)
    setPageMode(forceEdit ? 'edit' : 'view')
    setPageExpanded(false)
    setRightHidden(false)
  }

  // ── Notes CRUD ───────────────────────────────────────────────────────────
  async function handleNewNote() {
    const name = window.prompt('New note name:', 'Untitled Note')
    if (name == null) return
    setBusy(true)
    try {
      const created = await createNote(name)
      setNotes(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      await selectNote(created)
      toast('Note created', 'success')
    } catch (e) {
      toast(`Create failed: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }
  function startRenameNote(n: Note) { setEditingNoteId(n.id); setEditNote(n.name) }
  function cancelRenameNote()       { setEditingNoteId(null); setEditNote('') }
  async function commitRenameNote(n: Note) {
    const next = editingNoteDraft.trim()
    setEditingNoteId(null); setEditNote('')
    if (!next || next === n.name) return
    setBusy(true)
    try {
      await renameNote(n.id, next)
      setNotes(prev => prev.map(x => x.id === n.id ? { ...x, name: next } : x))
      if (openNote?.id === n.id) setOpenNote({ ...openNote, name: next })
      toast('Renamed', 'success')
    } catch (e) {
      toast(`Rename failed: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }
  async function handleDeleteNoteById(n: Note) {
    if (!window.confirm(`Delete "${n.name}"? This trashes the entire note Sheet on Drive.`)) return
    setBusy(true)
    try {
      await deleteNote(n.id)
      setNotes(prev => prev.filter(x => x.id !== n.id))
      if (openNote?.id === n.id) {
        setOpenNote(null); setNodes([])
        setActiveNodeId(null); setDraftTitle(''); setBlocks([]); setDirty(false)
      }
      toast('Note deleted', 'success')
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }

  // ── Node CRUD ────────────────────────────────────────────────────────────
  // intent='page'    → create kind=page + open editor (user wants to write content)
  // intent='section' → create kind=section + inline rename (container)
  async function handleAddChild(parentId: string, intent: 'page' | 'section') {
    if (!openNote) return
    setBusy(true)
    try {
      const title   = intent === 'page' ? 'Untitled' : 'New section'
      const created = await addNode(openNote.id, parentId, title, intent)
      setNodes(prev => [...prev, created])
      // Reveal the parent so the new child is visible.
      if (parentId) setExpanded(prev => new Set(prev).add(parentId))
      if (intent === 'page') {
        openNode(created, /* forceEdit */ true)
      } else {
        setEditingNodeId(created.id)
        setEditNode(created.title)
      }
    } catch (e) {
      toast(`Add failed: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }

  function startRenameNode(n: NoteNode) { setEditingNodeId(n.id); setEditNode(n.title) }
  function cancelRenameNode()           { setEditingNodeId(null); setEditNode('') }
  async function commitRenameNode(n: NoteNode) {
    const next = editingNodeDraft.trim()
    setEditingNodeId(null); setEditNode('')
    if (!next || next === n.title || !openNote) return
    setBusy(true)
    try {
      const updated: NoteNode = { ...n, title: next }
      await updateNode(openNote.id, updated)
      setNodes(prev => prev.map(x => x.id === n.id ? { ...x, title: next } : x))
      if (activeNodeId === n.id) setDraftTitle(next)
    } catch (e) {
      toast(`Rename failed: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }

  async function handleDeleteNodeById(n: NoteNode) {
    if (!openNote) return
    const kids = (childrenOf.get(n.id) ?? []).length
    const msg  = kids > 0
      ? `Delete "${n.title}" and its ${kids} child${kids === 1 ? '' : 'ren'}?`
      : `Delete "${n.title}"?`
    if (!window.confirm(msg)) return
    setBusy(true)
    try {
      await deleteNode(openNote.id, n.id)
      // Recompute the surviving nodes after recursive delete.
      const surviving = await loadNodes(openNote.id)
      setNodes(surviving)
      if (activeNodeId && !surviving.find(x => x.id === activeNodeId)) {
        setActiveNodeId(null); setDraftTitle(''); setBlocks([]); setDirty(false)
      }
      toast('Deleted', 'success')
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }

  // ── Save the active node ────────────────────────────────────────────────
  async function handleSave() {
    if (!openNote || !activeNode) return
    setBusy(true)
    try {
      const updated: NoteNode = {
        ...activeNode,
        title:   draftTitle.trim() || 'Untitled',
        content: serializeBlocks(blocks),
      }
      await updateNode(openNote.id, updated)
      setNodes(prev => prev.map(n => n.id === updated.id ? updated : n))
      setDirty(false)
      toast('Saved', 'success')
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }

  // ── Image paste in the editor → inline as a self-contained data: URI ─────
  // Stored in the note HTML directly (no Drive round-trip) so the image loads
  // without the portal's OAuth token — e.g. when the note is copied into Anki.
  function onPasteImage(blob: Blob): Promise<string> {
    return blobToDataUri(blob)
  }

  // Three search axes — combined with AND when more than one is active:
  //   `search`        — Col1, global. Title + content. Filters notes list,
  //                     recent, and the tree.
  //   `treeSearch`    — Col2, name-only. Filters the tree by node title.
  //   `contentSearch` — Col2, content-only. Filters the tree by HTML-
  //                     stripped page body text.
  const [treeSearch, setTreeSearch]       = useState('')
  const [contentSearch, setContentSearch] = useState('')
  const [contentSearchOpen, setContentSearchOpen] = useState(false)
  const trimmedSearch        = search.trim().toLowerCase()
  const trimmedTreeSearch    = treeSearch.trim().toLowerCase()
  // Content filter only counts while the toggle is open — the panel can be
  // closed without clearing the value so it sticks across uses.
  const trimmedContentSearch = contentSearchOpen ? contentSearch.trim().toLowerCase() : ''

  const filteredNotes = useMemo(
    () => !trimmedSearch
      ? notes
      : notes.filter(n => n.name.toLowerCase().includes(trimmedSearch)),
    [notes, trimmedSearch],
  )

  // Set of node ids that should remain visible in the tree.
  //   col1 search: title + content
  //   col2 search: title only
  //   Both empty → no filter (null).
  //   Both active → AND (a node must satisfy both).
  // Plus every match's ancestor chain so the matching node has a navigable
  // context (you can see where it lives in the hierarchy).
  const matchingNodeIds = useMemo<Set<string> | null>(() => {
    if (!trimmedSearch && !trimmedTreeSearch && !trimmedContentSearch) return null
    const m = new Set<string>()
    for (const n of nodes) {
      if (trimmedSearch) {
        const hay = `${n.title} ${n.content.replace(/<[^>]+>/g, ' ')}`.toLowerCase()
        if (!hay.includes(trimmedSearch)) continue
      }
      if (trimmedTreeSearch) {
        if (!n.title.toLowerCase().includes(trimmedTreeSearch)) continue
      }
      if (trimmedContentSearch) {
        const text = n.content.replace(/<[^>]+>/g, ' ').toLowerCase()
        if (!text.includes(trimmedContentSearch)) continue
      }
      m.add(n.id)
    }
    const byId = new Map(nodes.map(n => [n.id, n]))
    for (const id of [...m]) {
      let cur = byId.get(id)
      while (cur && cur.parentId) {
        m.add(cur.parentId)
        cur = byId.get(cur.parentId)
      }
    }
    return m
  }, [nodes, trimmedSearch, trimmedTreeSearch, trimmedContentSearch])

  // Pages of the open note sorted by updatedAt descending — drives the
  // Recent tab so the latest worked-on page is at the top.
  const recentPages = useMemo(
    () => nodes
      .filter(n => n.kind === 'page')
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50),
    [nodes],
  )

  // ── Render ──────────────────────────────────────────────────────────────
  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Flat list of every node, with each item showing its full
  // parent::child::leaf path. Sorted alphabetically by full path.
  function isVisible(n: NoteNode): boolean {
    return matchingNodeIds == null || matchingNodeIds.has(n.id)
  }

  function renderFlat() {
    const byId = new Map(nodes.map(n => [n.id, n]))
    function pathFor(n: NoteNode): string[] {
      const parts: string[] = []
      let cur: NoteNode | undefined = n
      while (cur && cur.parentId) {
        const parent = byId.get(cur.parentId)
        if (!parent) break
        parts.unshift(parent.title)
        cur = parent
      }
      return parts
    }
    const sorted = nodes.filter(isVisible).sort((a, b) => {
      const pa = [...pathFor(a), a.title].join('::').toLowerCase()
      const pb = [...pathFor(b), b.title].join('::').toLowerCase()
      return pa.localeCompare(pb)
    })
    if (sorted.length === 0) {
      return <div className="col-empty">No items yet</div>
    }
    return (
      <ul className="notes-flat-list">
        {sorted.map(n => {
          const isEditing = editingNodeId === n.id
          const isActive  = activeNodeId === n.id
          const path      = pathFor(n)
          return (
            <li
              key={n.id}
              className={`notes-flat-row${isActive ? ' active' : ''}`}
              onDoubleClick={isEditing ? undefined : () => startRenameNode(n)}
            >
              <span className="notes-flat-glyph" aria-hidden>
                {n.kind === 'page' ? '📝' : '📁'}
              </span>
              {isEditing ? (
                <input
                  autoFocus
                  className="notes-rename-input"
                  value={editingNodeDraft}
                  onChange={e => setEditNode(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  onBlur={() => commitRenameNode(n)}
                  onKeyDown={e => {
                    if (e.key === 'Enter')       { e.preventDefault(); commitRenameNode(n) }
                    else if (e.key === 'Escape') { e.preventDefault(); cancelRenameNode() }
                  }}
                />
              ) : (
                <button
                  className="notes-flat-title"
                  onClick={() => openNode(n)}
                  title={[...path, n.title].join('::')}
                >
                  {path.length > 0 && (
                    <span className="notes-flat-path">{path.join(' :: ')}::</span>
                  )}
                  <span className="notes-flat-leaf">{n.title || 'Untitled'}</span>
                  {n.kind === 'page' && n.content.trim() && (
                    <span className="notes-node-dot" aria-hidden>●</span>
                  )}
                </button>
              )}
              {!isEditing && deleteMode && (
                <button
                  className="notes-trash-btn"
                  onClick={() => handleDeleteNodeById(n)}
                  title="Delete"
                ><TrashIcon size={12} /></button>
              )}
            </li>
          )
        })}
      </ul>
    )
  }

  function renderTree(parentId: string, depth: number) {
    const list = (childrenOf.get(parentId) ?? []).filter(isVisible)
    if (list.length === 0) return null
    return (
      <ul className={depth === 0 ? 'notes-tree-root' : 'notes-tree-children'}>
        {list.map(n => {
          const kids       = (childrenOf.get(n.id) ?? []).filter(isVisible)
          // Auto-expand when a search is active so matches are visible.
          const isOpen     = matchingNodeIds != null ? true : expanded.has(n.id)
          const isEditing  = editingNodeId === n.id
          const isActive   = activeNodeId === n.id
          const hasContent = n.content.trim().length > 0
          return (
            <li key={n.id}>
              <div
                className={`notes-node-row${isActive ? ' active' : ''}`}
                onDoubleClick={isEditing ? undefined : () => startRenameNode(n)}
              >
                <button
                  className="notes-node-caret"
                  onClick={() => toggleExpand(n.id)}
                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                  disabled={kids.length === 0}
                  style={{ visibility: kids.length === 0 ? 'hidden' : undefined }}
                >{isOpen ? '▾' : '▸'}</button>

                {isEditing ? (
                  <input
                    autoFocus
                    className="notes-rename-input"
                    value={editingNodeDraft}
                    onChange={e => setEditNode(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onBlur={() => commitRenameNode(n)}
                    onKeyDown={e => {
                      if (e.key === 'Enter')       { e.preventDefault(); commitRenameNode(n) }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelRenameNode() }
                    }}
                  />
                ) : (
                  <button
                    className={`notes-node-title notes-node-${n.kind}`}
                    onClick={() => openNode(n)}
                    title={n.title}
                  >
                    <span className="notes-node-glyph" aria-hidden>
                      {n.kind === 'page' ? '📝' : '📁'}
                    </span>
                    <span className="notes-node-name">{n.title || 'Untitled'}</span>
                    {n.kind === 'page' && hasContent && (
                      <span className="notes-node-dot" aria-hidden title="has content">●</span>
                    )}
                  </button>
                )}

                {!isEditing && (
                  <span className="notes-node-actions">
                    {n.kind === 'section' ? (
                      <>
                        <button
                          onClick={() => handleAddChild(n.id, 'page')}
                          title="Add page (writable content)"
                          disabled={busy}
                        >＋ Page</button>
                        <button
                          onClick={() => handleAddChild(n.id, 'section')}
                          title="Add sub-section (container only)"
                          disabled={busy}
                        >＋ Section</button>
                      </>
                    ) : (
                      <button
                        onClick={() => handleAddChild(n.id, 'page')}
                        title="Add sub-page"
                        disabled={busy}
                      >＋ Sub-page</button>
                    )}
                    {deleteMode && (
                      <button
                        className="notes-trash-btn"
                        onClick={() => handleDeleteNodeById(n)}
                        title="Delete"
                      ><TrashIcon size={12} /></button>
                    )}
                  </span>
                )}
              </div>
              {isOpen && kids.length > 0 && renderTree(n.id, depth + 1)}
            </li>
          )
        })}
      </ul>
    )
  }

  // Filter recent pages by search too — same input drives all three columns.
  const filteredRecent = useMemo(
    () => !trimmedSearch
      ? recentPages
      : recentPages.filter(p => {
          const hay = `${p.title} ${p.content.replace(/<[^>]+>/g, ' ')}`.toLowerCase()
          return hay.includes(trimmedSearch)
        }),
    [recentPages, trimmedSearch],
  )

  // Width of the tree column (col2) in % of body wrap. col2 = end - col1.
  const col2Width = Math.max(0, col2EndRatio - col1Ratio)

  return (
    <div className="browse-body-wrap notes-view-wrap" ref={bodyWrapRef}>
      {/* ── Col 1: Notes / Recent ─────────────────────────────────────── */}
      {!pageExpanded && (
      <div
        className={`browse-col-tags${leftCollapsed ? ' collapsed' : ''}`}
        style={leftCollapsed ? undefined : { width: `${col1Ratio}%` }}
      >
        {leftCollapsed
          ? (
              <div className="notes-strip">
                <button
                  className={`notes-strip-btn${mode === 'notes' ? ' active' : ''}`}
                  onClick={() => { setMode('notes'); setLeftColl(false) }}
                  title="Notes"
                >📓</button>
                <button
                  className={`notes-strip-btn${mode === 'recent' ? ' active' : ''}`}
                  onClick={() => { setMode('recent'); setLeftColl(false) }}
                  title="Recent"
                >🕐</button>
                <button
                  className="notes-strip-btn"
                  onClick={() => setLeftColl(false)}
                  title="Expand"
                >▸</button>
              </div>
            )
          : (
            <>
              <div className="left-tab-bar">
                {(['notes', 'recent'] as SidebarMode[]).map(m => (
                  <button
                    key={m}
                    className={`left-tab${mode === m ? ' active' : ''}`}
                    onClick={() => setMode(m)}
                  >{m === 'notes' ? 'Notes' : 'Recent'}</button>
                ))}
                <button className="panel-toggle-btn" onClick={() => setLeftColl(true)} title="Collapse">◂</button>
              </div>

              {/* Search filters all three columns. Always visible. */}
              <div className="notes-search-row">
                <input
                  className="col-search"
                  placeholder="Search notes, sections, pages, content…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                {search && (
                  <button className="notes-search-clear" onClick={() => setSearch('')} title="Clear">✕</button>
                )}
              </div>

              {mode === 'notes' && (
                <div className="notes-side-body">
                  <div className="notes-side-actions">
                    <button className="rf-btn-save" onClick={handleNewNote} disabled={busy}>＋ Note</button>
                    <button
                      className={`notes-delete-toggle${deleteMode ? ' active' : ''}`}
                      onClick={() => setDeleteMode(d => !d)}
                      title={deleteMode ? 'Hide delete buttons' : 'Show delete buttons on items'}
                    ><TrashIcon size={14} /></button>
                  </div>

                  {loadingNotes ? <div className="col-empty">Loading…</div> : (
                    <ul className="notes-list">
                      {filteredNotes.length === 0 && (
                        <li className="col-empty">{trimmedSearch ? 'No notes match' : 'No notes yet'}</li>
                      )}
                      {filteredNotes.map(n => {
                        const isEditing = editingNoteId === n.id
                        return (
                          <li
                            key={n.id}
                            className={`notes-list-item${openNote?.id === n.id ? ' active' : ''}`}
                            onClick={() => { if (!isEditing) selectNote(n) }}
                            onDoubleClick={e => { e.stopPropagation(); startRenameNote(n) }}
                            title={isEditing ? '' : 'Double-click to rename'}
                          >
                            {isEditing ? (
                              <input
                                autoFocus
                                className="notes-rename-input"
                                value={editingNoteDraft}
                                onChange={e => setEditNote(e.target.value)}
                                onClick={e => e.stopPropagation()}
                                onBlur={() => commitRenameNote(n)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter')       { e.preventDefault(); commitRenameNote(n) }
                                  else if (e.key === 'Escape') { e.preventDefault(); cancelRenameNote() }
                                }}
                              />
                            ) : (
                              <span className="notes-list-name">{n.name}</span>
                            )}
                            {!isEditing && deleteMode && (
                              <button
                                className="notes-list-delete"
                                onClick={e => { e.stopPropagation(); handleDeleteNoteById(n) }}
                                title="Delete this note"
                              ><TrashIcon size={12} /></button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )}

              {mode === 'recent' && (
                <div className="notes-side-body">
                  {!openNote ? (
                    <div className="col-empty">Open a note first.</div>
                  ) : filteredRecent.length === 0 ? (
                    <div className="col-empty">{trimmedSearch ? 'No pages match' : 'No edited pages yet.'}</div>
                  ) : (
                    <ul className="notes-search-list">
                      {filteredRecent.map(p => (
                        <li key={p.id} onClick={() => openNode(p)}>
                          <div className="notes-search-title">{p.title || 'Untitled'}</div>
                          <div className="notes-search-meta">updated {fmtRelative(p.updatedAt)}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
      </div>

      )}

      {/* Divider between col1 and col2 */}
      {!pageExpanded && !leftCollapsed && (
        <div
          className="qa-divider"
          onPointerDown={handleLeftDividerDown}
          onPointerMove={handleLeftDividerMove}
          onPointerUp={handleLeftDividerUp}
          onPointerCancel={handleLeftDividerUp}
        />
      )}

      {/* ── Col 2: section / page tree of the open note ─────────────── */}
      {!pageExpanded && (
      <div className="notes-tree-col" style={rightHidden ? { flex: 1 } : { width: `${col2Width}%` }}>
        {notes.length === 0 ? (
          <div className="col-empty" style={{ padding: 18, textAlign: 'center' }}>
            Create a note in the left column.
          </div>
        ) : !openNote ? (
          <div className="col-empty" style={{ padding: 18, textAlign: 'center' }}>
            Pick a note on the left.
          </div>
        ) : (
          <div className="notes-tree" style={{ marginTop: 0, borderTop: 0 }}>
            <div
              className={`notes-tree-hd${rightHidden ? ' notes-tree-hd--expanded' : ''}`}
              onDoubleClick={() => setRightHidden(h => !h)}
              title="Double-click to expand / restore"
            >
              {/* Note picker — auto-fills when there's only one. */}
              {notes.length === 1 ? (
                <span title={openNote.name}>{openNote.name}</span>
              ) : (
                <select
                  className="notes-tree-select"
                  value={openNote.id}
                  onChange={e => {
                    const next = notes.find(n => n.id === e.target.value)
                    if (next && next.id !== openNote.id) selectNote(next)
                  }}
                  onDoubleClick={e => e.stopPropagation()}
                  title="Switch note"
                >
                  {notes.map(n => (
                    <option key={n.id} value={n.id}>{n.name}</option>
                  ))}
                </select>
              )}
              <div className="view-mode-toggle" onDoubleClick={e => e.stopPropagation()}>
                <button
                  className={`vm-btn${viewMode === 'tree' ? ' active' : ''}`}
                  title="Hierarchical tree"
                  onClick={() => setViewMode('tree')}
                >⊞</button>
                <button
                  className={`vm-btn${viewMode === 'flat' ? ' active' : ''}`}
                  title="Flat list with parent path"
                  onClick={() => setViewMode('flat')}
                >≡</button>
              </div>
              <button
                className="notes-add-link"
                onClick={() => handleAddChild('', 'section')}
                onDoubleClick={e => e.stopPropagation()}
                disabled={busy}
                title="Add top-level section"
              >＋ Section</button>
              <button
                className="notes-add-link"
                onClick={() => handleAddChild('', 'page')}
                onDoubleClick={e => e.stopPropagation()}
                disabled={busy}
                title="Add top-level page"
              >＋ Page</button>
            </div>
            <div className="notes-search-row">
              <span className="notes-search-icon" title="Filter by section / page name">🏷</span>
              <input
                className="col-search"
                placeholder="Filter sections / pages by name…"
                value={treeSearch}
                onChange={e => setTreeSearch(e.target.value)}
              />
              {treeSearch && (
                <button
                  className="notes-search-clear"
                  onClick={() => setTreeSearch('')}
                  title="Clear name filter"
                >✕</button>
              )}
              <button
                className={`notes-search-toggle${contentSearchOpen ? ' active' : ''}`}
                onClick={() => setContentSearchOpen(o => !o)}
                title={contentSearchOpen ? 'Hide content search' : 'Search inside page content'}
              >📝</button>
            </div>
            {contentSearchOpen && (
              <div className="notes-search-row">
                <span className="notes-search-icon" title="Search inside page content">📝</span>
                <input
                  className="col-search"
                  autoFocus
                  placeholder="Search content of the filtered pages…"
                  value={contentSearch}
                  onChange={e => setContentSearch(e.target.value)}
                />
                {contentSearch && (
                  <button
                    className="notes-search-clear"
                    onClick={() => setContentSearch('')}
                    title="Clear content filter"
                  >✕</button>
                )}
              </div>
            )}
            <div className="notes-tree-body">
              {loadingNote ? (
                <div className="col-empty">Loading…</div>
              ) : viewMode === 'tree' ? (
                renderTree('', 0) ?? <div className="col-empty">No matches</div>
              ) : (
                renderFlat()
              )}
            </div>
          </div>
        )}
      </div>

      )}

      {/* Divider between col2 and col3 */}
      {!pageExpanded && !rightHidden && (
        <div
          className="qa-divider"
          onPointerDown={handleMidDividerDown}
          onPointerMove={handleMidDividerMove}
          onPointerUp={handleMidDividerUp}
          onPointerCancel={handleMidDividerUp}
        />
      )}

      {/* ── Col 3: editor ─────────────────────────────────────────────── */}
      {!rightHidden && <div className="browse-main">
        {!openNote ? (
          <div className="done-state" style={{ flex: 1 }}>
            <div className="done-icon">📓</div>
            <h3>Pick or create a note</h3>
            <p>Notes live in your Drive folder <code>{`PGHubTechNotes`}</code>.</p>
          </div>
        ) : !activeNode ? (
          <div className="done-state" style={{ flex: 1 }}>
            <div className="done-icon">📝</div>
            <h3>{openNote.name}</h3>
            <p>Pick a node from the sidebar, or use ＋ Page / ＋ Section to add one.</p>
          </div>
        ) : (
          <div className="notes-editor-wrap">
            <div
              className="col-hd doc-detail-hd notes-page-hd"
              style={{ padding: '10px 12px', flexShrink: 0, gap: 8 }}
              onDoubleClick={() => setPageExpanded(e => !e)}
              title="Double-click to expand / restore"
            >
              {pageMode === 'view' ? (
                <span className="notes-editor-title-static">
                  {draftTitle || 'Untitled'}
                </span>
              ) : (
                <input
                  className="rf-input notes-editor-title"
                  value={draftTitle}
                  placeholder="Title"
                  onChange={e => { setDraftTitle(e.target.value); setDirty(true) }}
                />
              )}
              <div
                style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}
                onDoubleClick={e => e.stopPropagation()}
              >
                <button
                  className={`bci-edit-btn bci-edit-btn-hd${pageExpanded ? ' active' : ''}`}
                  onClick={() => setPageExpanded(e => !e)}
                  title={pageExpanded ? 'Restore' : 'Expand viewer'}
                >{pageExpanded ? '⤡' : '⤢'}</button>
                {pageMode === 'view' ? (
                  <>
                    <button
                      className="rf-btn-save"
                      onClick={() => setPageMode('edit')}
                    >Edit</button>
                    <button
                      className="detail-close-btn"
                      onClick={() => {
                        setActiveNodeId(null)
                        setDraftTitle('')
                        setBlocks([])
                        setDirty(false)
                        setPageExpanded(false)
                        setRightHidden(true)
                      }}
                      title="Close page"
                    >✕</button>
                  </>
                ) : (
                  <>
                    <button
                      className="rf-btn-cancel"
                      onClick={() => {
                        if (dirty && !window.confirm('Discard unsaved changes?')) return
                        setDraftTitle(activeNode.title)
                        setBlocks(parseBlocks(activeNode.content))
                        setDirty(false)
                        setPageMode('view')
                      }}
                      disabled={busy}
                    >Done</button>
                    <button
                      className="rf-btn-cancel"
                      onClick={() => {
                        setDraftTitle(activeNode.title)
                        setBlocks(parseBlocks(activeNode.content))
                        setDirty(false)
                      }}
                      disabled={!dirty || busy}
                    >Reset</button>
                    <button
                      className="rf-btn-save"
                      onClick={handleSave}
                      disabled={!dirty || busy}
                    >{busy ? 'Saving…' : 'Save'}</button>
                    <button
                      className="detail-close-btn"
                      onClick={() => {
                        if (dirty && !window.confirm('Discard unsaved changes?')) return
                        setActiveNodeId(null)
                        setDraftTitle('')
                        setBlocks([])
                        setDirty(false)
                        setPageMode('view')
                        setPageExpanded(false)
                        setRightHidden(true)
                      }}
                      title="Close page"
                    >✕</button>
                  </>
                )}
              </div>
            </div>

            <div className="notes-editor-body">
              {pageMode === 'view' ? (
                <div
                  className="page-render"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderBlocksAsHtml(blocks)) }}
                />
              ) : (
                <PageBlocksEditor
                  blocks={blocks}
                  onChange={next => { setBlocks(next); setDirty(true) }}
                  onPasteImage={onPasteImage}
                />
              )}
            </div>
          </div>
        )}
      </div>}
    </div>
  )
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString()
}

function fmtRelative(iso: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (isNaN(t)) return ''
  const diff = Math.max(0, Date.now() - t)
  const mins = Math.floor(diff / 60_000)
  if (mins < 1)   return 'just now'
  if (mins < 60)  return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7)   return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}
