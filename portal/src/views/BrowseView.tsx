import { useState, useEffect, useMemo, useRef } from 'react'
import type { AnkiNote, AnkiTemplate } from '../adapters/ankiRepo'
import { loadAnkiTemplates, loadAllNotes, deleteAnkiNotes } from '../adapters/ankiRepo'
import { getAllSRS, isDue } from '../adapters/srsRepo'
import type { SRSRecord } from '../adapters/srsRepo'
import { getCardFrontText } from '../utils/cardHelpers'
import TagDeckTree from '../components/TagDeckTree'
import NoteDetailPanel from '../components/NoteDetailPanel'
import AddNoteModal from '../components/AddNoteModal'
import CsvUploadModal from '../components/CsvUploadModal'
import { useToast } from '../components/Toast'
import { loadFilters, saveFilters } from '../lib/persistedFilters'

// Filter state persisted across logout/login (see lib/persistedFilters.ts).
const BROWSE_FILTERS_KEY = 'pghub.browse.filters'
interface BrowseFilters { tags: string[]; decks: string[]; search: string }
const BROWSE_FILTERS_DEFAULTS: BrowseFilters = { tags: [], decks: [], search: '' }

// ── Schedule cell ─────────────────────────────────────────────────────────────

function ScheduleCell({ rec }: { rec: SRSRecord | undefined }) {
  if (!rec || rec.reps === 0) {
    return <span className="bgt-sched-new">New</span>
  }
  if (isDue(rec)) {
    return <span className="bgt-sched-due">Due</span>
  }
  const nextMs = new Date(rec.nextDue).getTime()
  const diffMs = nextMs - Date.now()
  const days   = Math.ceil(diffMs / (24 * 3600 * 1000))
  let label: string
  if (days <= 0)       label = 'Due'
  else if (days === 1) label = 'Tomorrow'
  else if (days < 7)   label = `in ${days}d`
  else if (days < 30)  label = `in ${Math.round(days / 7)}w`
  else                 label = `in ${Math.round(days / 30)}mo`
  return <span className="bgt-sched-ok">{label}</span>
}

function relativeDate(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  const diffDays = Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000))
  if (diffDays <= 0)  return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7)   return `${diffDays}d ago`
  if (diffDays < 30)  return `${Math.round(diffDays / 7)}w ago`
  return `${Math.round(diffDays / 30)}mo ago`
}

function chipLabel(path: string): string {
  const parts = path.split('::')
  return parts.length <= 2 ? path : `…::${parts.slice(-2).join('::')}`
}


// ── Main view ─────────────────────────────────────────────────────────────────

export default function BrowseView() {
  const { toast } = useToast()

  const [notes,       setNotes]       = useState<AnkiNote[]>([])
  const [templates,   setTemplates]   = useState<Map<string, AnkiTemplate>>(new Map())
  const [loading,     setLoading]     = useState(true)
  const [srsMap,      setSrsMap]      = useState<Map<string, SRSRecord>>(new Map())

  const [selectedNote, setSelectedNote] = useState<AnkiNote | null>(null)

  const [showAdd,      setShowAdd]      = useState(false)
  // When the sidebar "+ Deck" affordance is used, we prompt for a name and
  // open the Add Note modal pre-filled with it. Cleared after the modal closes.
  const [newDeckDraft, setNewDeckDraft] = useState<string>('')
  const [showUpload,   setShowUpload]   = useState(false)
  const [selectedIds,  setSelectedIds]  = useState<Set<string>>(new Set())
  const [deleting,     setDeleting]     = useState(false)

  // Persisted filters — load once on mount; saved via the effect below.
  const _persisted = useMemo(() => loadFilters(BROWSE_FILTERS_KEY, BROWSE_FILTERS_DEFAULTS), [])
  const [search,        setSearch]        = useState<string>(_persisted.search)
  const [selectedTags,  setSelectedTags]  = useState<string[]>(_persisted.tags)
  const [selectedDecks, setSelectedDecks] = useState<string[]>(_persisted.decks)

  // Persist filter changes — Clear All triggers the effect too (state goes
  // to defaults; effect writes those back).
  useEffect(() => {
    saveFilters<BrowseFilters>(BROWSE_FILTERS_KEY, {
      tags: selectedTags, decks: selectedDecks, search,
    })
  }, [selectedTags, selectedDecks, search])
  const [leftCollapsed, setLeftCollapsed] = useState(true)
  const [viewerExpanded, setViewerExpanded] = useState(false)

  const [browseRatio,    setBrowseRatio]    = useState(60)
  const browseContainerRef                  = useRef<HTMLDivElement>(null)
  const isDividerDragging                   = useRef(false)

  // ── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      try {
        const tmpls = await loadAnkiTemplates()
        setTemplates(tmpls)
        const allNotes = await loadAllNotes(tmpls)
        setNotes(allNotes)
        setSrsMap(getAllSRS())
      } catch (e) {
        toast(`Failed to load: ${(e as Error).message}`, 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Divider drag ──────────────────────────────────────────────────────────
  function handleDividerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    isDividerDragging.current = true
    document.body.classList.add('resizing-h')
  }
  function handleDividerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDividerDragging.current) return
    const container = browseContainerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const pct  = ((e.clientX - rect.left) / rect.width) * 100
    setBrowseRatio(Math.min(Math.max(pct, 25), 80))
  }
  function handleDividerPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    isDividerDragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  // ── Filtering ─────────────────────────────────────────────────────────────
  const filteredNotes = useMemo(() => {
    const s = search.trim().toLowerCase()
    return notes.filter(n => {
      if (selectedDecks.length > 0) {
        if (!selectedDecks.some(sd => n.deck === sd || n.deck.startsWith(sd + '::'))) return false
      }
      if (selectedTags.length > 0) {
        if (!selectedTags.every(st => n.tags.some(t => t === st || t.startsWith(st + '::')))) return false
      }
      if (s) {
        const tmpl = templates.get(n.templateId)
        const frontText = tmpl ? getCardFrontText(n, tmpl).toLowerCase() : ''
        if (!frontText.includes(s) && !n.deck.toLowerCase().includes(s) &&
            !n.tags.some(t => t.toLowerCase().includes(s))) return false
      }
      return true
    })
  }, [notes, selectedDecks, selectedTags, search, templates])

  const hasFilters = selectedTags.length > 0 || selectedDecks.length > 0

  const existingDecks = useMemo(() => {
    const seen = new Set<string>()
    notes.forEach(n => { if (n.deck) seen.add(n.deck) })
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [notes])

  const existingTags = useMemo(() => {
    const seen = new Set<string>()
    notes.forEach(n => n.tags.forEach(t => { if (t) seen.add(t) }))
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [notes])

  function handleNoteAdded(note: AnkiNote) {
    setNotes(prev => [note, ...prev])
  }

  function handleImportDone(added: AnkiNote[]) {
    setNotes(prev => [...added, ...prev])
  }

  // ── Multi-select ─────────────────────────────────────────────────────────────
  const allFilteredSelected =
    filteredNotes.length > 0 && filteredNotes.every(n => selectedIds.has(n.noteId))
  const someSelected = selectedIds.size > 0

  function toggleRowCheck(noteId: string, e: React.ChangeEvent<HTMLInputElement>) {
    e.stopPropagation()
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(noteId)) next.delete(noteId); else next.add(noteId)
      return next
    })
  }

  function toggleSelectAll() {
    if (allFilteredSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredNotes.map(n => n.noteId)))
    }
  }

  async function handleDeleteSelected() {
    const count = selectedIds.size
    if (count === 0) return
    if (!window.confirm(`Delete ${count} card${count === 1 ? '' : 's'}? This cannot be undone.`)) return
    setDeleting(true)
    try {
      const toDelete = notes.filter(n => selectedIds.has(n.noteId))
      await deleteAnkiNotes(toDelete)
      setNotes(prev => prev.filter(n => !selectedIds.has(n.noteId)))
      if (selectedNote && selectedIds.has(selectedNote.noteId)) setSelectedNote(null)
      setSelectedIds(new Set())
      toast(`Deleted ${count} card${count === 1 ? '' : 's'}`, 'success')
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'error')
    } finally {
      setDeleting(false)
    }
  }

  function handleSelect(note: AnkiNote) {
    setSelectedNote(prev => prev?.noteId === note.noteId ? null : note)
  }

  // Drop expand state whenever the selection clears so a fresh open of any
  // card lands on the standard split layout.
  useEffect(() => {
    if (!selectedNote) setViewerExpanded(false)
  }, [selectedNote?.noteId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="browse-body-wrap">
      {/* Left: tag/deck tree (collapsed when viewer is expanded so the
          detail can take the full main width). */}
      <div className={`browse-col-tags${(leftCollapsed || viewerExpanded) ? ' collapsed' : ''}`}>
        <TagDeckTree
          notes={notes}
          selectedTags={selectedTags}
          selectedDecks={selectedDecks}
          onToggleTag={t => setSelectedTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])}
          onToggleDeck={d => setSelectedDecks(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])}
          onClearAll={() => { setSelectedTags([]); setSelectedDecks([]) }}
          collapsed={leftCollapsed || viewerExpanded}
          onCollapse={() => {
            // Clicking the strip while forced-collapsed (because viewer
            // is expanded) restores the full split layout.
            if (viewerExpanded) {
              setViewerExpanded(false)
              setLeftCollapsed(false)
            } else {
              setLeftCollapsed(c => !c)
            }
          }}
          onNewDeck={() => {
            const name = window.prompt('New deck name (use :: for nesting, e.g. Snowflake::Coding):')?.trim()
            if (!name) return
            setNewDeckDraft(name)
            setShowAdd(true)
          }}
        />
      </div>

      {/* Mobile-only backdrop — tap closes the tag drawer */}
      {!leftCollapsed && (
        <div className="drawer-backdrop" onClick={() => setLeftCollapsed(true)} />
      )}

      {/* Add + CSV upload modals */}
      <AddNoteModal
        open={showAdd}
        onClose={() => { setShowAdd(false); setNewDeckDraft('') }}
        templates={templates}
        existingDecks={existingDecks}
        existingTags={existingTags}
        onNoteAdded={handleNoteAdded}
        defaultDeck={newDeckDraft}
      />
      <CsvUploadModal
        open={showUpload}
        onClose={() => setShowUpload(false)}
        templates={templates}
        existingDecks={existingDecks}
        onImportDone={handleImportDone}
      />

      {/* Main: cards table + detail split */}
      <div className="browse-main">
        {/* Toolbar */}
        <div className="browse-toolbar">
          <button
            className={`mobile-filter-btn${hasFilters ? ' has-active' : ''}`}
            onClick={() => setLeftCollapsed(false)}
            title="Filter by tag or deck"
          >
            ☰ Filter{hasFilters ? ` (${selectedTags.length + selectedDecks.length})` : ''}
          </button>
          <input
            className="col-search"
            style={{ width: 240 }}
            placeholder="Search cards…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
            {filteredNotes.length.toLocaleString()} / {notes.length.toLocaleString()} cards
          </span>

          <div className="browse-action-btns">
            {someSelected && (
              <button
                className="browse-delete-btn"
                onClick={handleDeleteSelected}
                disabled={deleting}
                title={`Delete ${selectedIds.size} selected card${selectedIds.size === 1 ? '' : 's'}`}
              >{deleting ? 'Deleting…' : `Delete ${selectedIds.size}`}</button>
            )}
            <button
              className="browse-add-btn"
              onClick={() => setShowAdd(true)}
              title="Add a new note"
            >+ Add</button>
            <button
              className="browse-upload-btn"
              onClick={() => setShowUpload(true)}
              title="Bulk import notes from CSV"
            >↑ Upload</button>
          </div>

          {hasFilters && (
            <div className="applied-filter-chips">
              {selectedDecks.map(d => (
                <span key={d} className="applied-chip deck-chip" title={d}>
                  <span className="chip-icon">⬡</span>
                  <span className="chip-label">{chipLabel(d)}</span>
                  <button className="chip-rm" onClick={() => setSelectedDecks(prev => prev.filter(x => x !== d))}>×</button>
                </span>
              ))}
              {selectedTags.map(t => (
                <span key={t} className="applied-chip tag-chip" title={t}>
                  <span className="chip-label">{chipLabel(t)}</span>
                  <button className="chip-rm" onClick={() => setSelectedTags(prev => prev.filter(x => x !== t))}>×</button>
                </span>
              ))}
              <button className="applied-clear-all" onClick={() => { setSelectedTags([]); setSelectedDecks([]) }}>
                Clear all
              </button>
            </div>
          )}
        </div>

        {/* Cards + detail split */}
        <div className="browse-cards-split" ref={browseContainerRef}>

          {/* Card list — hidden when viewer is expanded */}
          {!viewerExpanded && (
          <div
            className="browse-col-cards"
            style={selectedNote ? { flex: `0 0 ${browseRatio}%` } : undefined}
          >
            {loading ? (
              <div className="browse-stream-init">
                <div className="browse-stream-spinner" />
                <span>Loading…</span>
              </div>
            ) : filteredNotes.length === 0 ? (
              <div className="done-state">
                <div className="done-icon">📭</div>
                <h3>No cards found</h3>
                <p>Try adjusting your filters or search.</p>
              </div>
            ) : (
              <table className="bgt">
                <thead>
                  <tr className="bgt-hd-row">
                    <th className="bgt-th bgt-th-check" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="bgt-checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAll}
                        title={allFilteredSelected ? 'Deselect all' : 'Select all filtered'}
                      />
                    </th>
                    <th className="bgt-th bgt-th-title">Question</th>
                    <th className="bgt-th">Deck</th>
                    <th className="bgt-th">Tags</th>
                    <th className="bgt-th bgt-th-prog">Schedule</th>
                    <th className="bgt-th bgt-th-tmpl">Template</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNotes.map(n => {
                    const tmpl  = templates.get(n.templateId)
                    const title = tmpl ? getCardFrontText(n, tmpl) : n.noteId
                    const rec   = srsMap.get(n.noteId)
                    const isSel = selectedNote?.noteId === n.noteId

                    const isChecked = selectedIds.has(n.noteId)
                    return (
                      <tr
                        key={n.noteId}
                        className={`bgt-row${isSel ? ' sel' : ''}${isChecked ? ' checked' : ''}`}
                        onClick={() => handleSelect(n)}
                      >
                        <td className="bgt-td bgt-td-check" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="bgt-checkbox"
                            checked={isChecked}
                            onChange={e => toggleRowCheck(n.noteId, e)}
                          />
                        </td>
                        <td className="bgt-td bgt-td-title">{title || n.noteId}</td>
                        <td className="bgt-td" style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                          {n.deck.split('::').pop() || '—'}
                        </td>
                        <td className="bgt-td bgt-td-tags">
                          {n.tags.slice(0, 3).map(t => t.split('::').pop()).join(', ') || '—'}
                        </td>
                        <td className="bgt-td bgt-td-prog"><ScheduleCell rec={rec} /></td>
                        <td className="bgt-td bgt-td-tmpl">
                          {tmpl ? tmpl.displayName : <span className="bgt-prog-dim">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          )}

          {/* Draggable divider + detail panel */}
          {selectedNote && (() => {
            const tmpl    = templates.get(selectedNote.templateId)
            const rec     = srsMap.get(selectedNote.noteId)
            const lastSeen = rec?.lastReviewed ? relativeDate(rec.lastReviewed) : ''
            if (!tmpl) return null
            return (
              <>
                {!viewerExpanded && (
                  <div
                    className="qa-divider"
                    onPointerDown={handleDividerPointerDown}
                    onPointerMove={handleDividerPointerMove}
                    onPointerUp={handleDividerPointerUp}
                    onPointerCancel={handleDividerPointerUp}
                  />
                )}
                <div className="browse-col-detail has-selection" style={viewerExpanded ? { flex: 1 } : undefined}>
                  <NoteDetailPanel
                    note={selectedNote}
                    template={tmpl}
                    rec={rec}
                    lastSeen={lastSeen}
                    existingTags={existingTags}
                    expanded={viewerExpanded}
                    onToggleExpand={() => setViewerExpanded(e => !e)}
                    onClose={() => setSelectedNote(null)}
                    onNoteSaved={updated => {
                      setNotes(prev => prev.map(n => n.noteId === updated.noteId ? updated : n))
                      // Only swap selection if the user is still on this note;
                      // a background save (after switching) shouldn't drag them back.
                      setSelectedNote(prev => prev?.noteId === updated.noteId ? updated : prev)
                    }}
                  />
                </div>
              </>
            )
          })()}
        </div>
      </div>
    </div>
  )
}
