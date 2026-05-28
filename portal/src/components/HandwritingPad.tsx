import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { getStroke } from 'perfect-freehand'

// ── GoodNotes-style handwriting pad v2 ───────────────────────────────────────
// Best-practice web handwriting (the tldraw / Excalidraw approach):
//   • perfect-freehand   pressure-sensitive, tapered, real-pen-feel strokes
//   • two layered canvases  committed strokes (static) + live stroke (cleared
//                            per frame); the live one is never wiped by a
//                            committed redraw, so fast successive strokes
//                            never disappear
//   • rAF-batched live render  pointer events queue raw points; one render
//                              per frame keeps writing smooth even at 120 Hz
//   • getCoalescedEvents + getPredictedEvents  high-rate Pencil sampling +
//                                              lower perceived latency
//   • palm rejection  ignore pointerType==='touch' for drawing
//   • Pan tool  flips touch-action to auto so a finger scrolls; Pencil still
//               draws when on Pen/Eraser (touch-action:none)

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
const ERASE_R = 18   // logical-px stroke-erase radius

// perfect-freehand options tuned for a fountain-pen feel.
function pfOptions(size: number) {
  return {
    size,
    thinning: 0.55,
    smoothing: 0.55,
    streamline: 0.45,
    easing: (t: number) => t,
    simulatePressure: false,   // we have real Pencil pressure
    last: true,
  }
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy
}

// Build a Path2D from a perfect-freehand outline polygon.
function strokePath(outline: number[][]): Path2D {
  const p = new Path2D()
  if (!outline.length) return p
  p.moveTo(outline[0][0], outline[0][1])
  for (let i = 1; i < outline.length; i++) p.lineTo(outline[i][0], outline[i][1])
  p.closePath()
  return p
}

function paintStroke(ctx: CanvasRenderingContext2D, s: HwStroke) {
  if (!s.points.length) return
  const outline = getStroke(s.points, pfOptions(s.size)) as number[][]
  if (!outline.length) return
  ctx.fillStyle = s.color
  ctx.fill(strokePath(outline))
}

function paintPage(ctx: CanvasRenderingContext2D, page: HwPage) {
  for (const s of page.strokes) paintStroke(ctx, s)
}

const HandwritingPad = forwardRef<HandwritingPadHandle, { initialDoc?: HwDoc }>(
  function HandwritingPad({ initialDoc }, ref) {
    const [pages, setPages] = useState<HwPage[]>(
      initialDoc?.pages?.length ? initialDoc.pages.map(p => ({ strokes: p.strokes ?? [] })) : [{ strokes: [] }],
    )
    const [pageIdx, setPageIdx] = useState(0)
    const [tool, setTool]   = useState<'pen' | 'eraser' | 'pan'>('pen')
    const [color, setColor] = useState(COLORS[0])
    const [size, setSize]   = useState(SIZES[1])

    // Two stacked canvases: committed (static) + live (per-frame).
    // Living strokes are NEVER wiped by a committed-strokes redraw.
    const committedRef = useRef<HTMLCanvasElement>(null)
    const liveRef      = useRef<HTMLCanvasElement>(null)
    const wrapRef      = useRef<HTMLDivElement>(null)

    const drawing  = useRef<HwStroke | null>(null)
    const predicted = useRef<number[][]>([])    // perfect-freehand likes a tail of predicted pts
    const rafId    = useRef<number | null>(null)
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
          paintPage(ctx, page)
          const blob = await new Promise<Blob | null>(res => c.toBlob(res, 'image/png'))
          if (blob) out.push(blob)
        }
        return out
      },
    }), [])

    // Map a CSS-pixel pointer position to the fixed logical page space.
    function toLogical(e: { clientX: number; clientY: number }): [number, number] {
      const r = liveRef.current!.getBoundingClientRect()
      return [(e.clientX - r.left) / r.width * PAGE_W, (e.clientY - r.top) / r.height * PAGE_H]
    }

    // Resize both canvases' backing store to displayed size × dpr and set the
    // logical→backing transform on each. Then repaint committed (no live yet).
    function ensureCanvasSize(canvas: HTMLCanvasElement) {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(canvas.width / PAGE_W, 0, 0, canvas.height / PAGE_H, 0, 0)
      return ctx
    }

    function paintCommitted() {
      const c = committedRef.current; if (!c) return
      const ctx = ensureCanvasSize(c)
      ctx.clearRect(0, 0, PAGE_W, PAGE_H)
      paintPage(ctx, pagesRef.current[idxRef.current] ?? { strokes: [] })
    }
    function paintLive() {
      const c = liveRef.current; if (!c) return
      const ctx = ensureCanvasSize(c)
      ctx.clearRect(0, 0, PAGE_W, PAGE_H)
      if (drawing.current && drawing.current.points.length) {
        // Mix in the predicted tail for lower perceived latency; the next real
        // move overwrites it on the next frame.
        const s = drawing.current
        const stroke: HwStroke = predicted.current.length
          ? { ...s, points: [...s.points, ...predicted.current] }
          : s
        paintStroke(ctx, stroke)
      }
    }

    // Schedule one live paint per animation frame (drops bursts).
    function scheduleLive() {
      if (rafId.current != null) return
      rafId.current = requestAnimationFrame(() => { rafId.current = null; paintLive() })
    }

    useEffect(() => { paintCommitted(); paintLive() }, [pages, pageIdx])
    useEffect(() => {
      const ro = new ResizeObserver(() => { paintCommitted(); paintLive() })
      if (wrapRef.current) ro.observe(wrapRef.current)
      return () => ro.disconnect()
    }, [])

    // Commit the in-progress stroke into pages. Shared by onUp and onDown — on
    // iPad a stroke's pointerup can be dropped during fast writing; flushing
    // in onDown rescues that stroke before starting the next.
    function commitCurrent() {
      const cur = drawing.current
      drawing.current = null
      predicted.current = []
      if (!cur || !cur.points.length) return
      // Stamp onto the committed canvas immediately so the user sees it land
      // before React re-renders (no flicker, even if state update is delayed).
      const ctx = committedRef.current?.getContext('2d')
      if (ctx) paintStroke(ctx, cur)
      // Clear the live layer.
      const live = liveRef.current?.getContext('2d')
      if (live) live.clearRect(0, 0, PAGE_W, PAGE_H)
      // Persist for save / undo / re-edit.
      setPages(prev => prev.map((p, i) => i === idxRef.current ? { strokes: [...p.strokes, cur] } : p))
    }

    function eraseAt(x: number, y: number) {
      setPages(prev => prev.map((p, i) => {
        if (i !== idxRef.current) return p
        const kept = p.strokes.filter(s => !s.points.some(pt => dist2(pt[0], pt[1], x, y) <= ERASE_R * ERASE_R))
        return kept.length === p.strokes.length ? p : { strokes: kept }
      }))
    }

    function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
      if (tool === 'pan') return                                  // pan → wrap scrolls
      if (e.pointerType === 'touch') return                       // palm / finger rejection
      e.preventDefault()
      commitCurrent()                                              // flush any dropped-pointerup stroke
      liveRef.current!.setPointerCapture(e.pointerId)
      const [x, y] = toLogical(e)
      if (tool === 'eraser') { eraseAt(x, y); return }
      drawing.current = { tool: 'pen', color, size, points: [[x, y, e.pressure || 0.5]] }
      predicted.current = []
      scheduleLive()
    }

    function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
      if (tool === 'pan' || e.pointerType === 'touch') return
      if (tool === 'eraser') { if (e.buttons) { const [x, y] = toLogical(e); eraseAt(x, y) } return }
      const cur = drawing.current; if (!cur) return
      const native = e.nativeEvent as PointerEvent
      const evs = native.getCoalescedEvents?.() ?? [native]
      for (const ev of evs) {
        const [x, y] = toLogical(ev)
        cur.points.push([x, y, ev.pressure || 0.5])
      }
      const pred = (native as PointerEvent & { getPredictedEvents?: () => PointerEvent[] }).getPredictedEvents?.() ?? []
      predicted.current = pred.map(ev => { const [x, y] = toLogical(ev); return [x, y, ev.pressure || 0.5] })
      scheduleLive()
    }

    function onUp() {
      if (tool === 'eraser' || tool === 'pan') return
      commitCurrent()
    }

    function undo() {
      setPages(prev => prev.map((p, i) => i === idxRef.current && p.strokes.length ? { strokes: p.strokes.slice(0, -1) } : p))
    }
    function clearPage() {
      setPages(prev => prev.map((p, i) => i === idxRef.current ? { strokes: [] } : p))
    }
    function addPage() {
      setPages(prev => [...prev, { strokes: [] }]); setPageIdx(pages.length)
    }
    function deletePage() {
      if (pages.length <= 1) { clearPage(); return }
      const i = pageIdx
      setPages(prev => prev.filter((_, k) => k !== i))
      setPageIdx(Math.max(0, i - 1))
    }

    const liveStyle = tool === 'pan' ? { touchAction: 'auto' as const, cursor: 'grab' as const } : undefined

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
        </div>
        <div className="hw-canvas-wrap" ref={wrapRef}>
          <div className="hw-canvas-stack">
            <canvas ref={committedRef} className="hw-canvas hw-canvas-committed" />
            <canvas
              ref={liveRef}
              className="hw-canvas hw-canvas-live"
              style={liveStyle}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            />
          </div>
        </div>
      </div>
    )
  },
)

export default HandwritingPad
