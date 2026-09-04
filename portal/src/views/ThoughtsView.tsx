// Thoughts — free capture, cleaned and filed, then read back one at a time.
//
// Lives beside DART rather than inside it: capturing and re-reading thoughts is
// its own activity, not part of running the day, and it earns a top-level Utils
// tab of its own. The AI pipeline is in lib/thoughtGen.ts; the navigator that
// turns paths into a browsable tree is components/ThoughtTree.tsx.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addThought, deleteThought, loadThoughts, updateThought,
  MAX_PATH_DEPTH, THOUGHT_BUCKETS,
} from '../adapters/dartRepo'
import type { DartThought, ThoughtBucket } from '../adapters/dartRepo'
import { isoDate } from '../lib/dartPlan'
import { useToast } from '../components/Toast'
import { LLM } from '../lib/llm'
import { refineThought, renderThought } from '../lib/thoughtGen'
import { sanitizeHtml } from '../lib/sanitize'
import ThoughtTree, { titleOf, UNFILED } from '../components/ThoughtTree'

type Toast = ReturnType<typeof useToast>['toast']

export default function ThoughtsView() {
  const { toast } = useToast()
  return <ThoughtsPanel toast={toast} />
}

function firstLine(s: string): string {
  const line = s.split('\n').map(x => x.trim()).find(Boolean) ?? ''
  return line.length > 90 ? line.slice(0, 87) + '…' : line
}

type ThoughtView = 'tree' | 'flat'

function ThoughtsPanel({ toast }: { toast: Toast }) {
  const [thoughts, setThoughts] = useState<DartThought[]>([])
  const [loading, setLoading]   = useState(true)
  const [draft, setDraft]       = useState('')
  const [saving, setSaving]     = useState(false)
  const [stage, setStage]       = useState('')
  const [bucketFilter, setBF]   = useState<ThoughtBucket | 'all'>('all')
  const [pathFilter, setPF]     = useState<string>('')
  const [search, setSearch]     = useState('')
  const [view, setView]         = useState<ThoughtView>('tree')
  const [navCollapsed, setNav]  = useState(true)
  // One thought opened on its own, rather than the whole deck stacked.
  const [selectedId, setSel]    = useState<string | null>(null)
  const [openRaw, setOpenRaw]   = useState<Set<string>>(new Set())
  const [openOrig, setOpenOrig] = useState<Set<string>>(new Set())
  const [busyId, setBusyId]     = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    loadThoughts()
      .then(list => { setThoughts(list); setLoading(false) })
      .catch(e => { setLoading(false); toast(`Load failed: ${(e as Error).message}`, 'error') })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const knownPaths = useMemo(
    () => [...new Set(thoughts.map(t => t.path).filter(Boolean))].sort(),
    [thoughts],
  )

  async function process(raw: string): Promise<Omit<DartThought, 'id' | 'createdAt' | 'updatedAt'>> {
    const base = {
      date: isoDate(new Date()), raw, rawOriginal: raw,
      bucket: 'Other' as ThoughtBucket, summary: firstLine(raw),
      highlights: [] as string[], path: UNFILED, rich: '',
    }
    if (!LLM.isConfigured()) {
      toast('Saved unprocessed — add the Azure key in Settings to clean and sort thoughts.', 'info')
      return base
    }
    setStage('Cleaning up and filing…')
    const refined = await refineThought(raw, knownPaths)
    if (!refined) return base
    setStage('Building the visual card…')
    const rich = await renderThought(refined.cleaned).catch(() => '')
    return {
      ...base,
      raw: refined.cleaned, rawOriginal: raw,
      bucket: refined.bucket, summary: refined.summary || firstLine(refined.cleaned),
      highlights: refined.highlights, path: refined.path, rich,
    }
  }

  async function save() {
    const raw = draft.trim()
    if (!raw || saving) return
    setSaving(true)
    try {
      const t = await addThought(await process(raw))
      setThoughts(prev => [t, ...prev])
      setDraft('')
      setSel(t.id)          // land on what was just captured
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false); setStage('')
    }
  }

  async function reprocess(t: DartThought) {
    if (busyId) return
    if (!LLM.isConfigured()) { toast('AI is not configured — add the Azure key in Settings.', 'error'); return }
    setBusyId(t.id)
    try {
      const fields = await process(t.rawOriginal || t.raw)
      const updated = await updateThought({ ...t, ...fields, date: t.date })
      setThoughts(prev => prev.map(x => x.id === updated.id ? updated : x))
    } catch (e) {
      toast(`Re-process failed: ${(e as Error).message}`, 'error')
    } finally {
      setBusyId(null); setStage('')
    }
  }

  async function setBucket(t: DartThought, bucket: ThoughtBucket) {
    try {
      const updated = await updateThought({ ...t, bucket })
      setThoughts(prev => prev.map(x => x.id === updated.id ? updated : x))
    } catch (e) { toast(`Save failed: ${(e as Error).message}`, 'error') }
  }

  async function movePath(t: DartThought) {
    const next = window.prompt(
      `Tree path for this thought (:: separated, max ${MAX_PATH_DEPTH} levels)`, t.path)
    if (next === null) return
    try {
      const updated = await updateThought({ ...t, path: next })
      setThoughts(prev => prev.map(x => x.id === updated.id ? updated : x))
    } catch (e) { toast(`Move failed: ${(e as Error).message}`, 'error') }
  }

  async function remove(t: DartThought) {
    if (!window.confirm('Delete this thought? The original capture goes with it.')) return
    try {
      await deleteThought(t.id)
      setThoughts(prev => prev.filter(x => x.id !== t.id))
      if (selectedId === t.id) setSel(null)
    } catch (e) { toast(`Delete failed: ${(e as Error).message}`, 'error') }
  }

  function toggle(set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    set(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const bucketCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of thoughts) m.set(t.bucket, (m.get(t.bucket) ?? 0) + 1)
    return m
  }, [thoughts])

  // Search runs over the whole record — cleaned text, the original capture,
  // the summary and the path — so a half-remembered phrase finds its thought.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return thoughts
    return thoughts.filter(t =>
      t.summary.toLowerCase().includes(q) ||
      t.raw.toLowerCase().includes(q) ||
      (t.rawOriginal || '').toLowerCase().includes(q) ||
      t.path.toLowerCase().includes(q) ||
      t.bucket.toLowerCase().includes(q) ||
      t.highlights.some(h => h.toLowerCase().includes(q)))
  }, [thoughts, search])

  const shown = useMemo(() => searched.filter(t =>
    (bucketFilter === 'all' || t.bucket === bucketFilter) &&
    (!pathFilter || t.path === pathFilter || t.path.startsWith(pathFilter + '::'))),
    [searched, bucketFilter, pathFilter])

  const selected = thoughts.find(t => t.id === selectedId) ?? null

  function pickThought(t: DartThought) {
    setSel(t.id)
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches) {
      setNav(true)          // stacked, the nav overlays the content — close it
    }
  }

  const navBody = (
    <>
      <div className="th-nav-search">
        <input
          className="rf-input" placeholder="Search thoughts…" value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && <button className="dart-minibtn" onClick={() => setSearch('')}>✕</button>}
      </div>
      <button
        className={`th-nav-all${pathFilter === '' && !selectedId ? ' active' : ''}`}
        onClick={() => { setPF(''); setSel(null) }}
      >All thoughts <span className="tt-count">{searched.length}</span></button>

      <div className="th-nav-body">
        {searched.length === 0 ? (
          <div className="col-empty">{search ? 'Nothing matches.' : 'No thoughts yet.'}</div>
        ) : view === 'tree' ? (
          <ThoughtTree
            thoughts={searched}
            selectedId={selectedId} selectedPath={pathFilter}
            onPickThought={pickThought}
            onPickPath={p => { setPF(cur => cur === p ? '' : p); setSel(null) }}
            expandAll={!!search.trim()}
          />
        ) : (
          <ul className="tt-flat">
            {searched.map(t => (
              <li key={t.id}>
                <button
                  className={`tt-leaf${selectedId === t.id ? ' active' : ''}`}
                  onClick={() => pickThought(t)} title={t.path}
                >
                  <span className="tt-leaf-dot" aria-hidden>💭</span>
                  <span className="tt-leaf-body">
                    <span className="tt-leaf-title">{titleOf(t)}</span>
                    <span className="tt-leaf-path">{t.path.split('::').join(' › ')}</span>
                  </span>
                  <span className="tt-leaf-date">{t.date.slice(5)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )

  return (
    <div className="dart-thoughts-wrap">
      {navCollapsed ? (
        <div className="th-nav-strip">
          <button className="th-strip-btn" onClick={() => setNav(false)} title="Show thoughts">
            <span className="th-strip-icon">▸</span>
            <span className="th-strip-vert">Thoughts</span>
            <span className="th-strip-label">
              Thoughts
              <b>{selected ? titleOf(selected) : pathFilter ? pathFilter.split('::').slice(-1)[0] : 'All'}</b>
            </span>
            <span className="th-strip-n">{searched.length}</span>
          </button>
        </div>
      ) : (
        <div className="th-nav">
          <div className="th-nav-hd">
            <span>Thoughts</span>
            <button className="th-strip-btn" onClick={() => setNav(true)} title="Hide list">
              <span className="th-strip-icon">◂</span>
              <span className="th-strip-label">Done</span>
            </button>
          </div>
          <div className="th-nav-modes">
            <button className={`th-mode${view === 'tree' ? ' active' : ''}`} onClick={() => setView('tree')}>Tree</button>
            <button className={`th-mode${view === 'flat' ? ' active' : ''}`} onClick={() => setView('flat')}>Flat</button>
          </div>
          {navBody}
        </div>
      )}

      <div className="dart-body dart-thoughts">
        <div className="dart-composer">
          <textarea
            ref={boxRef} className="dart-composer-box" rows={selected ? 2 : 4} value={draft}
            placeholder="What's on your mind? Dump it raw — it gets cleaned up, filed in the tree, and turned into a visual card."
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() }}
          />
          <div className="dart-composer-foot">
            <span className="dart-hint">
              {saving && stage ? stage : '⌘/Ctrl + Enter to save · your original capture is always kept'}
            </span>
            <button className="mgmt-save-btn" disabled={!draft.trim() || saving} onClick={save}>
              {saving ? 'Processing…' : 'Save thought'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="col-empty">Loading…</div>
        ) : selected ? (
          /* ── One thought, opened on its own ── */
          <div className="th-single">
            <div className="th-single-bar">
              <button className="dart-minibtn" onClick={() => setSel(null)}>← All thoughts</button>
              <span className="th-single-crumb">
                {(selected.path || UNFILED).split('::').join(' › ')}
              </span>
            </div>
            <ThoughtCard
              t={selected} busy={busyId === selected.id}
              rawOpen={openRaw.has(selected.id)} origOpen={openOrig.has(selected.id)}
              onToggleRaw={() => toggle(setOpenRaw, selected.id)}
              onToggleOrig={() => toggle(setOpenOrig, selected.id)}
              onBucket={b => setBucket(selected, b)}
              onPath={() => movePath(selected)}
              onReprocess={() => reprocess(selected)}
              onDelete={() => remove(selected)}
            />
          </div>
        ) : (
          <>
            <div className="dart-thought-filters">
              <button className={`dart-fchip${bucketFilter === 'all' ? ' active' : ''}`} onClick={() => setBF('all')}>
                All <span className="dart-fchip-n">{thoughts.length}</span>
              </button>
              {THOUGHT_BUCKETS.map(b => (
                <button
                  key={b} className={`dart-fchip${bucketFilter === b ? ' active' : ''}`}
                  onClick={() => setBF(b)}
                >{b} <span className="dart-fchip-n">{bucketCounts.get(b) ?? 0}</span></button>
              ))}
            </div>

            {pathFilter && (
              <div className="th-crumb">
                {pathFilter.split('::').join(' › ')}
                <button className="dart-minibtn" onClick={() => setPF('')}>clear</button>
              </div>
            )}

            {shown.length === 0 ? (
              <div className="col-empty">
                {thoughts.length === 0
                  ? 'Nothing yet. Dump a thought above — it gets cleaned up, filed, and rendered as a card you can actually re-read.'
                  : 'No thoughts match this filter.'}
              </div>
            ) : (
              <ul className="th-index">
                {shown.map(t => (
                  <li key={t.id}>
                    <button className="th-index-row" onClick={() => pickThought(t)}>
                      <span className="th-index-date">{t.date}</span>
                      <span className="th-index-title">{titleOf(t)}</span>
                      <span className="th-index-bucket">{t.bucket}</span>
                      <span className="th-index-path">{(t.path || UNFILED).split('::').join(' › ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// One thought, rendered in full. Used by the single view; kept separate so the
// index stays a cheap list of titles rather than a wall of rich cards.
function ThoughtCard({
  t, busy, rawOpen, origOpen,
  onToggleRaw, onToggleOrig, onBucket, onPath, onReprocess, onDelete,
}: {
  t: DartThought; busy: boolean; rawOpen: boolean; origOpen: boolean
  onToggleRaw: () => void; onToggleOrig: () => void
  onBucket: (b: ThoughtBucket) => void; onPath: () => void
  onReprocess: () => void; onDelete: () => void
}) {
  return (
    <div className="dart-thought">
      <div className="dart-thought-hd">
        <span className="dart-thought-date">{t.date}</span>
        <select
          className="dart-bucket-select" value={t.bucket}
          onChange={e => onBucket(e.target.value as ThoughtBucket)}
        >
          {THOUGHT_BUCKETS.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <button className="th-path-btn" onClick={onPath} title="Change tree path">
          {(t.path || UNFILED).split('::').join(' › ')}
        </button>
        <span className="dart-thought-spacer" />
        <button className="dart-minibtn" onClick={onToggleRaw}>
          {rawOpen ? 'Hide Raw Text' : 'Raw Text'}
        </button>
        <button className="dart-minibtn danger" onClick={onDelete}>✕</button>
      </div>

      {t.summary && <div className="dart-thought-summary">{t.summary}</div>}

      {t.rich
        ? <div className="th-rich" dangerouslySetInnerHTML={{ __html: sanitizeHtml(t.rich) }} />
        : t.highlights.length > 0 && (
            <ul className="dart-highlights">
              {t.highlights.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          )}

      {t.rich && t.highlights.length > 0 && (
        <ul className="dart-highlights">
          {t.highlights.map((h, i) => <li key={i}>{h}</li>)}
        </ul>
      )}

      {rawOpen && (
        <div className="th-raw-wrap">
          <div className="th-raw-hd">
            <span>Cleaned capture</span>
            <span className="th-raw-actions">
              {t.rawOriginal && t.rawOriginal !== t.raw && (
                <button className="dart-minibtn" onClick={onToggleOrig}>
                  {origOpen ? 'Hide original' : 'Show original'}
                </button>
              )}
              <button className="dart-minibtn" disabled={busy} onClick={onReprocess}
                      title="Re-run the clean-up and the visual card from the original capture">
                {busy ? '…' : '✨ Re-process'}
              </button>
            </span>
          </div>
          <pre className="dart-thought-raw">{t.raw}</pre>
          {origOpen && (
            <>
              <div className="th-raw-hd"><span>Original, exactly as captured</span></div>
              <pre className="dart-thought-raw original">{t.rawOriginal}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
