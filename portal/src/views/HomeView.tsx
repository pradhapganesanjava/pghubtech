import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { AnkiNote, AnkiTemplate } from '../adapters/ankiRepo'
import { loadAnkiTemplates, loadAllNotes } from '../adapters/ankiRepo'
import {
  loadSRSMap, getAllSRS, isDue, computeNextSRS, setSRSRecord, previewIntervals,
} from '../adapters/srsRepo'
import type { SRSRecord } from '../adapters/srsRepo'
import { getCardFrontHtml, getCardBackHtml, getCardFrontText } from '../utils/cardHelpers'
import TagDeckTree from '../components/TagDeckTree'
import { useToast } from '../components/Toast'

const REVIEWED_IDS_KEY = 'pghub_reviewed'

function loadReviewedIds(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEWED_IDS_KEY) || '{}') as Record<string, string>
    const now = new Date()
    const valid = new Set<string>()
    const cleaned: Record<string, string> = {}
    for (const [id, due] of Object.entries(raw)) {
      if (new Date(due) > now) { valid.add(id); cleaned[id] = due }
    }
    localStorage.setItem(REVIEWED_IDS_KEY, JSON.stringify(cleaned))
    return valid
  } catch { return new Set() }
}

function saveReviewedId(id: string, dueDate: string): void {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEWED_IDS_KEY) || '{}') as Record<string, string>
    raw[id] = dueDate
    localStorage.setItem(REVIEWED_IDS_KEY, JSON.stringify(raw))
  } catch {}
}

function clearReviewedIds(): void {
  localStorage.removeItem(REVIEWED_IDS_KEY)
}

function chipLabel(path: string): string {
  const parts = path.split('::')
  return parts.length <= 2 ? path : `…::${parts.slice(-2).join('::')}`
}

export default function HomeView() {
  const { toast } = useToast()

  // ── Data ───────────────────────────────────────────────────────────────────
  const [allNotes,      setAllNotes]      = useState<AnkiNote[]>([])
  const [templates,     setTemplates]     = useState<Map<string, AnkiTemplate>>(new Map())
  const [dataLoaded,    setDataLoaded]    = useState(false)
  const allNotesRef                       = useRef<AnkiNote[]>([])

  // ── SRS ────────────────────────────────────────────────────────────────────
  const [srsMap,        setSrsMap]        = useState<Map<string, SRSRecord>>(new Map())

  // ── Queue ──────────────────────────────────────────────────────────────────
  const [queue,         setQueue]         = useState<AnkiNote[]>([])
  const [qIdx,          setQIdx]          = useState(0)
  const [candidateCount, setCandidateCount] = useState(0)
  const [studyAllMode,  setStudyAllMode]  = useState(false)
  const [_reviewedInit] = useState(loadReviewedIds)
  const reviewedIdsRef = useRef<Set<string>>(_reviewedInit)

  // ── Card state ─────────────────────────────────────────────────────────────
  const [answerVisible, setAnswerVisible] = useState(false)

  // ── Layout ─────────────────────────────────────────────────────────────────
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [qaRatio,       setQaRatio]       = useState(45)
  const qaContainerRef                    = useRef<HTMLDivElement>(null)
  const isDividerDragging                 = useRef(false)

  // ── Filters ────────────────────────────────────────────────────────────────
  const [selectedTags,  setSelectedTags]  = useState<string[]>([])
  const [selectedDecks, setSelectedDecks] = useState<string[]>([])

  // ── notDueIds — cards that are not due (reviewed, scheduled for future) ────
  const notDueIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of allNotes) {
      const rec = srsMap.get(n.noteId)
      if (rec && !isDue(rec)) ids.add(n.noteId)
    }
    return ids
  }, [allNotes, srsMap])

  // ── Load data on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      try {
        const [tmpls, srs] = await Promise.all([
          loadAnkiTemplates(),
          loadSRSMap(),
        ])
        setTemplates(tmpls)
        setSrsMap(srs)
        const notes = await loadAllNotes(tmpls)
        allNotesRef.current = notes
        setAllNotes(notes)
        setDataLoaded(true)
      } catch (e) {
        toast(`Failed to load data: ${(e as Error).message}`, 'error')
        setDataLoaded(true)
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Build queue ────────────────────────────────────────────────────────────
  const buildQueue = useCallback((
    notes: AnkiNote[],
    tags: string[],
    decks: string[],
    srs: Map<string, SRSRecord>,
    studyAll = false,
  ) => {
    let candidates = notes

    if (decks.length > 0) {
      candidates = candidates.filter(n => {
        return decks.some(sd => n.deck === sd || n.deck.startsWith(sd + '::'))
      })
    }
    if (tags.length > 0) {
      candidates = candidates.filter(n => {
        return tags.every(st => n.tags.some(t => t === st || t.startsWith(st + '::')))
      })
    }

    const due = studyAll ? candidates : candidates.filter(n => isDue(srs.get(n.noteId)))
    return {
      queue: [...due].sort(() => Math.random() - 0.5),
      candidateCount: candidates.length,
    }
  }, [])

  // ── Rebuild queue when filters or data change ──────────────────────────────
  useEffect(() => {
    if (!dataLoaded) return
    const { queue: newQueue, candidateCount: cc } = buildQueue(
      allNotesRef.current, selectedTags, selectedDecks, getAllSRS(), studyAllMode
    )
    setCandidateCount(cc)
    const pending = newQueue.filter(n => !reviewedIdsRef.current.has(n.noteId))
    setQueue(pending)
    setQIdx(0)
    setAnswerVisible(false)
  }, [dataLoaded, selectedTags, selectedDecks, studyAllMode, buildQueue])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((e.code === 'Space' || e.code === 'Enter') && !answerVisible) {
        e.preventDefault(); handleReveal()
      } else if (answerVisible && ['1','2','3','4'].includes(e.key)) {
        const ratings = [0, 1, 2, 3] as const
        handleRate(ratings[Number(e.key) - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── Divider drag ───────────────────────────────────────────────────────────
  function handleDividerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    isDividerDragging.current = true
    document.body.classList.add('resizing-h')
  }
  function handleDividerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDividerDragging.current) return
    const container = qaContainerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const pct  = ((e.clientX - rect.left) / rect.width) * 100
    setQaRatio(Math.min(Math.max(pct, 15), 80))
  }
  function handleDividerPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    isDividerDragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  // ── Card actions ───────────────────────────────────────────────────────────
  function handleReveal() {
    setAnswerVisible(true)
  }

  function handleRate(rating: 0 | 1 | 2 | 3) {
    const note = queue[qIdx]
    if (!note) return
    const existing = getAllSRS().get(note.noteId)
    const tmpl = templates.get(note.templateId)
    const next = computeNextSRS(existing, note.noteId, note.templateId, note.deck, rating)
    setSRSRecord(next)
    setSrsMap(prev => {
      const updated = new Map(prev)
      updated.set(note.noteId, next)
      return updated
    })
    reviewedIdsRef.current.add(note.noteId)
    saveReviewedId(note.noteId, next.nextDue)
    setQIdx(i => i + 1)
    setAnswerVisible(false)
    void tmpl // suppress unused warning
  }

  function handleToggleTag(tag: string)   { setSelectedTags(p  => p.includes(tag)  ? p.filter(t => t !== tag)  : [...p, tag]) }
  function handleToggleDeck(deck: string) { setSelectedDecks(p => p.includes(deck) ? p.filter(d => d !== deck) : [...p, deck]) }
  function handleClearAll() { setSelectedTags([]); setSelectedDecks([]) }

  // ── Derived state ──────────────────────────────────────────────────────────
  const hasFilters = selectedTags.length > 0 || selectedDecks.length > 0
  const isDone     = qIdx >= queue.length
  const total      = queue.length
  const done       = Math.min(qIdx, total)
  const pct        = total > 0 ? (done / total) * 100 : 0
  const doneNoMatches  = isDone && candidateCount === 0
  const doneNothingDue = isDone && candidateCount > 0 && total === 0 && !studyAllMode

  const currentNote  = queue[qIdx]
  const currentTmpl  = currentNote ? templates.get(currentNote.templateId) : undefined
  const currentSRS   = currentNote ? getAllSRS().get(currentNote.noteId) : undefined
  const intervals    = useMemo(() => previewIntervals(currentSRS), [currentNote?.noteId, currentSRS]) // eslint-disable-line react-hooks/exhaustive-deps
  const RATING_LABELS = ['Again', 'Hard', 'Good', 'Easy']

  // ── Loading screen ─────────────────────────────────────────────────────────
  if (!dataLoaded) {
    return (
      <div className="review-body">
        <div className="col-main">
          <div className="done-state">
            <div className="browse-stream-spinner" style={{ width: 36, height: 36, margin: '0 auto' }} />
            <p>Loading cards…</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="review-body">
      {/* Left: tags/decks column */}
      <div className={`col-tags${leftCollapsed ? ' collapsed' : ''}`}>
        {leftCollapsed ? (
          <button className="panel-strip-btn" onClick={() => setLeftCollapsed(false)}>▸</button>
        ) : (
          <TagDeckTree
            notes={allNotes}
            selectedTags={selectedTags}
            selectedDecks={selectedDecks}
            onToggleTag={handleToggleTag}
            onToggleDeck={handleToggleDeck}
            onClearAll={handleClearAll}
            collapsed={false}
            onCollapse={() => setLeftCollapsed(true)}
            notDueIds={notDueIds}
          />
        )}
      </div>

      {/* Q+A split container */}
      <div className="review-qa-split" ref={qaContainerRef}>

        {/* ── Question pane ── */}
        <div
          className="col-main"
          style={answerVisible ? { flexBasis: qaRatio + '%', flex: `0 0 ${qaRatio}%` } : undefined}
        >
          <div className="col-main-scroll">
            {/* Applied filter chips */}
            {hasFilters && (
              <div className="review-applied-filters">
                {selectedDecks.map(d => (
                  <span key={d} className="applied-chip deck-chip" title={d}>
                    <span className="chip-icon">⬡</span>
                    <span className="chip-label">{chipLabel(d)}</span>
                    <button className="chip-rm" onClick={() => handleToggleDeck(d)}>×</button>
                  </span>
                ))}
                {selectedTags.map(t => (
                  <span key={t} className="applied-chip tag-chip" title={t}>
                    <span className="chip-label">{chipLabel(t)}</span>
                    <button className="chip-rm" onClick={() => handleToggleTag(t)}>×</button>
                  </span>
                ))}
                <button className="applied-clear-all" onClick={handleClearAll}>Clear all</button>
              </div>
            )}

            {/* Done states */}
            {isDone && (
              <div className="done-state">
                <div className="done-icon">
                  {doneNoMatches ? '🔍' : doneNothingDue ? '✓' : '🎉'}
                </div>
                <h2>
                  {doneNoMatches ? 'No matches' : doneNothingDue ? 'Up to date' : 'Session complete!'}
                </h2>
                <p>
                  {doneNoMatches
                    ? 'No cards match the current filters.'
                    : doneNothingDue
                    ? 'All cards in this set are scheduled — nothing due right now.'
                    : `${total} card${total !== 1 ? 's' : ''} reviewed — great work!`}
                </p>
                <div className="done-actions">
                  {hasFilters && (
                    <button className="btn btn-secondary" onClick={handleClearAll}>
                      Clear Filters
                    </button>
                  )}
                  {candidateCount > 0 && (
                    <button className="btn btn-primary" onClick={() => {
                      reviewedIdsRef.current.clear()
                      clearReviewedIds()
                      setStudyAllMode(true)
                    }}>
                      Study All ({candidateCount})
                    </button>
                  )}
                  {total > 0 && (
                    <button className="btn btn-secondary" onClick={() => {
                      reviewedIdsRef.current.clear()
                      clearReviewedIds()
                      const { queue: q, candidateCount: cc } = buildQueue(
                        allNotesRef.current, selectedTags, selectedDecks, getAllSRS(), studyAllMode
                      )
                      setQueue(q); setCandidateCount(cc); setQIdx(0)
                      setAnswerVisible(false)
                    }}>
                      Restart
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Progress bar */}
            {!isDone && (
              <div className="queue-bar">
                <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                  {done} / {total}
                  {candidateCount > 0 && candidateCount !== total && (
                    <span style={{ marginLeft: 6, opacity: .7 }}>({candidateCount} matching)</span>
                  )}
                </span>
                <div className="queue-progress">
                  <div className="queue-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}

            {/* Question card */}
            {!isDone && currentNote && currentTmpl && (
              <div
                className={`question-card${!answerVisible ? ' clickable' : ''}`}
                onClick={!answerVisible ? handleReveal : undefined}
                style={!answerVisible ? { cursor: 'pointer' } : undefined}
              >
                <div
                  className="question-html"
                  dangerouslySetInnerHTML={{ __html: getCardFrontHtml(currentNote, currentTmpl) }}
                />
                {!answerVisible && (
                  <div style={{ marginTop: 16 }}>
                    <button className="show-answer-btn" onClick={handleReveal}>
                      Show Answer <span style={{ opacity: .6, fontSize: 12 }}>(Space)</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Draggable divider */}
        {answerVisible && !isDone && (
          <div
            className="qa-divider"
            onPointerDown={handleDividerPointerDown}
            onPointerMove={handleDividerPointerMove}
            onPointerUp={handleDividerPointerUp}
            onPointerCancel={handleDividerPointerUp}
          />
        )}

        {/* ── Answer pane ── */}
        {answerVisible && !isDone && currentNote && currentTmpl && (
          <div className="col-answer">
            <div className="answer-col-inner">
              <div
                className="answer-html"
                dangerouslySetInnerHTML={{ __html: getCardBackHtml(currentNote, currentTmpl) }}
              />

              {/* Rating buttons */}
              <div className="rating-grid">
                {([0, 1, 2, 3] as const).map((r, i) => (
                  <button
                    key={r}
                    className="rating-btn"
                    data-r={String(i + 1)}
                    onClick={() => handleRate(r)}
                  >
                    [{i + 1}] {RATING_LABELS[i]}
                    <span className="ivl">{intervals[i]}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
