import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { getStroke } from 'perfect-freehand'

// ── GoodNotes-style handwriting pad — multi-mode ─────────────────────────────
// Same data model and toolbar across all modes; only the input + render path
// differs, so you can switch modes mid-edit to compare on iPad.
//   Smooth    — perfect-freehand on two layered canvases, rAF-batched, with
//               predicted-events tail. Best stroke quality.
//   Immediate — same canvases + perfect-freehand, but no rAF and no predicted
//               tail — paint synchronously on every move (lowest latency).
//   Direct    — single canvas, plain ctx.lineTo segments per move event. No
//               rAF, no perfect-freehand, no predicted. Bare-metal.
//   SVG       — strokes are <path> elements appended to an <svg>. Browser
//               composites natively; the active stroke updates one path's d.

export type DrawMode = 'react' | 'smooth' | 'immediate' | 'direct' | 'svg'
const MODE_STORAGE = 'adshub.hw.mode'

export interface HwStroke { tool: 'pen'; color: string; size: number; points: number[][] } // [x, y, pressure]
export interface HwPage { strokes: HwStroke[] }
export interface HwDoc { pages: HwPage[] }
export interface HandwritingPadHandle {
  getDoc(): HwDoc
  exportPagePngs(): Promise<Blob[]>
}

const PAGE_W = 1000
const PAGE_H = 1400
const COLORS = ['#1a1a2e', '#e94545', '#2563eb', '#16a34a', '#f59e0b', '#9333ea']
const SIZES  = [2, 4, 7]
const ERASE_R = 18

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy
}

function pfOptions(size: number) {
  return { size, thinning: 0.55, smoothing: 0.55, streamline: 0.45, easing: (t: number) => t, simulatePressure: false, last: true }
}
function strokePath(outline: number[][]): Path2D {
  const p = new Path2D()
  if (!outline.length) return p
  p.moveTo(outline[0][0], outline[0][1])
  for (let i = 1; i < outline.length; i++) p.lineTo(outline[i][0], outline[i][1])
  p.closePath(); return p
}
function paintStrokeFreehand(ctx: CanvasRenderingContext2D, s: HwStroke) {
  if (!s.points.length) return
  const outline = getStroke(s.points, pfOptions(s.size)) as number[][]
  if (!outline.length) return
  ctx.fillStyle = s.color
  ctx.fill(strokePath(outline))
}
// Used by SVG mode and PNG export.
function strokeToSvgD(s: HwStroke): string {
  const outline = getStroke(s.points, pfOptions(s.size)) as number[][]
  if (!outline.length) return ''
  let d = `M${outline[0][0].toFixed(2)},${outline[0][1].toFixed(2)}`
  for (let i = 1; i < outline.length; i++) d += `L${outline[i][0].toFixed(2)},${outline[i][1].toFixed(2)}`
  return d + 'Z'
}

function ensureSize(canvas: HTMLCanvasElement) {
  const r = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr))
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(canvas.width / PAGE_W, 0, 0, canvas.height / PAGE_H, 0, 0)
  return ctx
}

// ───────────────────────────────────────────────────────────────────────────
// Pad core props — shared across modes
// ───────────────────────────────────────────────────────────────────────────
interface PadProps {
  page:    HwPage
  pageKey: string             // bumps when page identity changes → mode resets
  tool:    'pen' | 'eraser' | 'pan'
  color:   string
  size:    number
  onCommit: (stroke: HwStroke) => void
  onErase:  (x: number, y: number) => void
}

function logicalFrom(el: Element, e: { clientX: number; clientY: number }): [number, number] {
  const r = el.getBoundingClientRect()
  return [(e.clientX - r.left) / r.width * PAGE_W, (e.clientY - r.top) / r.height * PAGE_H]
}

// ── Smooth (perfect-freehand + 2 canvases + rAF + predicted) ─────────────────
function SmoothPad({ page, pageKey, tool, color, size, onCommit, onErase }: PadProps) {
  const committedRef = useRef<HTMLCanvasElement>(null)
  const liveRef      = useRef<HTMLCanvasElement>(null)
  const drawing      = useRef<HwStroke | null>(null)
  const predicted    = useRef<number[][]>([])
  const rafId        = useRef<number | null>(null)

  function paintCommitted() {
    const c = committedRef.current; if (!c) return
    const ctx = ensureSize(c); ctx.clearRect(0, 0, PAGE_W, PAGE_H)
    for (const s of page.strokes) paintStrokeFreehand(ctx, s)
  }
  function paintLive() {
    const c = liveRef.current; if (!c) return
    const ctx = ensureSize(c); ctx.clearRect(0, 0, PAGE_W, PAGE_H)
    const cur = drawing.current
    if (!cur || !cur.points.length) return
    const merged: HwStroke = predicted.current.length
      ? { ...cur, points: [...cur.points, ...predicted.current] } : cur
    paintStrokeFreehand(ctx, merged)
  }
  function scheduleLive() {
    if (rafId.current != null) return
    rafId.current = requestAnimationFrame(() => { rafId.current = null; paintLive() })
  }

  useEffect(() => { paintCommitted(); paintLive() /* eslint-disable-next-line */ }, [page, pageKey])
  useEffect(() => {
    const ro = new ResizeObserver(() => { paintCommitted(); paintLive() })
    if (liveRef.current) ro.observe(liveRef.current)
    return () => ro.disconnect()
  }, []) // eslint-disable-line

  function commit() {
    const cur = drawing.current; drawing.current = null; predicted.current = []
    if (!cur || !cur.points.length) return
    const ctx = committedRef.current?.getContext('2d')
    if (ctx) paintStrokeFreehand(ctx, cur)
    const live = liveRef.current?.getContext('2d')
    if (live) live.clearRect(0, 0, PAGE_W, PAGE_H)
    onCommit(cur)
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === 'pan' || e.pointerType === 'touch') return
    e.preventDefault(); commit()
    liveRef.current!.setPointerCapture(e.pointerId)
    const [x, y] = logicalFrom(liveRef.current!, e)
    if (tool === 'eraser') { onErase(x, y); return }
    drawing.current = { tool: 'pen', color, size, points: [[x, y, e.pressure || 0.5]] }
    predicted.current = []; scheduleLive()
  }
  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === 'pan' || e.pointerType === 'touch') return
    if (tool === 'eraser') { if (e.buttons) { const [x, y] = logicalFrom(liveRef.current!, e); onErase(x, y) } return }
    const cur = drawing.current; if (!cur) return
    const native = e.nativeEvent as PointerEvent
    const evs = native.getCoalescedEvents?.() ?? [native]
    for (const ev of evs) { const [x, y] = logicalFrom(liveRef.current!, ev); cur.points.push([x, y, ev.pressure || 0.5]) }
    const pred = (native as PointerEvent & { getPredictedEvents?: () => PointerEvent[] }).getPredictedEvents?.() ?? []
    predicted.current = pred.map(ev => { const [x, y] = logicalFrom(liveRef.current!, ev); return [x, y, ev.pressure || 0.5] })
    scheduleLive()
  }
  function onUp() { if (tool === 'eraser' || tool === 'pan') return; commit() }

  const liveStyle = tool === 'pan' ? { touchAction: 'auto' as const, cursor: 'grab' as const } : undefined
  return (
    <div className="hw-canvas-stack">
      <canvas ref={committedRef} className="hw-canvas hw-canvas-committed" />
      <canvas ref={liveRef} className="hw-canvas hw-canvas-live" style={liveStyle}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
    </div>
  )
}

// ── Immediate (2 canvases + perfect-freehand, NO rAF, NO predicted) ──────────
function ImmediatePad({ page, pageKey, tool, color, size, onCommit, onErase }: PadProps) {
  const committedRef = useRef<HTMLCanvasElement>(null)
  const liveRef      = useRef<HTMLCanvasElement>(null)
  const drawing      = useRef<HwStroke | null>(null)

  function paintCommitted() {
    const c = committedRef.current; if (!c) return
    const ctx = ensureSize(c); ctx.clearRect(0, 0, PAGE_W, PAGE_H)
    for (const s of page.strokes) paintStrokeFreehand(ctx, s)
  }
  function paintLive() {
    const c = liveRef.current; if (!c) return
    const ctx = ensureSize(c); ctx.clearRect(0, 0, PAGE_W, PAGE_H)
    if (drawing.current?.points.length) paintStrokeFreehand(ctx, drawing.current)
  }
  useEffect(() => { paintCommitted(); paintLive() /* eslint-disable-next-line */ }, [page, pageKey])
  useEffect(() => {
    const ro = new ResizeObserver(() => { paintCommitted(); paintLive() })
    if (liveRef.current) ro.observe(liveRef.current)
    return () => ro.disconnect()
  }, []) // eslint-disable-line

  function commit() {
    const cur = drawing.current; drawing.current = null
    if (!cur || !cur.points.length) return
    const ctx = committedRef.current?.getContext('2d')
    if (ctx) paintStrokeFreehand(ctx, cur)
    const live = liveRef.current?.getContext('2d')
    if (live) live.clearRect(0, 0, PAGE_W, PAGE_H)
    onCommit(cur)
  }
  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === 'pan' || e.pointerType === 'touch') return
    e.preventDefault(); commit()
    liveRef.current!.setPointerCapture(e.pointerId)
    const [x, y] = logicalFrom(liveRef.current!, e)
    if (tool === 'eraser') { onErase(x, y); return }
    drawing.current = { tool: 'pen', color, size, points: [[x, y, e.pressure || 0.5]] }
    paintLive()
  }
  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === 'pan' || e.pointerType === 'touch') return
    if (tool === 'eraser') { if (e.buttons) { const [x, y] = logicalFrom(liveRef.current!, e); onErase(x, y) } return }
    const cur = drawing.current; if (!cur) return
    const native = e.nativeEvent as PointerEvent
    const evs = native.getCoalescedEvents?.() ?? [native]
    for (const ev of evs) { const [x, y] = logicalFrom(liveRef.current!, ev); cur.points.push([x, y, ev.pressure || 0.5]) }
    paintLive()    // synchronous; no rAF
  }
  function onUp() { if (tool === 'eraser' || tool === 'pan') return; commit() }

  const liveStyle = tool === 'pan' ? { touchAction: 'auto' as const, cursor: 'grab' as const } : undefined
  return (
    <div className="hw-canvas-stack">
      <canvas ref={committedRef} className="hw-canvas hw-canvas-committed" />
      <canvas ref={liveRef} className="hw-canvas hw-canvas-live" style={liveStyle}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
    </div>
  )
}

// ── Direct (single canvas, segment lines, no rAF, no perfect-freehand) ───────
function DirectPad({ page, pageKey, tool, color, size, onCommit, onErase }: PadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing   = useRef<HwStroke | null>(null)

  function paintAll() {
    const c = canvasRef.current; if (!c) return
    const ctx = ensureSize(c); ctx.clearRect(0, 0, PAGE_W, PAGE_H)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    for (const s of page.strokes) drawSegments(ctx, s)
    if (drawing.current) drawSegments(ctx, drawing.current)
  }
  function drawSegments(ctx: CanvasRenderingContext2D, s: HwStroke) {
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color
    const pts = s.points
    if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], s.size / 2, 0, Math.PI * 2); ctx.fill(); return }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]
      ctx.lineWidth = s.size * (0.4 + 0.6 * (((a[2] ?? 0.5) + (b[2] ?? 0.5)) / 2))
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
    }
  }
  function drawTail(ctx: CanvasRenderingContext2D, s: HwStroke, fromIdx: number) {
    ctx.strokeStyle = s.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    for (let i = Math.max(1, fromIdx); i < s.points.length; i++) {
      const a = s.points[i - 1], b = s.points[i]
      ctx.lineWidth = s.size * (0.4 + 0.6 * (((a[2] ?? 0.5) + (b[2] ?? 0.5)) / 2))
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
    }
  }
  useEffect(() => { paintAll() /* eslint-disable-next-line */ }, [page, pageKey])
  useEffect(() => {
    const ro = new ResizeObserver(() => paintAll())
    if (canvasRef.current) ro.observe(canvasRef.current)
    return () => ro.disconnect()
  }, []) // eslint-disable-line

  function commit() {
    const cur = drawing.current; drawing.current = null
    if (!cur || !cur.points.length) return
    onCommit(cur)
  }
  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === 'pan' || e.pointerType === 'touch') return
    e.preventDefault(); commit()
    canvasRef.current!.setPointerCapture(e.pointerId)
    const [x, y] = logicalFrom(canvasRef.current!, e)
    if (tool === 'eraser') { onErase(x, y); return }
    drawing.current = { tool: 'pen', color, size, points: [[x, y, e.pressure || 0.5]] }
    const ctx = canvasRef.current!.getContext('2d')!; ctx.fillStyle = color
    ctx.beginPath(); ctx.arc(x, y, size / 2, 0, Math.PI * 2); ctx.fill()
  }
  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === 'pan' || e.pointerType === 'touch') return
    if (tool === 'eraser') { if (e.buttons) { const [x, y] = logicalFrom(canvasRef.current!, e); onErase(x, y) } return }
    const cur = drawing.current; if (!cur) return
    const ctx = canvasRef.current!.getContext('2d')!
    const startIdx = cur.points.length
    const native = e.nativeEvent as PointerEvent
    const evs = native.getCoalescedEvents?.() ?? [native]
    for (const ev of evs) { const [x, y] = logicalFrom(canvasRef.current!, ev); cur.points.push([x, y, ev.pressure || 0.5]) }
    drawTail(ctx, cur, startIdx)   // immediate incremental
  }
  function onUp() { if (tool === 'eraser' || tool === 'pan') return; commit() }

  const style = tool === 'pan' ? { touchAction: 'auto' as const, cursor: 'grab' as const } : undefined
  return (
    <div className="hw-canvas-stack">
      <canvas ref={canvasRef} className="hw-canvas hw-canvas-live" style={style}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
    </div>
  )
}

// ── SVG (browser composites; one <path> per stroke) ──────────────────────────
function SvgPad({ page, pageKey, tool, color, size, onCommit, onErase }: PadProps) {
  const svgRef    = useRef<SVGSVGElement>(null)
  const activeRef = useRef<SVGPathElement | null>(null)
  const drawing   = useRef<HwStroke | null>(null)

  function updateActive() {
    if (!activeRef.current || !drawing.current) return
    activeRef.current.setAttribute('d', strokeToSvgD(drawing.current))
    activeRef.current.setAttribute('fill', drawing.current.color)
  }
  // No imperative redraw needed for committed; SVG renders from JSX below.

  function commit() {
    const cur = drawing.current; drawing.current = null
    if (activeRef.current) { activeRef.current.remove(); activeRef.current = null }
    if (!cur || !cur.points.length) return
    onCommit(cur)
  }
  function onDown(e: React.PointerEvent<SVGSVGElement>) {
    if (tool === 'pan' || e.pointerType === 'touch') return
    e.preventDefault(); commit()
    svgRef.current!.setPointerCapture(e.pointerId)
    const [x, y] = logicalFrom(svgRef.current!, e)
    if (tool === 'eraser') { onErase(x, y); return }
    drawing.current = { tool: 'pen', color, size, points: [[x, y, e.pressure || 0.5]] }
    const ns = 'http://www.w3.org/2000/svg'
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('fill', color)
    svgRef.current!.appendChild(path)
    activeRef.current = path
    updateActive()
  }
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (tool === 'pan' || e.pointerType === 'touch') return
    if (tool === 'eraser') { if (e.buttons) { const [x, y] = logicalFrom(svgRef.current!, e); onErase(x, y) } return }
    const cur = drawing.current; if (!cur) return
    const native = e.nativeEvent as PointerEvent
    const evs = native.getCoalescedEvents?.() ?? [native]
    for (const ev of evs) { const [x, y] = logicalFrom(svgRef.current!, ev); cur.points.push([x, y, ev.pressure || 0.5]) }
    updateActive()
  }
  function onUp() { if (tool === 'eraser' || tool === 'pan') return; commit() }

  const style = tool === 'pan' ? { touchAction: 'auto' as const, cursor: 'grab' as const } : undefined
  return (
    <div className="hw-canvas-stack">
      <svg ref={svgRef} className="hw-canvas hw-canvas-live" viewBox={`0 0 ${PAGE_W} ${PAGE_H}`} preserveAspectRatio="xMidYMid meet"
        style={style} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {page.strokes.map((s, i) => <path key={`${pageKey}-${i}`} d={strokeToSvgD(s)} fill={s.color} />)}
      </svg>
    </div>
  )
}

// ── React (JSX-only SVG + rAF state) ─────────────────────────────────────────
// The simplest, most reliable mode. EVERY stroke — committed and in-progress —
// is a React-rendered <path>. No imperative appendChild, no canvas resize that
// can wipe pixels, no transform-state to go stale. The active stroke lives in
// a ref (so pointermove can push points cheaply) and is mirrored to React
// state via rAF so the SVG re-renders at most once per frame. On pointerup
// we hand the stroke to onCommit; React reconciliation adds one new <path>
// with a stable key (we don't churn keys for already-committed strokes).
function ReactPad({ page, pageKey, tool, color, size, onCommit, onErase }: PadProps) {
  const [active, setActive] = useState<HwStroke | null>(null)
  const activeRef           = useRef<HwStroke | null>(null)
  const rafRef              = useRef<number | null>(null)
  const svgRef              = useRef<SVGSVGElement>(null)

  function endRaf() { if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }
  function pushActive() {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const a = activeRef.current
      // Clone so React sees a new reference and re-renders the active path.
      setActive(a ? { ...a, points: a.points.slice() } : null)
    })
  }

  function onDown(e: React.PointerEvent<SVGSVGElement>) {
    if (tool === 'pan' || e.pointerType === 'touch') return
    e.preventDefault()
    // If iPad dropped the previous stroke's pointerup, salvage it before we
    // start the next one. Without this, fast successive strokes can lose one.
    if (activeRef.current && activeRef.current.points.length) onCommit(activeRef.current)
    activeRef.current = null; endRaf()
    try { svgRef.current?.setPointerCapture(e.pointerId) } catch {}
    const [x, y] = logicalFrom(svgRef.current!, e)
    if (tool === 'eraser') { onErase(x, y); return }
    activeRef.current = { tool: 'pen', color, size, points: [[x, y, e.pressure || 0.5]] }
    setActive({ ...activeRef.current, points: activeRef.current.points.slice() })
  }
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (tool === 'pan' || e.pointerType === 'touch') return
    if (tool === 'eraser') {
      if (e.buttons) { const [x, y] = logicalFrom(svgRef.current!, e); onErase(x, y) }
      return
    }
    if (!activeRef.current) return
    const native = e.nativeEvent as PointerEvent
    const evs = native.getCoalescedEvents?.() ?? [native]
    for (const ev of evs) {
      const [x, y] = logicalFrom(svgRef.current!, ev)
      activeRef.current.points.push([x, y, ev.pressure || 0.5])
    }
    pushActive()
  }
  function onUp() {
    if (tool === 'eraser' || tool === 'pan') return
    const s = activeRef.current
    activeRef.current = null; endRaf(); setActive(null)
    if (s && s.points.length) onCommit(s)
  }

  const style = tool === 'pan' ? { touchAction: 'auto' as const, cursor: 'grab' as const } : undefined
  return (
    <div className="hw-canvas-stack">
      <svg
        ref={svgRef}
        className="hw-canvas hw-canvas-live"
        viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}
        preserveAspectRatio="xMidYMid meet"
        style={style}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      >
        {/* Committed strokes — keys are STABLE across commits, so React keeps
            each <path> in place and only appends one new node per commit. */}
        {page.strokes.map((s, i) => (
          <path key={`${pageKey}-c-${i}`} d={strokeToSvgD(s)} fill={s.color} />
        ))}
        {active && active.points.length > 0 && (
          <path key={`${pageKey}-a`} d={strokeToSvgD(active)} fill={active.color} />
        )}
      </svg>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Outer pad — shared toolbar, state, mode selector
// ───────────────────────────────────────────────────────────────────────────
const HandwritingPad = forwardRef<HandwritingPadHandle, { initialDoc?: HwDoc }>(
  function HandwritingPad({ initialDoc }, ref) {
    const [pages, setPages] = useState<HwPage[]>(
      initialDoc?.pages?.length ? initialDoc.pages.map(p => ({ strokes: p.strokes ?? [] })) : [{ strokes: [] }],
    )
    const [pageIdx, setPageIdx] = useState(0)
    const [tool, setTool]   = useState<'pen' | 'eraser' | 'pan'>('pen')
    const [color, setColor] = useState(COLORS[0])
    const [size, setSize]   = useState(SIZES[1])
    const [mode, setModeState] = useState<DrawMode>(() => (typeof localStorage !== 'undefined'
      && (localStorage.getItem(MODE_STORAGE) as DrawMode | null)) || 'react')
    function setMode(m: DrawMode) { setModeState(m); try { localStorage.setItem(MODE_STORAGE, m) } catch {} }

    const pagesRef = useRef(pages);   pagesRef.current = pages
    const idxRef   = useRef(pageIdx); idxRef.current = pageIdx

    useImperativeHandle(ref, () => ({
      getDoc: () => ({ pages: pagesRef.current }),
      exportPagePngs: async () => {
        const out: Blob[] = []
        for (const page of pagesRef.current) {
          const c = document.createElement('canvas')
          c.width = PAGE_W; c.height = PAGE_H
          const ctx = c.getContext('2d')!
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, PAGE_W, PAGE_H)
          for (const s of page.strokes) paintStrokeFreehand(ctx, s)
          const blob = await new Promise<Blob | null>(res => c.toBlob(res, 'image/png'))
          if (blob) out.push(blob)
        }
        return out
      },
    }), [])

    function onCommit(stroke: HwStroke) {
      setPages(prev => prev.map((p, i) => i === idxRef.current ? { strokes: [...p.strokes, stroke] } : p))
    }
    function onErase(x: number, y: number) {
      setPages(prev => prev.map((p, i) => {
        if (i !== idxRef.current) return p
        const kept = p.strokes.filter(s => !s.points.some(pt => dist2(pt[0], pt[1], x, y) <= ERASE_R * ERASE_R))
        return kept.length === p.strokes.length ? p : { strokes: kept }
      }))
    }
    function undo() {
      setPages(prev => prev.map((p, i) => i === idxRef.current && p.strokes.length ? { strokes: p.strokes.slice(0, -1) } : p))
    }
    function clearPage() {
      setPages(prev => prev.map((p, i) => i === idxRef.current ? { strokes: [] } : p))
    }
    function addPage() { setPages(prev => [...prev, { strokes: [] }]); setPageIdx(pages.length) }
    function deletePage() {
      if (pages.length <= 1) { clearPage(); return }
      const i = pageIdx
      setPages(prev => prev.filter((_, k) => k !== i))
      setPageIdx(Math.max(0, i - 1))
    }

    const page    = pages[pageIdx] ?? { strokes: [] }
    // pageKey identifies the page (and mode) but is STABLE across commits, so
    // React keeps already-mounted stroke elements in place instead of churning
    // every <path>/canvas key on every commit (which on iPad was causing the
    // "every other stroke goes blank" bug).
    const pageKey = `${mode}-${pageIdx}`

    const padProps: PadProps = { page, pageKey, tool, color, size, onCommit, onErase }

    return (
      <div className="hw-wrap">
        <div className="hw-toolbar">
          <button className={`hw-tool${tool === 'pen' ? ' active' : ''}`} onClick={() => setTool('pen')} title="Pen">✒️</button>
          <button className={`hw-tool${tool === 'eraser' ? ' active' : ''}`} onClick={() => setTool('eraser')} title="Eraser">🩹</button>
          <button className={`hw-tool${tool === 'pan' ? ' active' : ''}`} onClick={() => setTool('pan')} title="Pan / scroll (no drawing)">🖐</button>
          <span className="hw-sep" />
          {COLORS.map(c => (
            <button key={c} className={`hw-swatch${color === c && tool === 'pen' ? ' active' : ''}`}
              style={{ background: c }} onClick={() => { setColor(c); setTool('pen') }} title={c} />
          ))}
          <span className="hw-sep" />
          {SIZES.map(s => (
            <button key={s} className={`hw-size${size === s ? ' active' : ''}`} onClick={() => setSize(s)} title={`${s}px`}>
              <span style={{ width: s + 2, height: s + 2 }} />
            </button>
          ))}
          <span className="hw-sep" />
          <button className="hw-tool" onClick={undo} title="Undo last stroke">↶</button>
          <button className="hw-tool" onClick={clearPage} title="Clear page">✕</button>
          <span className="hw-sep" />
          <button className="hw-tool" onClick={() => setPageIdx(i => Math.max(0, i - 1))} disabled={pageIdx === 0} title="Previous page">◀</button>
          <span className="hw-pageno">{pageIdx + 1}/{pages.length}</span>
          <button className="hw-tool" onClick={() => setPageIdx(i => Math.min(pages.length - 1, i + 1))} disabled={pageIdx >= pages.length - 1} title="Next page">▶</button>
          <button className="hw-tool" onClick={addPage} title="Add page">＋</button>
          <button className="hw-tool" onClick={deletePage} title="Delete page">🗑</button>
          <span className="hw-sep" />
          {/* Stroke counter — lets you verify on iPad that commits are
              actually landing in state even when the paint is missing. */}
          <span className="hw-pageno" title="Strokes committed on this page">{page.strokes.length} strokes</span>
          <span className="hw-sep" />
          <label className="hw-mode-lbl" title="Drawing engine — try each on iPad and pick what feels best">
            mode:
            <select className="hw-mode-select" value={mode} onChange={e => setMode(e.target.value as DrawMode)}>
              <option value="react">React (JSX-only SVG — recommended)</option>
              <option value="smooth">Smooth (perfect-freehand + rAF + predicted)</option>
              <option value="immediate">Immediate (perfect-freehand, no rAF)</option>
              <option value="direct">Direct (lines, no rAF, no freehand)</option>
              <option value="svg">SVG (browser composites)</option>
            </select>
          </label>
        </div>
        <div className="hw-canvas-wrap">
          {mode === 'react'     && <ReactPad     key={mode} {...padProps} />}
          {mode === 'smooth'    && <SmoothPad    key={mode} {...padProps} />}
          {mode === 'immediate' && <ImmediatePad key={mode} {...padProps} />}
          {mode === 'direct'    && <DirectPad    key={mode} {...padProps} />}
          {mode === 'svg'       && <SvgPad       key={mode} {...padProps} />}
        </div>
      </div>
    )
  },
)

export default HandwritingPad
