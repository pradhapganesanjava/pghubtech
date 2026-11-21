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
// Lives inside AdsHub as a mode (beside Lineage / Patterns / Recall). Every
// problem link opens in AdsHub's side detail pane, so the page stays put while
// you read; ‹ › in the strip at the top step through the problems on the page.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { LCProblem } from '../adapters/adsRepo'
import {
  loadComfort, getCachedComfort, saveComfort, removeComfort, today,
  COMFORT_LEVELS, levelMeta, type ComfortEntry, type ComfortLevel,
} from '../adapters/comfortRepo'
import { buildIndex, nextToTry, prepareFor, type IdeaStep } from '../lib/solvePath'
import { loadMicroNames, prettyId, type MicroNames } from '../lib/microNames'
import {
  ASPECTS, buildMapIndex, buildLens, neighbors, route,
  type Aspect, type AspectOn, type Lens,
} from '../lib/solveMap'
import { useToast } from '../components/Toast'
import SolveMap from '../components/SolveMap'
import SolveStreet from '../components/SolveStreet'

type Tab = 'map' | 'mine' | 'next' | 'prep'
const TABS: { id: Tab; label: string }[] = [
  { id: 'map',  label: '🗺 Map' },
  { id: 'mine', label: 'My problems' },
  { id: 'next', label: 'Next to try' },
  { id: 'prep', label: 'Prepare for…' },
]
type ComfortFilter = 'all' | 'unmarked' | 'learning' | 'known'
const DIFFS = ['Easy', 'Medium', 'Hard'] as const
// Short layer names for the one-line filter strip (full names in tooltips).
const SHORT: Record<string, string> = { ds: 'DS', tech: 'Technique', family: 'Family', story: 'Story' }

const diffCls = (d: string) =>
  d === 'Easy' ? 'sp-easy' : d === 'Hard' ? 'sp-hard' : 'sp-medium'

interface Props {
  problems: LCProblem[]                  // AdsHub's rows, so ↻ there refreshes this too
  problemsLoading: boolean
  selectedId: string | null              // problem open in the detail pane
  onOpenProblem: (p: LCProblem) => void  // open it in the detail pane
  refreshKey?: number                    // bumped by AdsHub's ↻: re-read Comfort
}

export default function SolvePathView({ problems, problemsLoading, selectedId, onOpenProblem, refreshKey = 0 }: Props) {
  const { toast } = useToast()
  const [comfort, setComfort]   = useState<Map<string, ComfortEntry>>(() => getCachedComfort() ?? new Map())
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState('')
  const [names, setNames]       = useState<MicroNames | null>(null)
  const [query, setQuery]       = useState('')
  const [editing, setEditing]   = useState<string | null>(null)   // problem id open in the editor
  const [targetId, setTargetId] = useState<string | null>(null)   // Prepare-for target
  const [revealed, setRevealed] = useState<Set<string>>(new Set()) // Next cards with the idea shown
  const [busy, setBusy]         = useState(false)
  const [tab, setTab]           = useState<Tab>('map')
  // 🗺 Map state
  const [lens, setLens]         = useState<Lens>('ds')
  const [on, setOn]             = useState<AspectOn>({ ds: true, tech: true, family: true, story: true })
  const [diffs, setDiffs]       = useState<Set<string>>(() => new Set(DIFFS))
  const [cFilter, setCFilter]   = useState<ComfortFilter>('all')
  const [center, setCenter]     = useState<string | null>(null)   // street view centre
  const [trail, setTrail]       = useState<string[]>([])          // street view back-stack
  const [reveal, setReveal]     = useState<{ pid: string; n: number } | null>(null)
  const [findQ, setFindQ]       = useState('')
  const [routeQ, setRouteQ]     = useState('')
  const [routePath, setRoutePath] = useState<string[] | null>(null)
  const [familiar, setFamiliar] = useState(true)
  // ⋯ map-options menu (same pattern as AdsHub Browse's tb-overflow).
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  useEffect(() => {
    let live = true
    void loadMicroNames().then(n => { if (live) setNames(n) })
    ;(async () => {
      try {
        // Always fresh from the sheet (on open and on every ↻): comfort can be
        // edited elsewhere — the sheet itself, another device.
        const cf = await loadComfort(true)
        if (live) setComfort(new Map(cf))
      } catch (e) {
        if (live) setErr((e as Error).message)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [refreshKey])

  const busyLoading = loading || problemsLoading
  const ix    = useMemo(() => buildIndex(problems), [problems])
  const next  = useMemo(() => nextToTry(ix, comfort), [ix, comfort])
  const plan  = useMemo(() => targetId ? prepareFor(ix, comfort, targetId) : null, [ix, comfort, targetId])

  const ideaName = (m: string) => names?.micro.get(m) ?? prettyId(m)
  const topicName = (t: string | null) => t ? (names?.topic.get(t) ?? prettyId(t)) : ''

  function open(id: string) {
    const p = ix.byId.get(id)
    if (p) onOpenProblem(p)
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
  const search = (raw: string) => {
    const q = raw.trim().toLowerCase().replace(/^#/, '')
    if (!q) return []
    const exact = ix.byId.get(q)
    const words = q.split(/\s+/)
    const hits = problems.filter(p => p !== exact && words.every(w => p.title.toLowerCase().includes(w)))
    return [...(exact ? [exact] : []), ...hits].slice(0, 8)
  }
  const results = useMemo(() => search(query), [query, problems, ix])            // eslint-disable-line react-hooks/exhaustive-deps
  const findResults = useMemo(() => search(findQ), [findQ, problems, ix])       // eslint-disable-line react-hooks/exhaustive-deps
  const routeResults = useMemo(() => search(routeQ), [routeQ, problems, ix])    // eslint-disable-line react-hooks/exhaustive-deps

  // ── 🗺 Map ──────────────────────────────────────────────────────────────
  const mix = useMemo(() => buildMapIndex(problems), [problems])
  const keep = useMemo(() => (pid: string) => {
    const p = mix.byId.get(pid)
    if (!p || !diffs.has(p.difficulty || 'Medium')) return false
    const lvl = comfort.get(pid)?.level
    if (cFilter === 'unmarked') return !lvl
    if (cFilter === 'learning') return lvl === 'new' || lvl === 'tried'
    if (cFilter === 'known')    return lvl === 'comfortable' || lvl === 'fluent'
    return true
  }, [mix, diffs, cFilter, comfort])
  const lensRoot = useMemo(() => buildLens(mix, lens, names, keep), [mix, lens, names, keep])
  const links = useMemo(() => center ? neighbors(mix, center, on, 10, keep) : [], [mix, center, on, keep])
  const routeAt = center && routePath ? routePath.indexOf(center) : -1
  const nextStep = routePath && routeAt >= 0 && routeAt < routePath.length - 1 ? routePath[routeAt + 1] : null
  // The route's next step is always drawn, even when it isn't a top-10 match.
  const streetLinks = useMemo(() => {
    if (!nextStep || links.some(l => l.id === nextStep)) return links
    const extra = neighbors(mix, center!, on, 400).find(l => l.id === nextStep)
    return extra ? [...links.slice(0, 9), extra] : links
  }, [links, nextStep, mix, center, on])

  // Walk to a problem: it becomes the street-view centre and opens beside.
  function goTo(pid: string, remember = true) {
    if (remember && center && center !== pid) setTrail(t => [...t, center])
    setCenter(pid)
    open(pid)
  }
  function back() {
    const prev = trail[trail.length - 1]
    if (!prev) return
    setTrail(t => t.slice(0, -1))
    goTo(prev, false)
  }
  function toMap() {
    if (center) setReveal({ pid: center, n: Date.now() })
    setCenter(null)
  }
  function planRoute(target: string) {
    setRouteQ('')
    if (!center) return
    const path = route(mix, center, target, on, comfort, familiar)
    if (!path) { toast(`No route from #${center} to #${target} with the aspects switched on`, 'error'); return }
    setRoutePath(path)
  }
  const toggleAspect = (a: Aspect) => setOn(o => {
    const n = { ...o, [a]: !o[a] }
    return Object.values(n).some(Boolean) ? n : o        // keep at least one on
  })
  const toggleDiff = (d: string) => setDiffs(s => {
    const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d)
    return n.size ? n : s
  })
  // Lights the ⋯ when anything narrows the map (layer choice doesn't count).
  const filtersActive = diffs.size < DIFFS.length || cFilter !== 'all' || !Object.values(on).every(Boolean) || !!findQ.trim()
  const resetFilters = () => {
    setDiffs(new Set(DIFFS)); setCFilter('all'); setOn({ ds: true, tech: true, family: true, story: true }); setFindQ('')
  }

  const lanes = useMemo(() => COMFORT_LEVELS.map(l => ({
    ...l,
    items: [...comfort.values()].filter(e => e.level === l.id && ix.byId.has(e.id))
      .sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0)),
  })), [comfort, ix])
  const struggling = [...comfort.values()].filter(e => e.level === 'new' || e.level === 'tried')

  // What ‹ › step through. On the Map: the route if one is set, else the
  // street-view centre and its connections. Elsewhere: every problem on the
  // page in reading order (lanes → Next to try → the Prepare path), once each.
  const navIds = useMemo(() => {
    if (tab === 'map') return routePath ?? (center ? [center, ...streetLinks.map(l => l.id)] : [])
    const seen = new Set<string>()
    const add = (id: string) => { if (ix.byId.has(id)) seen.add(id) }
    for (const l of lanes) for (const e of l.items) add(e.id)
    for (const c of next) { add(c.problem.frontendId); add(c.anchor.frontendId); c.alternatives.forEach(p => add(p.frontendId)) }
    if (plan) for (const p of plan.path) add(p.frontendId)
    return [...seen]
  }, [tab, routePath, center, streetLinks, lanes, next, plan, ix])
  const pos = selectedId ? navIds.indexOf(selectedId) : -1
  const step = (d: number) => {
    if (!navIds.length) return
    const i = pos < 0 ? (d > 0 ? 0 : navIds.length - 1) : (pos + d + navIds.length) % navIds.length
    // On a route, stepping walks it (the centre moves); else it just opens.
    if (tab === 'map' && routePath) goTo(navIds[i]); else open(navIds[i])
  }
  const current = selectedId ? ix.byId.get(selectedId) : undefined

  const pLink = (p: LCProblem, extra?: string) => (
    <button className={`sp-plink ${diffCls(p.difficulty)}${extra ? ' ' + extra : ''}${selectedId === p.frontendId ? ' sel' : ''}`} onClick={() => open(p.frontendId)} title={`Open #${p.frontendId} beside`}>
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
          <button onClick={() => { setTargetId(id); setEditing(null); setTab('prep') }}>🎯 Prepare for this</button>
          <button onClick={() => { setEditing(null); setTab('map'); goTo(id) }}>🗺 See on map</button>
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
    <div className="sp sp--embed">
      <div className="sp-nav">
        <span className="sp-nav-title">🧭 Solve Path</span>
        <div className="sp-tabs" role="tablist">
          {TABS.map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id}
              className={`sp-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        {tab === 'map' && (
          <div className="tb-overflow sp-menu" ref={menuRef}>
            <button
              className={`tb-overflow-trigger${filtersActive ? ' has-active' : ''}`}
              onClick={() => setMenuOpen(o => !o)}
              title="Map options: layer, connect by, difficulty, comfort, find"
              aria-label="Map options" aria-haspopup="true" aria-expanded={menuOpen}
            >⋯</button>
            <div className={`tb-overflow-items sp-menu-items${menuOpen ? ' open' : ''}`} role="menu">
              <input className="sp-menu-find" value={findQ} onChange={e => setFindQ(e.target.value)}
                placeholder="Find # or title…" aria-label="Find a problem" autoFocus={menuOpen} />
              {findResults.length > 0 && (
                <div className="sp-menu-results">
                  {findResults.map(p => (
                    <button key={p.frontendId} className="sp-result" onClick={() => { setFindQ(''); setMenuOpen(false); goTo(p.frontendId) }}>
                      <span className={`sp-num ${diffCls(p.difficulty)}`}>#{p.frontendId}</span> {p.title}
                    </button>
                  ))}
                </div>
              )}
              {!center && (
                <div className="sp-menu-row">
                  <span className="sp-menu-lbl">Layer</span>
                  <select className="sp-nav-sel" value={lens} onChange={e => setLens(e.target.value as Lens)} aria-label="Map layer">
                    {ASPECTS.map(a => <option key={a.id} value={a.id}>{a.icon} {a.label}</option>)}
                  </select>
                </div>
              )}
              <div className="sp-menu-row">
                <span className="sp-menu-lbl" title="Which shared aspects count in match scores">Connect by</span>
                <span className="sp-menu-chips">
                  {ASPECTS.map(a => (
                    <button key={a.id} className={`sm-toggle sm-a-${a.id}${on[a.id] ? ' on' : ''}`} onClick={() => toggleAspect(a.id)}
                      aria-pressed={on[a.id]} title={`${on[a.id] ? 'Counted' : 'Ignored'} in match scores`}>{a.icon} {SHORT[a.id]}</button>
                  ))}
                </span>
              </div>
              <div className="sp-menu-row">
                <span className="sp-menu-lbl">Difficulty</span>
                <span className="sp-menu-chips">
                  {DIFFS.map(d => (
                    <button key={d} className={`sm-toggle sm-diff-${d.toLowerCase()}${diffs.has(d) ? ' on' : ''}`} onClick={() => toggleDiff(d)} aria-pressed={diffs.has(d)}>{d}</button>
                  ))}
                </span>
              </div>
              <div className="sp-menu-row">
                <span className="sp-menu-lbl">Comfort</span>
                <select className="sp-nav-sel" value={cFilter} onChange={e => setCFilter(e.target.value as ComfortFilter)} aria-label="Comfort filter">
                  <option value="all">Any comfort</option>
                  <option value="unmarked">Not marked yet</option>
                  <option value="learning">🔴🟠 Struggling or tried</option>
                  <option value="known">🟢⭐ Comfortable or fluent</option>
                </select>
              </div>
              {filtersActive && (
                <button className="sp-menu-reset" onClick={resetFilters}>Reset filters</button>
              )}
            </div>
          </div>
        )}
        {navIds.length > 0 && (
          <span className="sp-nav-pos" title={current ? `Viewing #${current.frontendId} ${current.title}` : undefined}>{pos >= 0 ? `${pos + 1} / ${navIds.length}` : `${navIds.length}`}</span>
        )}
        <button className="sp-nav-btn" onClick={() => step(-1)} disabled={!navIds.length} title={current ? `Previous problem (viewing #${current.frontendId} ${current.title})` : 'Previous problem'} aria-label="Previous problem">‹</button>
        <button className="sp-nav-btn" onClick={() => step(1)}  disabled={!navIds.length} title={current ? `Next problem (viewing #${current.frontendId} ${current.title})` : 'Next problem'} aria-label="Next problem">›</button>
      </div>
      <div className={`sp-body${tab === 'map' ? ' sp-body--map' : ''}`}>
      {err && <div className="sp-err">Couldn’t load: {err}</div>}
      {editing && editor(editing)}

      {/* ── 🗺 Map ────────────────────────────────────────────────── */}
      {tab === 'map' && (
        <div className="sm-wrap">
          {!center ? (
            <>
              <SolveMap root={lensRoot} ix={mix} on={on} comfort={comfort} selectedId={selectedId}
                reveal={reveal} onPickProblem={pid => goTo(pid)} />
            </>
          ) : (
            <div className="ss-wrap">
              <div className="ss-hd">
                <button className="sm-btn" onClick={back} disabled={!trail.length} title="Back to the previous problem">← Back</button>
                <button className="sm-btn" onClick={toMap} title="Zoom out to the map, where this problem sits">🗺 Map</button>
                <span className="ss-hd-title">
                  {(() => { const p = ix.byId.get(center); return p ? <><span className={`sp-num ${diffCls(p.difficulty)}`}>#{p.frontendId}</span> {p.title}</> : null })()}
                  {comfort.get(center) && <span className="sp-meta">{levelMeta(comfort.get(center)!.level).icon}</span>}
                </span>
                <button className="sm-btn" onClick={() => setEditing(center)}>Set comfort</button>
              </div>
              <div className="ss-route">
                <div className="sp-search">
                  <input value={routeQ} onChange={e => setRouteQ(e.target.value)} placeholder={`🧭 Route from #${center} to… (# or title)`} />
                  {routeResults.length > 0 && (
                    <div className="sp-results">
                      {routeResults.map(p => (
                        <button key={p.frontendId} className="sp-result" onClick={() => planRoute(p.frontendId)}>
                          <span className={`sp-num ${diffCls(p.difficulty)}`}>#{p.frontendId}</span> {p.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <label className="sm-check" title="Prefer routes through problems you are comfortable with">
                  <input type="checkbox" checked={familiar} onChange={e => setFamiliar(e.target.checked)} /> via familiar
                </label>
              </div>
              {routePath && (
                <div className="sp-path ss-path">
                  {routePath.map((id, i) => {
                    const p = ix.byId.get(id)!
                    const e = comfort.get(id)
                    return (
                      <span key={id} className={`sp-path-step${id === center ? ' here' : ''}`}>
                        {i > 0 && <span className="sp-arrow">→</span>}
                        {i === routePath.length - 1 && <span>🎯</span>}
                        <button className={`sp-plink ${diffCls(p.difficulty)}${id === center ? ' sel' : ''}`} onClick={() => goTo(id)} title={p.title}>
                          <span className="sp-num">#{id}</span>{e ? ` ${levelMeta(e.level).icon}` : ''}
                        </button>
                      </span>
                    )
                  })}
                  <button className="sp-x" onClick={() => setRoutePath(null)} aria-label="Clear route" title="Clear route">✕</button>
                </div>
              )}
              <SolveStreet ix={mix} on={on} names={names} comfort={comfort} centerId={center}
                links={streetLinks} nextStep={nextStep} onMove={pid => goTo(pid)} />
            </div>
          )}
        </div>
      )}

      {tab !== 'map' && (
        <div className="sp-hd">
          <p>Build on what you already solve well, <strong>one new idea at a time</strong>. Mark your comfort with problems; the rest follows from your pattern tags.</p>
        </div>
      )}

      {/* ── My problems ───────────────────────────────────────────── */}
      {tab === 'mine' && (
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
        <div className="sp-lanes">
          {lanes.map(l => (
            <div key={l.id} className={`sp-lane sp-lane-${l.id}`}>
              <div className="sp-lane-hd" title={l.hint}>{l.icon} {l.label} <span className="sp-count">{l.items.length}</span></div>
              {l.items.length === 0 && <div className="sp-dim sp-lane-empty">{busyLoading ? 'Loading…' : '—'}</div>}
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
      )}

      {/* ── Next to try ───────────────────────────────────────────── */}
      {tab === 'next' && (
      <section className="sp-sec">
        <h2>Next to try</h2>
        <p className="sp-lede">Each one shares an idea with a problem you’re comfortable with and adds <strong>one</strong> new idea. Guess what’s new before you reveal it.</p>
        {!busyLoading && next.length === 0 && (
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
      )}

      {/* ── Prepare for… ──────────────────────────────────────────── */}
      {tab === 'prep' && (
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
      )}
      </div>
    </div>
  )
}
