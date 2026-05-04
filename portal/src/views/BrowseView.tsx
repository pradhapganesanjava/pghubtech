import { useState, useEffect, useMemo, useRef } from 'react'
import type { AnkiNote, AnkiTemplate } from '../adapters/ankiRepo'
import { loadAnkiTemplates, loadAllNotes } from '../adapters/ankiRepo'
import { getAllSRS, isDue } from '../adapters/srsRepo'
import type { SRSRecord } from '../adapters/srsRepo'
import { getCardFrontText } from '../utils/cardHelpers'
import TagDeckTree from '../components/TagDeckTree'
import NoteDetailPanel from '../components/NoteDetailPanel'
import { useToast } from '../components/Toast'

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

  const [search,        setSearch]        = useState('')
  const [selectedTags,  setSelectedTags]  = useState<string[]>([])
  const [selectedDecks, setSelectedDecks] = useState<string[]>([])
  const [leftCollapsed, setLeftCollapsed] = useState(true)

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

  function handleSelect(note: AnkiNote) {
    setSelectedNote(prev => prev?.noteId === note.noteId ? null : note)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="browse-body-wrap">
      {/* Left: tag/deck tree */}
      <div className={`browse-col-tags${leftCollapsed ? ' collapsed' : ''}`}>
        <TagDeckTree
          notes={notes}
          selectedTags={selectedTags}
          selectedDecks={selectedDecks}
          onToggleTag={t => setSelectedTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])}
          onToggleDeck={d => setSelectedDecks(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])}
          onClearAll={() => { setSelectedTags([]); setSelectedDecks([]) }}
          collapsed={leftCollapsed}
          onCollapse={() => setLeftCollapsed(c => !c)}
        />
      </div>

      {/* Main: cards table + detail split */}
      <div className="browse-main">
        {/* Toolbar */}
        <div className="browse-toolbar">
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

          {/* Card list */}
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
                    <th className="bgt-th bgt-th-title">Question</th>
                    <th className="bgt-th">Deck</th>
                    <th className="bgt-th">Tags</th>
                    <th className="bgt-th bgt-th-prog">Schedule</th>
                    <th className="bgt-th bgt-th-prog">Reviews</th>
                    <th className="bgt-th bgt-th-prog">Lapses</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNotes.map(n => {
                    const tmpl  = templates.get(n.templateId)
                    const title = tmpl ? getCardFrontText(n, tmpl) : n.noteId
                    const rec   = srsMap.get(n.noteId)
                    const isSel = selectedNote?.noteId === n.noteId

                    return (
                      <tr
                        key={n.noteId}
                        className={`bgt-row${isSel ? ' sel' : ''}`}
                        onClick={() => handleSelect(n)}
                      >
                        <td className="bgt-td bgt-td-title">{title || n.noteId}</td>
                        <td className="bgt-td" style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                          {n.deck.split('::').pop() || '—'}
                        </td>
                        <td className="bgt-td bgt-td-tags">
                          {n.tags.slice(0, 3).map(t => t.split('::').pop()).join(', ') || '—'}
                        </td>
                        <td className="bgt-td bgt-td-prog"><ScheduleCell rec={rec} /></td>
                        <td className="bgt-td bgt-td-prog">
                          {rec && rec.reps > 0
                            ? <span className="bgt-prog-count">{rec.reps}</span>
                            : <span className="bgt-prog-dim">—</span>}
                        </td>
                        <td className="bgt-td bgt-td-prog">
                          {rec && rec.lapses > 0
                            ? <span className="bgt-prog-lapses">{rec.lapses}</span>
                            : <span className="bgt-prog-dim">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Draggable divider + detail panel */}
          {selectedNote && (() => {
            const tmpl    = templates.get(selectedNote.templateId)
            const rec     = srsMap.get(selectedNote.noteId)
            const lastSeen = rec?.lastReviewed ? relativeDate(rec.lastReviewed) : ''
            if (!tmpl) return null
            return (
              <>
                <div
                  className="qa-divider"
                  onPointerDown={handleDividerPointerDown}
                  onPointerMove={handleDividerPointerMove}
                  onPointerUp={handleDividerPointerUp}
                  onPointerCancel={handleDividerPointerUp}
                />
                <div className="browse-col-detail has-selection">
                  <NoteDetailPanel
                    note={selectedNote}
                    template={tmpl}
                    rec={rec}
                    lastSeen={lastSeen}
                    onClose={() => setSelectedNote(null)}
                    onNoteSaved={updated => {
                      setNotes(prev => prev.map(n => n.noteId === updated.noteId ? updated : n))
                      setSelectedNote(updated)
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
