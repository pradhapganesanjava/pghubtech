// Solve Path — build problem-solving strength from what is already familiar.
//
// You mark how comfortable you are with problems (Struggling → Tried →
// Comfortable → Fluent, stored in the sheet's Comfort tab). From that, two
// views over your pat_* tags (logic in lib/solvePath.ts):
//
//   • Next to try   — problems one new idea away from your comfortable ones.
//                     The new idea stays hidden until you ask, so the card is
//                     a prompt to think, not the answer.
//   • Prepare for…  — for a problem you are struggling with: which ideas you
//                     already have, which are gaps, and the easier problems to
//                     solve first, as a path ending at the hard one.
//
// Problems open in AdsHub (?id=), where the statement, notes and code live.

import { useEffect, useMemo, useState } from 'react'
import { loadProblems, getCachedProblems, type LCProblem } from '../adapters/adsRepo'
import {
  loadComfort, getCachedComfort, saveComfort, removeComfort, today,
  COMFORT_LEVELS, levelMeta, type ComfortEntry, type ComfortLevel,
} from '../adapters/comfortRepo'
import { buildIndex, nextToTry, prepareFor, type IdeaStep } from '../lib/solvePath'
import { loadMicroNames, prettyId, type MicroNames } from '../lib/microNames'
import { pathForView, type View } from '../lib/routing'
import { useToast } from '../components/Toast'

const diffCls = (d: string) =>
  d === 'Easy' ? 'sp-easy' : d === 'Hard' ? 'sp-hard' : 'sp-medium'

export default function SolvePathView({ onNav }: { onNav: (v: View) => void }) {
  const { toast } = useToast()
  const [problems, setProblems] = useState<LCProblem[]>(() => getCachedProblems() ?? [])
  const [comfort, setComfort]   = useState<Map<string, ComfortEntry>>(() => getCachedComfort() ?? new Map())
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState('')
  const [names, setNames]       = useState<MicroNames | null>(null)
  const [query, setQuery]       = useState('')
  const [editing, setEditing]   = useState<string | null>(null)   // problem id open in the editor
  const [targetId, setTargetId] = useState<string | null>(null)   // Prepare-for target
  const [revealed, setRevealed] = useState<Set<string>>(new Set()) // Next cards with the idea shown
  const [busy, setBusy]         = useState(false)

  useEffect(() => {
    let live = true
    void loadMicroNames().then(n => { if (live) setNames(n) })
    ;(async () => {
      try {
        const [ps, cf] = await Promise.all([loadProblems(), loadComfort()])
        if (!live) return
        setProblems(ps); setComfort(new Map(cf))
      } catch (e) {
        if (live) setErr((e as Error).message)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [])

  const ix    = useMemo(() => buildIndex(problems), [problems])
  const next  = useMemo(() => nextToTry(ix, comfort), [ix, comfort])
  const plan  = useMemo(() => targetId ? prepareFor(ix, comfort, targetId) : null, [ix, comfort, targetId])

  const ideaName = (m: string) => names?.micro.get(m) ?? prettyId(m)
  const topicName = (t: string | null) => t ? (names?.topic.get(t) ?? prettyId(t)) : ''

  // Same-tab hop into AdsHub on the problem: put ?id= in the URL first, then
  // switch view. App only pushes a URL when the PATH differs, so the query
  // survives and AdsHub's ?id= handler opens the problem.
  function open(id: string) {
    window.history.pushState(null, '', `${pathForView('ads-hub')}?id=${encodeURIComponent(id)}`)
    onNav('ads-hub')
  }

  async function setLevel(id: string, level: ComfortLevel) {
    const prev = comfort.get(id)
    const entry = { id, level, tries: prev?.tries ?? 0, lastTried: prev?.lastTried ?? '', note: prev?.note ?? '' }
    await persist(entry, `#${id} → ${levelMeta(level).icon} ${levelMeta(level).label}`)
  }
  async function logTry(id: string) {
    const prev = comfort.get(id)
    const entry = { id, level: prev?.level ?? 'tried' as ComfortLevel, tries: (prev?.tries ?? 0) + 1, lastTried: today(), note: prev?.note ?? '' }
    await persist(entry, `#${id}: try ${entry.tries} logged`)
  }
  async function persist(entry: Omit<ComfortEntry, 'updatedAt'>, msg: string) {
    setBusy(true)
    try {
      const saved = await saveComfort(entry)
      setComfort(m => new Map(m).set(saved.id, saved))
      toast(msg, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally { setBusy(false) }
  }
  async function forget(id: string) {
    setBusy(true)
    try {
      await removeComfort(id)
      setComfort(m => { const n = new Map(m); n.delete(id); return n })
      if (targetId === id) setTargetId(null)
      setEditing(null)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally { setBusy(false) }
  }

  // Search: "#200", "200" or words from the title. Top 8.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, '')
    if (!q) return []
    const exact = ix.byId.get(q)
    const words = q.split(/\s+/)
    const hits = problems.filter(p => p !== exact && words.every(w => p.title.toLowerCase().includes(w)))
    return [...(exact ? [exact] : []), ...hits].slice(0, 8)
  }, [query, problems, ix])

  const lanes = COMFORT_LEVELS.map(l => ({
    ...l,
    items: [...comfort.values()].filter(e => e.level === l.id && ix.byId.has(e.id))
      .sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0)),
  }))
  const struggling = [...comfort.values()].filter(e => e.level === 'new' || e.level === 'tried')

  const pLink = (p: LCProblem, extra?: string) => (
    <button className={`sp-plink ${diffCls(p.difficulty)}${extra ? ' ' + extra : ''}`} onClick={() => open(p.frontendId)} title={`Open #${p.frontendId} in AdsHub`}>
      <span className="sp-num">#{p.frontendId}</span> {p.title}
    </button>
  )

  const editor = (id: string) => {
    const p = ix.byId.get(id)
    if (!p) return null
    const e = comfort.get(id)
    return (
      <div className="sp-editor">
        <div className="sp-editor-hd">
          {pLink(p)}
          {e && <span className="sp-meta">{e.tries} tr{e.tries === 1 ? 'y' : 'ies'}{e.lastTried ? ` · last ${e.lastTried}` : ''}</span>}
          <button className="sp-x" onClick={() => setEditing(null)} aria-label="Close">✕</button>
        </div>
        <div className="sp-levels">
          {COMFORT_LEVELS.map(l => (
            <button key={l.id} disabled={busy} title={l.hint}
              className={`sp-level${e?.level === l.id ? ' active' : ''}`}
              onClick={() => void setLevel(id, l.id)}>{l.icon} {l.label}</button>
          ))}
        </div>
        <div className="sp-actions">
          <button disabled={busy} onClick={() => void logTry(id)}>＋ Log a try</button>
          <button onClick={() => { setTargetId(id); setEditing(null); document.getElementById('sp-prepare')?.scrollIntoView({ behavior: 'smooth' }) }}>🎯 Prepare for this</button>
          {e && <button disabled={busy} className="sp-danger" onClick={() => void forget(id)}>Remove</button>}
        </div>
      </div>
    )
  }

  const stepView = (s: IdeaStep) => (
    <li key={s.idea} className={`sp-step${s.knownVia.length ? ' known' : ' gap'}`}>
      <div className="sp-step-hd">
        <span className="sp-step-ico">{s.knownVia.length ? '✅' : '⚠️'}</span>
        <span className="sp-idea">{ideaName(s.idea)}</span>
        {s.topic && <span className="sp-topic">{topicName(s.topic)}</span>}
      </div>
      {s.knownVia.length > 0 && <div className="sp-step-row">You already use it in {s.knownVia.map(p => <span key={p.frontendId}>{pLink(p)}</span>)}</div>}
      {!s.knownVia.length && s.baseVia.length > 0 && <div className="sp-step-row">You know the base: {s.baseVia.map(p => <span key={p.frontendId}>{pLink(p)}</span>)}</div>}
      {!s.knownVia.length && (s.tryFirst.length
        ? <div className="sp-step-row">Try first: {s.tryFirst.map(p => <span key={p.frontendId}>{pLink(p)}</span>)}</div>
        : <div className="sp-step-row sp-dim">No easier problem is tagged with this idea yet.</div>)}
    </li>
  )

  return (
    <div className="sp">
      <div className="sp-hd">
        <h1>🧭 Solve Path</h1>
        <p>Build on what you already solve well, <strong>one new idea at a time</strong>. Mark your comfort with problems; the rest follows from your pattern tags.</p>
      </div>

      {err && <div className="sp-err">Couldn’t load: {err}</div>}

      {/* ── My problems ───────────────────────────────────────────── */}
      <section className="sp-sec">
        <h2>My problems</h2>
        <div className="sp-search">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Add a problem: # or title…" />
          {results.length > 0 && (
            <div className="sp-results">
              {results.map(p => {
                const e = comfort.get(p.frontendId)
                return (
                  <button key={p.frontendId} className="sp-result" onClick={() => { setEditing(p.frontendId); setQuery('') }}>
                    <span className={`sp-num ${diffCls(p.difficulty)}`}>#{p.frontendId}</span> {p.title}
                    {e && <span className="sp-meta"> · {levelMeta(e.level).icon}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {editing && editor(editing)}
        <div className="sp-lanes">
          {lanes.map(l => (
            <div key={l.id} className={`sp-lane sp-lane-${l.id}`}>
              <div className="sp-lane-hd" title={l.hint}>{l.icon} {l.label} <span className="sp-count">{l.items.length}</span></div>
              {l.items.length === 0 && <div className="sp-dim sp-lane-empty">{loading ? 'Loading…' : '—'}</div>}
              {l.items.map(e => {
                const p = ix.byId.get(e.id)!
                return (
                  <button key={e.id} className={`sp-chip${editing === e.id ? ' active' : ''}`} onClick={() => setEditing(editing === e.id ? null : e.id)} title={p.title}>
                    <span className={`sp-num ${diffCls(p.difficulty)}`}>#{p.frontendId}</span> {p.title}
                    {e.tries > 0 && <span className="sp-meta"> ·{e.tries}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </section>

      {/* ── Next to try ───────────────────────────────────────────── */}
      <section className="sp-sec">
        <h2>Next to try</h2>
        <p className="sp-lede">Each one shares an idea with a problem you’re comfortable with and adds <strong>one</strong> new idea. Guess what’s new before you reveal it.</p>
        {!loading && next.length === 0 && (
          <div className="sp-dim">Mark a few problems 🟢 Comfortable or ⭐ Fluent (and make sure they carry pattern tags) to get suggestions.</div>
        )}
        <div className="sp-cards">
          {next.map(c => {
            const shown = revealed.has(c.newIdea)
            const lvl = comfort.get(c.problem.frontendId)
            return (
              <div key={c.newIdea} className="sp-card">
                <div className="sp-card-top">{pLink(c.problem)}{lvl && <span className="sp-meta">{levelMeta(lvl.level).icon}</span>}</div>
                <div className="sp-card-row">Builds on {pLink(c.anchor, 'sp-quiet')}</div>
                {shown
                  ? <div className="sp-card-row sp-new">💡 New idea: <strong>{ideaName(c.newIdea)}</strong>{c.sameTopic ? '' : ' · new topic'}</div>
                  : <button className="sp-reveal" onClick={() => setRevealed(s => new Set(s).add(c.newIdea))}>💡 What’s new here?</button>}
                {c.alternatives.length > 0 && <div className="sp-card-row sp-dim">Same step: {c.alternatives.map(p => <span key={p.frontendId}>{pLink(p, 'sp-quiet')}</span>)}</div>}
                <div className="sp-card-actions">
                  <button onClick={() => setEditing(c.problem.frontendId)}>Set comfort</button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Prepare for… ──────────────────────────────────────────── */}
      <section className="sp-sec" id="sp-prepare">
        <h2>Prepare for…</h2>
        <p className="sp-lede">Pick a problem that feels hard. See which of its ideas you already have, which are gaps, and what to solve first.</p>
        <div className="sp-targets">
          {struggling.length === 0 && <span className="sp-dim">Mark a problem 🔴 Struggling or 🟠 Tried, or use 🎯 on any problem above.</span>}
          {struggling.map(e => {
            const p = ix.byId.get(e.id)
            if (!p) return null
            return (
              <button key={e.id} className={`sp-chip${targetId === e.id ? ' active' : ''}`} onClick={() => setTargetId(e.id)}>
                {levelMeta(e.level).icon} <span className={`sp-num ${diffCls(p.difficulty)}`}>#{p.frontendId}</span> {p.title}
              </button>
            )
          })}
        </div>
        {plan && (
          <div className="sp-plan">
            {plan.steps.length === 0 ? (
              <div className="sp-dim">#{plan.target.frontendId} has no pattern tags yet, so there is nothing to connect it to. Tag it in AdsHub first.</div>
            ) : (
              <>
                <div className="sp-path">
                  {plan.path.map((p, i) => (
                    <span key={p.frontendId} className="sp-path-step">
                      {i > 0 && <span className="sp-arrow">→</span>}
                      {i === plan.path.length - 1 && <span>🎯</span>}
                      {pLink(p)}
                    </span>
                  ))}
                </div>
                <ul className="sp-steps">{plan.steps.map(stepView)}</ul>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
