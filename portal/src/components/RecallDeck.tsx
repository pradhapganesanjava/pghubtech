import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { sanitizeHtml } from '../lib/sanitize'
import type { RecallItem, RecallKind } from '../adapters/recallRepo'
import { RECALL_KINDS, RECALL_KIND_META, RECALL_MAX_ANSWER, RECALL_UNTAGGED } from '../adapters/recallRepo'
import type { LCProblem } from '../adapters/adsRepo'
import type { P2RItem } from '../adapters/point2remRepo'

// 🎯 Quiz / Recall — the middle-pane drill deck.
//
// One card = one question you answer from memory, plus the trick/decision that
// answers it. Cards carry references (LC problems, Point2Rem notes, links);
// clicking one hands it to the parent, which opens it in the RIGHT pane — so a
// reference never costs you your place in the deck.
//
// Three body modes share the pane:
//   quiz — one card at a time, hint → reveal → references, ◀ ▶ to move
//   list — every card in the filtered deck, grouped by tag root
//   edit — the card form (also how ＋ New starts)

interface Props {
  items:         RecallItem[]
  loading:       boolean
  error:         string
  problems:      LCProblem[]
  points:        P2RItem[]
  knownTags:     string[]
  // Which card the deck is parked on. Owned by the parent so the ?recall=
  // deep link and the sidebar can drive it.
  currentId:     string | null
  onCurrentId:   (id: string | null) => void
  onOpenProblem: (p: LCProblem) => void
  onOpenPoint:   (i: P2RItem) => void
  onSave:        (draft: RecallItem) => Promise<RecallItem>
  onDelete:      (id: string) => Promise<void>
  onRefresh:     () => void
  onClose:       () => void
  onWiden:       () => void
  // A blank card handed in by ＋ New; the deck opens straight into the form.
  draftSeed:     RecallItem | null
  onDraftDone:   () => void
}

type Body = 'quiz' | 'list' | 'edit'

function diffClass(d: string): string {
  const k = d.toLowerCase()
  return k === 'easy' ? 'lc-easy' : k === 'medium' ? 'lc-medium' : k === 'hard' ? 'lc-hard' : ''
}

// Questions are one or two lines, but inline code carries a lot of them
// (`a[j]-a[i]+1 == k`), so they render as INLINE markdown: emphasis and code
// spans work, block constructs don't, and newlines survive via pre-wrap.
function renderQuestion(question: string): string {
  try { return sanitizeHtml(marked.parseInline(question, { async: false }) as string) }
  catch { return sanitizeHtml(question) }
}

function renderAnswer(answer: string, format: 'md' | 'html'): string {
  if (format === 'html') return sanitizeHtml(answer)
  try { return sanitizeHtml(marked.parse(answer, { async: false }) as string) }
  catch { return sanitizeHtml(answer) }
}

const splitList = (s: string) => s.split(/\s*;\s*/).map(x => x.trim()).filter(Boolean)

// Fisher–Yates over a copy — the deck order is state, not a re-sort of props.
function shuffled<T>(xs: T[]): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// Tag root (first :: segment) — the grouping key in list mode.
const tagRoot = (t: string) => t.split('::')[0] || RECALL_UNTAGGED

export default function RecallDeck({
  items, loading, error, problems, points, knownTags, currentId, onCurrentId,
  onOpenProblem, onOpenPoint, onSave, onDelete, onRefresh, onClose, onWiden,
  draftSeed, onDraftDone,
}: Props) {
  const [body, setBody]       = useState<Body>('quiz')
  const [search, setSearch]   = useState('')
  const [kinds, setKinds]     = useState<RecallKind[]>([])   // [] ⇒ all
  const [tagPick, setTagPick] = useState('')                 // '' ⇒ all
  const [revealed, setReveal] = useState(false)
  const [hinted, setHinted]   = useState(false)
  // Ids in the order the deck walks them. null ⇒ natural (filtered) order.
  const [shuffleIds, setShuffle] = useState<string[] | null>(null)
  const [draft, setDraft]     = useState<RecallItem | null>(null)
  const [saving, setSaving]   = useState(false)
  const [formErr, setFormErr] = useState('')
  const [preview, setPreview] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // ＋ New from the sidebar/toolbar drops a blank card in; open the form on it.
  useEffect(() => {
    if (!draftSeed) return
    setDraft(draftSeed); setBody('edit'); setFormErr(''); setPreview(false)
  }, [draftSeed])

  const searchLower = search.trim().toLowerCase()

  // Filtered deck. Search covers question, answer, hint, tags and #id so a
  // half-remembered card is findable by any of its parts.
  const deck = useMemo(() => items.filter(i => {
    if (kinds.length && !kinds.includes(i.kind)) return false
    if (tagPick && !i.tags.some(t => t === tagPick || t.startsWith(tagPick + '::'))) return false
    if (!searchLower) return true
    return i.question.toLowerCase().includes(searchLower)
      || i.answer.toLowerCase().includes(searchLower)
      || i.hint.toLowerCase().includes(searchLower)
      || i.tags.some(t => t.toLowerCase().includes(searchLower))
      || i.problems.some(p => `#${p}`.includes(searchLower))
  }), [items, kinds, tagPick, searchLower])

  // Apply the shuffle permutation to whatever survived the filter, dropping
  // ids the filter removed and appending anything the shuffle predates.
  const queue = useMemo(() => {
    if (!shuffleIds) return deck
    const byId = new Map(deck.map(i => [i.id, i]))
    const out: RecallItem[] = []
    for (const id of shuffleIds) { const hit = byId.get(id); if (hit) { out.push(hit); byId.delete(id) } }
    return [...out, ...byId.values()]
  }, [deck, shuffleIds])

  const pos     = Math.max(0, queue.findIndex(i => i.id === currentId))
  const current = queue[pos] ?? null

  // Park on the first card whenever the filter moved the deck out from under
  // the open card (or nothing was open yet). An empty queue is left ALONE —
  // it means the deck hasn't loaded yet (a ?recall= id is waiting on it) or
  // the filter matched nothing, and clearing currentId in either case would
  // throw away the card the user is on.
  useEffect(() => {
    if (body === 'edit' || queue.length === 0) return
    if (!currentId || !queue.some(i => i.id === currentId)) onCurrentId(queue[0].id)
  }, [queue, currentId, body]) // eslint-disable-line react-hooks/exhaustive-deps

  // Every card starts face-down.
  useEffect(() => { setReveal(false); setHinted(false) }, [currentId])

  function go(delta: number) {
    if (queue.length === 0) return
    const next = (pos + delta + queue.length) % queue.length
    onCurrentId(queue[next].id)
    bodyRef.current?.scrollTo({ top: 0 })
  }

  // Keyboard: space/enter reveals, ← → walk the deck. Suppressed while a
  // field has focus so typing a tag never flips the card.
  useEffect(() => {
    if (body !== 'quiz') return
    function onKey(e: KeyboardEvent) {
      // A focused control owns its own keys — typing a tag must not flip the
      // card, and space on a focused button must still press that button.
      const el = document.activeElement as HTMLElement | null
      if (el && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(el.tagName) || el.isContentEditable)) return
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setReveal(r => !r) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); go(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [body, pos, queue]) // eslint-disable-line react-hooks/exhaustive-deps

  // Every tag path in the deck, for the filter dropdown. Parent paths are
  // included even when nothing is tagged with them exactly, so picking
  // "_ds" narrows to everything beneath it.
  const tagOptions = useMemo(() => {
    const set = new Set<string>()
    for (const i of items) {
      for (const t of i.tags) {
        const parts = t.split('::')
        for (let n = 1; n <= parts.length; n++) set.add(parts.slice(0, n).join('::'))
      }
    }
    return [...set].sort()
  }, [items])

  const answerHtml = useMemo(
    () => current ? renderAnswer(current.answer, current.format) : '',
    [current?.id, current?.answer, current?.format], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const draftHtml = useMemo(
    () => preview && draft ? renderAnswer(draft.answer, draft.format) : '',
    [preview, draft?.answer, draft?.format], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Resolve a card's references. Unmatched ids still render (greyed) rather
  // than vanishing — a typo should be visible, not silent.
  function resolveProblems(ids: string[]) {
    return ids.map(id => {
      const num = String(parseInt(id, 10))
      return { id, problem: problems.find(p => p.frontendId === id || p.frontendId === num) ?? null }
    })
  }
  function resolvePoints(ids: string[]) {
    return ids.map(id => ({ id, point: points.find(p => p.id === id) ?? null }))
  }

  // ── Editing ────────────────────────────────────────────────────────────────

  function startEdit(item: RecallItem) {
    setDraft({ ...item }); setBody('edit'); setFormErr(''); setPreview(false)
  }
  function cancelEdit() {
    setDraft(null); setFormErr(''); setPreview(false); setBody('quiz'); onDraftDone()
  }
  const setField = <K extends keyof RecallItem>(k: K, v: RecallItem[K]) =>
    setDraft(d => d ? { ...d, [k]: v } : d)

  async function handleSave() {
    if (!draft) return
    if (!draft.question.trim()) { setFormErr('Question is required'); return }
    setSaving(true); setFormErr('')
    try {
      const saved = await onSave(draft)
      setDraft(null); setPreview(false); setBody('quiz')
      onDraftDone()
      onCurrentId(saved.id)
      setReveal(true)   // land on the card you just wrote, face-up
    } catch (e) {
      setFormErr((e as Error).message)
    } finally { setSaving(false) }
  }

  async function handleDelete(item: RecallItem) {
    if (!window.confirm(`Delete “${item.question}”? This removes the card from the sheet.`)) return
    const at = queue.findIndex(i => i.id === item.id)
    const nextId = queue[at + 1]?.id ?? queue[at - 1]?.id ?? null
    try { await onDelete(item.id); onCurrentId(nextId) }
    catch (e) { setFormErr((e as Error).message) }
  }

  // Tags already on the draft don't need suggesting again.
  const tagSuggestions = useMemo(
    () => draft ? knownTags.filter(t => !draft.tags.includes(t)).slice(0, 12) : [],
    [knownTags, draft?.tags], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ── Header ─────────────────────────────────────────────────────────────────

  const header = (
    <div
      className="col-hd doc-detail-hd recall-hd"
      style={{ padding: '10px 12px', flexShrink: 0 }}
      onDoubleClick={onWiden}
      title="🎯 Quiz / Recall — double-click to widen / restore"
    >
      <span className="doc-detail-title">
        {body === 'edit' ? (draft?.id ? '✎ Edit card' : '＋ New card') : '🎯 Quiz / Recall'}
      </span>
      <div className="recall-hd-actions">
        {body !== 'edit' && (
          <div className="adshub-diff-pills">
            <button
              className={`adshub-diff-pill${body === 'quiz' ? ' active' : ''}`}
              onClick={() => setBody('quiz')}
              title="Drill one card at a time"
            >🎴 Quiz</button>
            <button
              className={`adshub-diff-pill${body === 'list' ? ' active' : ''}`}
              onClick={() => setBody('list')}
              title="Browse the whole deck"
            >≡ List</button>
          </div>
        )}
        {body === 'quiz' && queue.length > 0 && (
          <span className="recall-progress">{pos + 1} / {queue.length}</span>
        )}
        {body !== 'edit' && <>
          <button
            className={`bci-edit-btn bci-edit-btn-hd${shuffleIds ? ' active' : ''}`}
            onClick={() => setShuffle(x => x ? null : shuffled(deck).map(i => i.id))}
            title={shuffleIds ? 'Shuffled — click for deck order' : 'Shuffle the deck'}
          >🔀</button>
          <button
            className="rf-btn-save recall-new-btn"
            onClick={() => startEdit({
              id: '', question: '', hint: '', answer: '', kind: 'trick',
              // Pre-fill from the active filter — most cards are written while
              // already looking at their corner of the deck.
              tags: tagPick ? [tagPick] : [], problems: [], points: [], links: [],
              format: 'md', updated: '',
            })}
            title="Write a new card"
          >＋ New</button>
          <button className="rf-btn-cancel" onClick={onRefresh} disabled={loading} title="Reload from the sheet">
            {loading ? '…' : '↻'}
          </button>
        </>}
        {/* While editing, ✕ backs out of the FORM — closing the whole deck
            from here would drop the draft with no warning. */}
        <button
          className="detail-close-btn"
          onClick={body === 'edit' ? cancelEdit : onClose}
          title={body === 'edit' ? 'Discard this draft' : 'Back to Browse'}
        >✕</button>
      </div>
    </div>
  )

  // ── References block (shared by quiz + list) ───────────────────────────────

  function renderReferences(item: RecallItem) {
    const probs = resolveProblems(item.problems)
    const pts   = resolvePoints(item.points)
    if (probs.length === 0 && pts.length === 0 && item.links.length === 0) return null
    return (
      <div className="recall-refs">
        {probs.length > 0 && (
          <div className="p2r-links" style={{ marginTop: 0, borderTop: 'none' }}>
            <div className="detail-section-hd" style={{ padding: '6px 0' }}>
              Problems <span className="tree-cnt">{probs.length}</span>
              <span className="recall-ref-hint">opens on the right →</span>
            </div>
            <ul className="adshub-prob-results">
              {probs.map(({ id, problem }) => (
                <li
                  key={id}
                  onClick={() => problem && onOpenProblem(problem)}
                  title={problem ? `Open #${id} ${problem.title} in the right pane` : `#${id} is not in the archive`}
                  style={problem ? undefined : { opacity: .5, cursor: 'default' }}
                >
                  <span className={`adshub-diff-dot ${problem ? diffClass(problem.difficulty) : ''}`} />
                  <span className="adshub-pid">#{id}</span>
                  <span className="adshub-prob-title">{problem ? problem.title : 'not in the archive'}</span>
                  {problem && <span className="adshub-prob-add">↗</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {pts.length > 0 && (
          <div className="p2r-links" style={{ marginTop: 10, borderTop: 'none' }}>
            <div className="detail-section-hd" style={{ padding: '6px 0' }}>
              Point2Rem notes <span className="tree-cnt">{pts.length}</span>
              <span className="recall-ref-hint">opens on the right →</span>
            </div>
            <ul className="adshub-prob-results">
              {pts.map(({ id, point }) => (
                <li
                  key={id}
                  onClick={() => point && onOpenPoint(point)}
                  title={point ? `Open “${point.title}” in the right pane` : `${id} is not in Point2Rem`}
                  style={point ? undefined : { opacity: .5, cursor: 'default' }}
                >
                  <span className="adshub-pid">📌</span>
                  <span className="adshub-prob-title">{point ? point.title : id}</span>
                  {point && <span className="adshub-prob-add">↗</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {item.links.length > 0 && (
          <div className="p2r-links" style={{ marginTop: 10, borderTop: 'none' }}>
            <div className="detail-section-hd" style={{ padding: '6px 0' }}>
              References <span className="tree-cnt">{item.links.length}</span>
            </div>
            <ul className="p2r-ref-list">
              {item.links.map(l => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer">{l.label || l.url} ↗</a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  const kindBadge = (kind: RecallKind) => (
    <span className={`recall-kind recall-kind--${kind}`} title={RECALL_KIND_META[kind].blurb}>
      {RECALL_KIND_META[kind].icon} {RECALL_KIND_META[kind].label}
    </span>
  )

  // ── Body ───────────────────────────────────────────────────────────────────

  let inner: React.ReactNode

  if (body === 'edit' && draft) {
    const isNew = !draft.id
    inner = (
      <div className="p2r-form recall-form">
        <label>Question *
          <textarea
            className="rf-textarea" rows={2} disabled={saving} autoFocus
            value={draft.question} onChange={e => setField('question', e.target.value)}
            placeholder="How do you check a window holds consecutive integers without walking it?"
          />
        </label>

        <label>Hint <span className="p2r-hint">· optional nudge, shown before the answer</span>
          <input
            className="rf-input" value={draft.hint} disabled={saving}
            onChange={e => setField('hint', e.target.value)}
            placeholder="Compare two spans."
          />
        </label>

        <div className="recall-field">Kind
          <div className="adshub-diff-pills">
            {RECALL_KINDS.map(k => (
              <button
                key={k} type="button" disabled={saving}
                className={`adshub-diff-pill${draft.kind === k ? ' active' : ''}`}
                onClick={() => setField('kind', k)}
                title={RECALL_KIND_META[k].blurb}
              >{RECALL_KIND_META[k].icon} {RECALL_KIND_META[k].label}</button>
            ))}
          </div>
        </div>

        <label>Tags <span className="p2r-hint">· <code>;</code> separated, <code>::</code> for hierarchy</span>
          <input
            className="rf-input" value={draft.tags.join('; ')} disabled={saving}
            onChange={e => setField('tags', splitList(e.target.value))}
            placeholder="_ds::array::window; _prob::subarray::consecutive"
          />
        </label>
        {tagSuggestions.length > 0 && (
          <div className="doc-tag-suggestions">
            {tagSuggestions.map(t => (
              <button
                key={t} type="button" className="doc-tag-suggestion" disabled={saving}
                onMouseDown={e => { e.preventDefault(); setField('tags', [...draft.tags, t]) }}
              >+ {t}</button>
            ))}
          </div>
        )}

        <label>Problems <span className="p2r-hint">· LC ids, <code>;</code> separated</span>
          <input
            className="rf-input" value={draft.problems.join('; ')} disabled={saving}
            onChange={e => setField('problems', splitList(e.target.value))}
            placeholder="128; 298; 594"
          />
        </label>
        {draft.problems.length > 0 && (
          <div className="recall-resolve">
            {resolveProblems(draft.problems).map(({ id, problem }) => (
              <span key={id} className={`recall-resolve-chip${problem ? '' : ' missing'}`}>
                #{id} {problem ? problem.title : '— not in the archive'}
              </span>
            ))}
          </div>
        )}

        <label>Point2Rem notes <span className="p2r-hint">· note ids, <code>;</code> separated</span>
          <input
            className="rf-input" value={draft.points.join('; ')} disabled={saving}
            onChange={e => setField('points', splitList(e.target.value))}
            placeholder="sliding-window-shrink-rule; dp-state-checklist"
          />
        </label>
        {draft.points.length > 0 && (
          <div className="recall-resolve">
            {resolvePoints(draft.points).map(({ id, point }) => (
              <span key={id} className={`recall-resolve-chip${point ? '' : ' missing'}`}>
                📌 {point ? point.title : `${id} — not in Point2Rem`}
              </span>
            ))}
          </div>
        )}

        <label>Links <span className="p2r-hint">· one per line, <code>label | url</code></span>
          <textarea
            className="rf-textarea" rows={2} disabled={saving}
            value={draft.links.map(l => l.label ? `${l.label} | ${l.url}` : l.url).join('\n')}
            onChange={e => setField('links', e.target.value.split(/\r?\n/).map(line => {
              const t = line.trim()
              if (!t) return null
              const bar = t.indexOf('|')
              if (bar < 0) return { url: t }
              const label = t.slice(0, bar).trim()
              const url   = t.slice(bar + 1).trim()
              return url ? (label ? { label, url } : { url }) : null
            }).filter(Boolean) as RecallItem['links'])}
            placeholder="LC Explore — Binary Search | https://leetcode.com/explore/"
          />
        </label>

        <div className="p2r-form-bar">
          <div className="adshub-diff-pills">
            {(['md', 'html'] as const).map(f => (
              <button
                key={f} type="button" disabled={saving}
                className={`adshub-diff-pill${draft.format === f ? ' active' : ''}`}
                onClick={() => setField('format', f)}
              >{f === 'md' ? 'Markdown' : '</> HTML'}</button>
            ))}
          </div>
          <button
            type="button"
            className={`adshub-diff-pill${preview ? ' active' : ''}`}
            onClick={() => setPreview(p => !p)}
          >{preview ? '✎ Write' : '👁 Preview'}</button>
          <span className={`p2r-hint${draft.answer.length > RECALL_MAX_ANSWER ? ' over' : ''}`} style={{ marginLeft: 'auto' }}>
            {draft.answer.length.toLocaleString()} / {RECALL_MAX_ANSWER.toLocaleString()}
          </span>
        </div>

        <div className="recall-field">Answer</div>
        {preview ? (
          <div
            className="adshub-desc section-html-body adshub-editor-preview"
            dangerouslySetInnerHTML={{ __html: draftHtml || '<em style="opacity:.5">Nothing to preview</em>' }}
          />
        ) : (
          <textarea
            className="rf-textarea adshub-html-editor" spellCheck={false} disabled={saving}
            value={draft.answer} onChange={e => setField('answer', e.target.value)}
            placeholder={draft.format === 'md'
              ? '**Value-span must equal index-span.**\n\n```\nmax - min + 1 == k\n```'
              : '<p>Raw HTML…</p>'}
          />
        )}

        {formErr && <div className="login-error">{formErr}</div>}
        <div className="rf-actions">
          <button className="rf-btn-cancel" onClick={cancelEdit} disabled={saving}>Cancel</button>
          <button className="rf-btn-save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create card' : 'Save card'}
          </button>
        </div>
      </div>
    )
  } else if (loading && items.length === 0) {
    inner = <div className="col-empty">Loading the deck…</div>
  } else if (error) {
    inner = <div className="col-empty">Couldn't load Recall: {error}</div>
  } else if (items.length === 0) {
    inner = (
      <div className="done-state">
        <div className="done-icon">🎯</div>
        <h3>No cards yet</h3>
        <p>Use <b>＋ New</b> above to write the first drill — the small trick or the pattern confusion you just hit.</p>
      </div>
    )
  } else if (queue.length === 0) {
    inner = <div className="col-empty">No cards match this filter</div>
  } else if (body === 'list') {
    // Group by tag root so a long deck stays scannable. Unlike the Point2Rem
    // tree, a card is filed ONCE — under its FIRST tag's root. List mode is an
    // inventory you scan to pick a card, and most cards carry two or three
    // roots (`_ds` + `_prob` + `_meta`), so cross-filing tripled the rows and
    // buried the deck. Reaching a card by its other tags is what the tag
    // filter above is for.
    const groups = new Map<string, RecallItem[]>()
    for (const i of queue) {
      const root = i.tags.length ? tagRoot(i.tags[0]) : RECALL_UNTAGGED
      const g = groups.get(root)
      if (g) g.push(i); else groups.set(root, [i])
    }
    inner = (
      <div className="recall-list">
        {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([root, list]) => (
          <div key={root} className="p2r-group">
            <div className="p2r-group-hd" title={root}>
              <span className="flat-tag-path"><span className="flat-tag-leaf">{root}</span></span>
              <span className="tree-cnt">{list.length}</span>
            </div>
            {list.map(i => (
              <button
                key={i.id}
                className={`recall-list-row${i.id === currentId ? ' active' : ''}`}
                onClick={() => { onCurrentId(i.id); setBody('quiz') }}
                title="Open in quiz mode"
              >
                {kindBadge(i.kind)}
                <span className="recall-list-q" dangerouslySetInnerHTML={{ __html: renderQuestion(i.question) }} />
                {(i.problems.length > 0 || i.points.length > 0) && (
                  <span className="tree-cnt" title={`${i.problems.length} problems · ${i.points.length} notes`}>
                    🔗{i.problems.length + i.points.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    )
  } else if (current) {
    inner = (
      <div className="recall-card">
        <div className="recall-card-meta">
          {kindBadge(current.kind)}
          {current.tags.map(t => (
            <button
              key={t} className="tag recall-tag" title={`Filter the deck to ${t}`}
              onClick={() => setTagPick(p => p === t ? '' : t)}
            >{t}</button>
          ))}
          {current.updated && <span className="p2r-updated">{current.updated}</span>}
        </div>

        <div className="recall-q" dangerouslySetInnerHTML={{ __html: renderQuestion(current.question) }} />

        {current.hint && (
          hinted
            ? <div className="recall-hint-shown">💡 {current.hint}</div>
            : <button className="rf-btn-cancel recall-hint-btn" onClick={() => setHinted(true)}>💡 Show hint</button>
        )}

        {revealed ? (
          <>
            <div className="recall-answer-hd">Answer</div>
            <div
              className="adshub-desc section-html-body recall-answer"
              dangerouslySetInnerHTML={{ __html: answerHtml || '<em style="opacity:.5">No answer written yet.</em>' }}
            />
            {renderReferences(current)}
          </>
        ) : (
          <button className="rf-btn-save recall-reveal" onClick={e => { e.currentTarget.blur(); setReveal(true) }}>
            Reveal answer <span className="recall-key">space</span>
          </button>
        )}

        <div className="recall-nav">
          {/* blur() after a mouse click so ← → space keep working — a focused
              button swallows them (see the keydown guard above). */}
          <button className="rf-btn-cancel" onClick={e => { e.currentTarget.blur(); go(-1) }} title="Previous card (←)">◀ Prev</button>
          <div className="recall-nav-mid">
            <button className="bci-edit-btn" onClick={() => startEdit(current)} title="Edit this card">✎</button>
            <button className="bci-edit-btn" onClick={() => handleDelete(current)} title="Delete this card">🗑</button>
          </div>
          <button className="rf-btn-save" onClick={e => { e.currentTarget.blur(); go(1) }} title="Next card (→)">Next ▶</button>
        </div>
        {formErr && <div className="login-error">{formErr}</div>}
      </div>
    )
  }

  return (
    <>
      {header}
      {body !== 'edit' && items.length > 0 && (
        <div className="recall-filters">
          <input
            className="col-search"
            placeholder="Search questions, answers, tags, #id…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="adshub-diff-pills">
            {RECALL_KINDS.map(k => (
              <button
                key={k}
                className={`adshub-diff-pill${kinds.includes(k) ? ' active' : ''}`}
                onClick={() => setKinds(ks => ks.includes(k) ? ks.filter(x => x !== k) : [...ks, k])}
                title={RECALL_KIND_META[k].blurb}
              >{RECALL_KIND_META[k].icon} {RECALL_KIND_META[k].label}</button>
            ))}
          </div>
          <select
            className="rf-input recall-tag-select"
            value={tagPick}
            onChange={e => setTagPick(e.target.value)}
            title="Narrow the deck to one tag branch"
          >
            <option value="">All tags</option>
            {tagOptions.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          {(searchLower || kinds.length > 0 || tagPick) && (
            <button
              className="col-hd-clear"
              onClick={() => { setSearch(''); setKinds([]); setTagPick('') }}
            >Clear</button>
          )}
        </div>
      )}
      <div className="recall-body" ref={bodyRef}>{inner}</div>
    </>
  )
}
