// SolveMap — the zoomable bubble map in Solve Path's 🗺 Map tab.
//
// A circle-packing of the chosen map layer (lib/solveMap.ts buildLens):
// world → areas → sub-areas → patterns → problems. Click a bubble to zoom in,
// the background or a breadcrumb to zoom out. Zooming animates the SVG viewBox
// (log-scale radius, so it eases like a map). At the deepest level the
// problems are dots coloured by your comfort, and lines join the closely
// related ones — the map turns into a network there. Clicking a problem hands
// it to the parent (street view + detail pane).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { hierarchy, pack, type HierarchyCircularNode } from 'd3-hierarchy'
import { similarity, dominantAspect, type MapNode, type MapIndex, type AspectOn } from '../lib/solveMap'
import { isAnchorLevel, type ComfortEntry } from '../adapters/comfortRepo'

type CNode = HierarchyCircularNode<MapNode>
type View = [number, number, number]   // cx, cy, r in layout units

interface Props {
  root:          MapNode
  ix:            MapIndex
  on:            AspectOn
  comfort:       Map<string, ComfortEntry>
  selectedId:    string | null
  reveal:        { pid: string; n: number } | null   // zoom to where this problem sits
  onPickProblem: (pid: string) => void
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 600, h: 400 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Measure before first paint: the zoom cap depends on the real size.
    const r0 = el.getBoundingClientRect()
    if (r0.width && r0.height) setSize({ w: r0.width, h: r0.height })
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

export default function SolveMap({ root, ix, on, comfort, selectedId, reveal, onPickProblem }: Props) {
  const [wrapRef, size] = useSize<HTMLDivElement>()

  const packed = useMemo(() => pack<MapNode>()
    .size([1000, 1000])
    .padding(d => d.depth === 0 ? 14 : d.depth === 1 ? 7 : 3)(
      hierarchy(root, d => d.children)
        .sum(d => (d.children ? 0 : 1))
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))), [root])
  const byKey = useMemo(() => new Map(packed.descendants().map(n => [n.data.key, n])), [packed])

  // ── Camera ────────────────────────────────────────────────────────────────
  // `view` is a free camera (centre + radius in layout units): drag pans it,
  // the wheel / pinch / + − zoom it continuously. `ctx` is the place you are
  // "in" — the deepest bubble that contains the view centre and still fills a
  // good part of it. It drives the breadcrumb, which level is labelled, and
  // what a click zooms into. Navigation (click a bubble, a crumb, Find) flies
  // the camera to a bubble and pins ctx to it.
  const sizeRef = useRef(size)
  sizeRef.current = size
  const [view, setView] = useState<View>([500, 500, 520])
  const viewRef = useRef(view)
  viewRef.current = view
  const [ctxKey, setCtxKey] = useState('w')
  const focus: CNode = byKey.get(ctxKey) ?? packed

  const ok = (v: View) => v.every(Number.isFinite) && v[2] > 0
  const MIN_R = 2, MAX_R = 900
  const clampView = (v: View): View => [
    Math.min(1300, Math.max(-300, v[0])), Math.min(1300, Math.max(-300, v[1])),
    Math.min(MAX_R, Math.max(MIN_R, v[2])),
  ]
  const pxPerUnit = (v: View) => Math.min(sizeRef.current.w, sizeRef.current.h) / (2 * v[2])

  // The bubble the camera is in, for a given view.
  const derive = (v: View): CNode => {
    let n: CNode = packed
    for (;;) {
      const hit = (n.children ?? []).find(c => !c.data.pid
        && (c.x - v[0]) ** 2 + (c.y - v[1]) ** 2 <= c.r ** 2 && c.r >= v[2] * 0.45)
      if (!hit) return n
      n = hit
    }
  }
  const settle = (v: View = viewRef.current) => setCtxKey(derive(v).data.key)

  // Animated fly-to. Radius interpolates in log space so zooming feels even.
  const anim = useRef(0)
  const stopAnim = () => cancelAnimationFrame(anim.current)
  const flyTo = (target: View, then?: () => void) => {
    stopAnim()
    const to = ok(target) ? clampView(target) : [500, 500, 520] as View
    const from = ok(viewRef.current) ? viewRef.current : to
    const t0 = performance.now(), dur = 480
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      const r = Math.exp(Math.log(from[2]) + (Math.log(to[2]) - Math.log(from[2])) * e)
      const v: View = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e, r]
      viewRef.current = v
      setView(v)
      if (k < 1) anim.current = requestAnimationFrame(tick)
      else then?.()
    }
    anim.current = requestAnimationFrame(tick)
  }
  useEffect(() => stopAnim, [])

  // Frame a bubble; never so close that a problem dot fills the panel (the
  // largest visible dot stays ≤ ~70px), so the area around stays in view.
  // The part of the canvas actually on screen: the canvas rect clipped by the
  // window and by every scrolling / clipping ancestor. When the page scrolls,
  // part of the map sits off screen, and fitting to the whole canvas would
  // centre things below the fold.
  const visibleBox = () => {
    const el = wrapRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    let l = Math.max(r.left, 0), t = Math.max(r.top, 0)
    let rr = Math.min(r.right, window.innerWidth), b = Math.min(r.bottom, window.innerHeight)
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const ar = a.getBoundingClientRect()
      l = Math.max(l, ar.left); t = Math.max(t, ar.top); rr = Math.min(rr, ar.right); b = Math.min(b, ar.bottom)
    }
    // The floating breadcrumb covers the top strip; keep fitted content below it.
    const crumbs = el.querySelector('.sm-crumbs')?.getBoundingClientRect()
    if (crumbs && crumbs.bottom > t && crumbs.bottom < b - 80) t = crumbs.bottom + 4
    return rr - l > 40 && b - t > 40 ? { canvas: r, l, t, w: rr - l, h: b - t } : null
  }

  // Camera that shows a circle (x, y, R) centred in the visible box. The SVG
  // maps the viewBox square onto min(canvas w, h), centred on the canvas; so
  // pick the scale that fits R into the visible box, then shift the view by
  // the gap between the canvas centre and the visible centre.
  const frameCircle = (x: number, y: number, R: number): View => {
    const vb = visibleBox()
    if (!vb) return [x, y, R]
    const k = Math.min(vb.w, vb.h) / (2 * R)                       // px per unit
    const side = Math.min(vb.canvas.width, vb.canvas.height)
    const dx = (vb.l + vb.w / 2) - (vb.canvas.left + vb.canvas.width / 2)
    const dy = (vb.t + vb.h / 2) - (vb.canvas.top + vb.canvas.height / 2)
    return [x - dx / k, y - dy / k, side / (2 * k)]
  }

  // Frame a bubble; never so close that a problem dot fills the panel (the
  // largest visible dot stays ≤ ~70px), so the area around stays in view.
  const frameFor = (n: CNode, margin = 1.05): View => {
    const leafR = Math.max(0, ...n.descendants().filter(d => d.data.pid && d.depth <= n.depth + 2).map(d => d.r))
    const vb = visibleBox()
    const minSide = vb ? Math.min(vb.w, vb.h) : Math.max(1, Math.min(sizeRef.current.w, sizeRef.current.h))
    const R = Math.min(Math.max(n.r * margin, 4, leafR * minSide / 140), 525)
    return frameCircle(n.x, n.y, R)
  }
  const nav = (n: CNode) => { setCtxKey(n.data.key); flyTo(frameFor(n)) }

  // Layer / filter change dropped the place we were in: back to the world.
  useEffect(() => {
    if (!byKey.has(ctxKey)) { setCtxKey('w'); flyTo(frameFor(packed)) }
  }, [byKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom to where a problem sits (from Find, or "back to map" in street view).
  // Once per request: `packed` is rebuilt on every layer / filter / comfort
  // change, and re-applying an old request yanked the map back each time.
  const revealDone = useRef<number | null>(null)
  useEffect(() => {
    if (!reveal || revealDone.current === reveal.n) return
    const leaf = packed.leaves().find(n => n.data.pid === reveal.pid)
    if (!leaf?.parent) return            // not on this layer (yet): try again when it is
    revealDone.current = reveal.n
    nav(leaf.parent)
  }, [reveal, packed]) // eslint-disable-line react-hooks/exhaustive-deps

  // Free zoom by a factor, keeping the layout point (ax, ay) fixed on screen.
  const zoomBy = (f: number, ax?: number, ay?: number, animate = false) => {
    const v = viewRef.current
    const r = Math.min(MAX_R, Math.max(MIN_R, v[2] * f)), q = r / v[2]
    const x = ax ?? v[0], y = ay ?? v[1]
    const next = clampView([x - (x - v[0]) * q, y - (y - v[1]) * q, r])
    if (animate) { flyTo(next, () => settle(next)); return }
    stopAnim(); viewRef.current = next; setView(next); settle(next)
  }
  // Pan by a fraction of the view (arrow buttons / keys).
  const panBy = (fx: number, fy: number) => {
    const v = viewRef.current
    const next: View = [v[0] + fx * v[2], v[1] + fy * v[2], v[2]]
    flyTo(next, () => settle(next))
  }
  // ⛶ Fit: centre the place you're in (the last breadcrumb) and size it to
  // the window. ⌂ Home: the whole map.
  const fit = () => flyTo(frameFor(focus, 1.02))
  const home = () => { setCtxKey(packed.data.key); flyTo(frameFor(packed, 1.02)) }

  const scale = Math.min(size.w, size.h) / (2 * view[2])   // px per layout unit
  const fs = (px: number) => px / scale                       // px → layout units

  // What to draw: the focus's children (labelled) and grandchildren (texture).
  const shown = useMemo(
    () => focus.descendants().filter(n => n.depth > focus.depth && n.depth <= focus.depth + 2),
    [focus])

  // Network lines among the problems when the focus's children are problems.
  const edges = useMemo(() => {
    const kids = (focus.children ?? []).filter(c => c.data.pid)
    if (kids.length < 2 || kids.length > 140) return []
    const out: { a: CNode; b: CNode; sim: number; cls: string }[] = []
    const seen = new Set<string>()
    for (const a of kids) {
      const links = kids.filter(b => b !== a)
        .map(b => ({ b, l: similarity(ix, a.data.pid!, b.data.pid!, on) }))
        .filter(x => x.l.sim >= 0.3)
        .sort((x, y) => y.l.sim - x.l.sim).slice(0, 2)
      for (const { b, l } of links) {
        const k = [a.data.pid, b.data.pid].sort().join('-')
        if (seen.has(k)) continue
        seen.add(k)
        out.push({ a, b, sim: l.sim, cls: dominantAspect(ix, l.shared, on) })
      }
    }
    return out
  }, [focus, ix, on])

  const known = (n: CNode) => {
    const ids = new Set(n.leaves().map(l => l.data.pid!))
    let k = 0
    for (const id of ids) { const e = comfort.get(id); if (e && isAnchorLevel(e.level)) k++ }
    return { k, total: ids.size }
  }

  // A level with a single child looks the same as that child, so navigation
  // steps straight through it in both directions.
  const zoomInto = (n: CNode) => {
    let t = n
    while (t.children?.length === 1 && !t.children[0].data.pid) t = t.children[0]
    nav(t)
  }
  const levelUp = () => {
    let t = focus.parent
    while (t && t.parent && (t.children?.length ?? 0) <= 1) t = t.parent
    if (t) nav(t)
  }

  // ── Drag to pan ────────────────────────────────────────────────────────────
  // A press that moves more than a few px is a drag: it pans and swallows the
  // click that follows, so letting go over a bubble doesn't also zoom into it.
  const drag = useRef<{ x: number; y: number; v: View; moved: boolean; id: number } | null>(null)
  const swallowClick = useRef(false)
  const [dragging, setDragging] = useState(false)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, v: viewRef.current, moved: false, id: e.pointerId }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return
      d.moved = true
      stopAnim()
      setDragging(true)
      ;(e.currentTarget as Element).setPointerCapture(d.id)
    }
    const k = pxPerUnit(d.v)
    const v = clampView([d.v[0] - dx / k, d.v[1] - dy / k, d.v[2]])
    viewRef.current = v
    setView(v)
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d?.moved) return
    setDragging(false)
    swallowClick.current = true
    setTimeout(() => { swallowClick.current = false }, 0)
    settle()
  }

  function click(n: CNode, ev: React.MouseEvent) {
    ev.stopPropagation()
    if (swallowClick.current) return
    if (n.data.pid) { onPickProblem(n.data.pid); return }
    // Into this bubble, or its ancestor just below where we are.
    let t: CNode = n
    while (t.parent && t.parent !== focus && t.depth > focus.depth + 1) t = t.parent
    zoomInto(t.depth > focus.depth ? t : n)
  }
  const clickBackground = () => { if (!swallowClick.current) levelUp() }

  // ── Wheel / trackpad pinch: smooth zoom around the pointer ────────────────
  const zoomRef = useRef(zoomBy); zoomRef.current = zoomBy
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const svg = el.querySelector('svg')
      if (!svg) return
      const b = svg.getBoundingClientRect(), v = viewRef.current
      const k = Math.min(b.width, b.height) / (2 * v[2])
      const x = v[0] + (e.clientX - (b.left + b.width / 2)) / k
      const y = v[1] + (e.clientY - (b.top + b.height / 2)) / k
      // Pinch arrives as ctrl+wheel with small deltas: scale it up.
      const f = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0022))
      zoomRef.current(f, x, y)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wrapRef])

  const crumbs = focus.ancestors().reverse()
  const STEP = 1.6, PAN = 0.35

  return (
    <div className="sm">
      <div className={`sm-canvas${dragging ? ' dragging' : ''}`} ref={wrapRef} tabIndex={0}
        aria-label="Pattern map. Drag or arrow keys to move, plus and minus to zoom, Escape to go up a level, 0 to fit the current area, Home for the whole map."
        onKeyDown={e => {
          const k = e.key
          const act: Record<string, () => void> = {
            '+': () => zoomBy(1 / STEP, undefined, undefined, true), '=': () => zoomBy(1 / STEP, undefined, undefined, true),
            '-': () => zoomBy(STEP, undefined, undefined, true), '_': () => zoomBy(STEP, undefined, undefined, true),
            ArrowLeft: () => panBy(-PAN, 0), ArrowRight: () => panBy(PAN, 0),
            ArrowUp: () => panBy(0, -PAN), ArrowDown: () => panBy(0, PAN),
            Escape: levelUp, '0': fit, Home: home,
          }
          if (act[k]) { e.preventDefault(); act[k]() }
        }}>
      {/* Breadcrumb floats over the map's top-left, like a map's place label. */}
      <div className="sm-crumbs" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
        {crumbs.map((c, i) => (
          <span key={c.data.key} className="sm-crumb">
            {i > 0 && <span className="sm-crumb-sep">›</span>}
            <button onClick={() => nav(c)} disabled={c === focus}>{c.data.name}</button>
          </span>
        ))}
        <span className="sm-crumb-count">{known(focus).total} problems</span>
        <span className="sm-help" tabIndex={0} aria-label="How to use the map"
          title="Drag to move around. Scroll, pinch or + / − to zoom. Click a bubble to fly into it; click the background or Esc to go up a level; ⛶ fits the area you're in; ⌂ shows the whole map. At the deepest level, click a problem for its street view.">ⓘ</span>
      </div>
      {/* Floating controls, bottom-right like a map: pan pad + zoom. */}
      <div className="sm-ctl" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
        <div className="sm-pad" role="group" aria-label="Move the map">
          <button className="up"    onClick={() => panBy(0, -PAN)} title="Move up (↑)"    aria-label="Move up">▲</button>
          <button className="left"  onClick={() => panBy(-PAN, 0)} title="Move left (←)"  aria-label="Move left">◀</button>
          <button className="home"  onClick={home}                 title="Home: the whole map (Home)" aria-label="Whole map">⌂</button>
          <button className="right" onClick={() => panBy(PAN, 0)}  title="Move right (→)" aria-label="Move right">▶</button>
          <button className="down"  onClick={() => panBy(0, PAN)}  title="Move down (↓)"  aria-label="Move down">▼</button>
        </div>
        <div className="sm-zoomctl" role="group" aria-label="Zoom">
          <button onClick={fit} className="sm-fit" title="Fit: centre the area you're in and size it to the window (0)" aria-label="Fit the current area to the window">⛶</button>
          <button onClick={() => zoomBy(1 / STEP, undefined, undefined, true)} disabled={view[2] <= MIN_R * 1.01} title="Zoom in (scroll up, +)" aria-label="Zoom in">+</button>
          <button onClick={() => zoomBy(STEP, undefined, undefined, true)} disabled={view[2] >= MAX_R * 0.99} title="Zoom out (scroll down, −)" aria-label="Zoom out">−</button>
          <button onClick={levelUp} disabled={!focus.parent} title="Up one level (Esc)" aria-label="Up one level" className="sm-up">⤴</button>
        </div>
      </div>
        <svg
          className="sm-svg"
          viewBox={`${view[0] - view[2]} ${view[1] - view[2]} ${view[2] * 2} ${view[2] * 2}`}
          preserveAspectRatio="xMidYMid meet"
          onClick={clickBackground}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        >
          <circle className="sm-focus" cx={focus.x} cy={focus.y} r={focus.r} />
          {shown.map(n => {
            const rel = n.depth - focus.depth
            const pid = n.data.pid
            if (pid) {
              const lvl = comfort.get(pid)?.level ?? 'none'
              return (
                <circle key={n.data.key} cx={n.x} cy={n.y} r={n.r}
                  className={`sm-p sm-c-${lvl}${pid === selectedId ? ' sel' : ''}${rel === 2 ? ' far' : ''}`}
                  strokeWidth={fs(pid === selectedId ? 3 : 1)}
                  onClick={e => click(n, e)}>
                  <title>#{pid} {n.data.name}</title>
                </circle>
              )
            }
            return (
              <circle key={n.data.key} cx={n.x} cy={n.y} r={n.r}
                className={`sm-n sm-d${rel}`} strokeWidth={fs(1)}
                onClick={e => click(n, e)}>
                <title>{n.data.name}</title>
              </circle>
            )
          })}
          {edges.map(e => (
            <line key={`${e.a.data.key}~${e.b.data.key}`} className={`sm-edge sm-a-${e.cls}`}
              x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y}
              strokeWidth={fs(1 + 4 * e.sim)} />
          ))}
          {/* Labels last so they sit above circles and lines. */}
          {shown.filter(n => n.depth === focus.depth + 1).map(n => {
            const pr = n.r * scale
            if (n.data.pid) {
              if (pr < 9) return null
              // Room to spare (deepest zoom): the title under the number.
              const title = pr >= 48 ? (n.data.name.length > 26 ? n.data.name.slice(0, 25) + '…' : n.data.name) : ''
              return (
                <g key={'t' + n.data.key}>
                  <text x={n.x} y={title ? n.y - fs(8) : n.y} className="sm-plabel" fontSize={fs(Math.min(13, pr * 0.7))}>
                    #{n.data.pid}
                  </text>
                  {title && <text x={n.x} y={n.y + fs(10)} className="sm-plabel sm-ptitle" fontSize={fs(11)}>{title}</text>}
                </g>
              )
            }
            if (pr < 26) return null
            const { k, total } = known(n)
            const name = n.data.name.length > 28 ? n.data.name.slice(0, 27) + '…' : n.data.name
            return (
              <g key={'t' + n.data.key} className="sm-label">
                <text x={n.x} y={n.y - fs(4)} fontSize={fs(Math.min(15, Math.max(10, pr / 6)))}>{name}</text>
                <text x={n.x} y={n.y + fs(12)} fontSize={fs(11)} className="sm-sub">
                  {total}{k ? ` · 🟢 ${k}` : ''}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
