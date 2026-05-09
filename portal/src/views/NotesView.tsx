import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addNode, createNote, deleteNode, deleteNote, listNotes, loadNodes,
  renameNote, updateNode,
} from '../adapters/notesRepo'
import type { Note, NoteNode } from '../adapters/notesRepo'
import { GAuth } from '../lib/gauth'
import { getOrCreateFolder, uploadFileToDrive } from '../lib/drive'
import PageBlocksEditor, {
  parseBlocks, renderBlocksAsHtml, serializeBlocks,
} from '../components/PageBlocksEditor'
import type { PageBlock } from '../components/PageBlocksEditor'
import { sanitizeHtml } from '../lib/sanitize'
import { useToast } from '../components/Toast'

type SidebarMode = 'notes' | 'search' | 'recent'
const NOTES_IMG_FOLDER = 'PGHubTechImages'

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
  const [dirty, setDirty]               = useState(false)
  const [busy, setBusy]                 = useState(false)
  const [search, setSearch]             = useState('')
  const [loadingNotes, setLoadingNotes] = useState(true)
  const [loadingNote, setLoadingNote]   = useState(false)
  const [leftCollapsed, setLeftColl]    = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  )
  const [expanded, setExpanded]         = useState<Set<string>>(new Set())
  const [deleteMode, setDeleteMode]     = useState(false)
  const [tagsRatio, setTagsRatio]       = useState(22)
  const bodyWrapRef                     = useRef<HTMLDivElement>(null)
  const isLeftDragging                  = useRef(false)

  // Inline rename state — keyed by the note/node id being edited.
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [editingNoteDraft, setEditNote]   = useState('')
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [editingNodeDraft, setEditNode]   = useState('')

  // ── Draggable left-divider ───────────────────────────────────────────────
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
    setTagsRatio(Math.min(Math.max(pct, 14), 50))
  }
  function handleLeftDividerUp(e: React.PointerEvent<HTMLDivElement>) {
    isLeftDragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    listNotes()
      .then(list => { setNotes(list); setLoadingNotes(false) })
      .catch(e => { setLoadingNotes(false); toast(`Failed to list notes: ${(e as Error).message}`, 'error') })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Image paste in the editor → upload to PGHubTechImages ───────────────
  async function onPasteImage(blob: Blob): Promise<string> {
    const token = GAuth.getToken()
    if (!token) throw new Error('Not signed in')
    const folder = await getOrCreateFolder(token, NOTES_IMG_FOLDER)
    const ext   = (blob.type.split('/')[1] || 'png').replace('+xml', '')
    const fname = `note_${Date.now().toString(36)}.${ext}`
    const { url } = await uploadFileToDrive(token, folder, blob, fname, 'image/png')
    return url
  }

  // ── Search across this note's nodes ─────────────────────────────────────
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return [] as NoteNode[]
    return nodes.filter(n => {
      const hay = `${n.title} ${n.content.replace(/<[^>]+>/g, ' ')}`.toLowerCase()
      return hay.includes(q)
    })
  }, [search, nodes])

  // ── Render ──────────────────────────────────────────────────────────────
  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function renderTree(parentId: string, depth: number) {
    const list = childrenOf.get(parentId) ?? []
    return (
      <ul className={depth === 0 ? 'notes-tree-root' : 'notes-tree-children'}>
        {list.map(n => {
          const kids       = childrenOf.get(n.id) ?? []
          const isOpen     = expanded.has(n.id)
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

  return (
    <div className="browse-body-wrap" ref={bodyWrapRef}>
      {/* Sidebar (resizable) */}
      <div
        className={`browse-col-tags${leftCollapsed ? ' collapsed' : ''}`}
        style={leftCollapsed ? undefined : { width: `${tagsRatio}%` }}
      >
        {leftCollapsed
          ? <button className="panel-strip-btn" onClick={() => setLeftColl(false)} title="Show notes">▸</button>
          : (
            <>
              <div className="left-tab-bar">
                {(['notes', 'search', 'recent'] as SidebarMode[]).map(m => (
                  <button
                    key={m}
                    className={`left-tab${mode === m ? ' active' : ''}`}
                    onClick={() => setMode(m)}
                  >{m === 'notes' ? 'Notes' : m === 'search' ? 'Search' : 'Recent'}</button>
                ))}
                <button className="panel-toggle-btn" onClick={() => setLeftColl(true)} title="Collapse">◂</button>
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
                      {notes.length === 0 && <li className="col-empty">No notes yet</li>}
                      {notes.map(n => {
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

                  {openNote && (
                    <div className="notes-tree">
                      <div className="notes-tree-hd">
                        <span>{openNote.name}</span>
                        <button
                          className="notes-add-link"
                          onClick={() => handleAddChild('', 'section')}
                          disabled={busy}
                          title="Add top-level section"
                        >＋ Section</button>
                        <button
                          className="notes-add-link"
                          onClick={() => handleAddChild('', 'page')}
                          disabled={busy}
                          title="Add top-level page"
                        >＋ Page</button>
                      </div>
                      {loadingNote ? <div className="col-empty">Loading…</div> : renderTree('', 0)}
                    </div>
                  )}
                </div>
              )}

              {mode === 'search' && (
                <div className="notes-side-body">
                  <input
                    className="col-search"
                    placeholder={openNote ? `Search in "${openNote.name}"…` : 'Open a note first'}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    disabled={!openNote}
                    style={{ margin: 8 }}
                  />
                  {!openNote ? (
                    <div className="col-empty">Open a note from the Notes tab.</div>
                  ) : searchResults.length === 0 ? (
                    <div className="col-empty">{search.trim() ? 'No matches' : 'Type to search'}</div>
                  ) : (
                    <ul className="notes-search-list">
                      {searchResults.map(n => (
                        <li key={n.id} onClick={() => openNode(n)}>
                          <div className="notes-search-title">{n.title}</div>
                          <div className="notes-search-meta">
                            {n.content.trim() ? 'page' : 'section'} · updated {fmtDate(n.updatedAt)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {mode === 'recent' && (
                <div className="notes-side-body">
                  <div className="col-empty" style={{ padding: 24 }}>
                    Recent activity tracking is coming in a follow-up.
                  </div>
                </div>
              )}
            </>
          )}
      </div>

      {/* Draggable divider between sidebar and editor */}
      {!leftCollapsed && (
        <div
          className="qa-divider"
          onPointerDown={handleLeftDividerDown}
          onPointerMove={handleLeftDividerMove}
          onPointerUp={handleLeftDividerUp}
          onPointerCancel={handleLeftDividerUp}
        />
      )}

      {/* Editor */}
      <div className="browse-main">
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
            <div className="col-hd" style={{ padding: '10px 12px', flexShrink: 0, gap: 8 }}>
              <input
                className="rf-input notes-editor-title"
                value={draftTitle}
                placeholder="Title"
                onChange={e => { setDraftTitle(e.target.value); setDirty(true) }}
                disabled={pageMode === 'view'}
              />
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                {pageMode === 'view' ? (
                  <button
                    className="rf-btn-save"
                    onClick={() => setPageMode('edit')}
                  >Edit</button>
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
      </div>
    </div>
  )
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString()
}
