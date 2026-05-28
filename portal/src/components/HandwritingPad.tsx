import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

// ── GoodNotes-style handwriting pad ──────────────────────────────────────────
// Apple Pencil (Pointer Events: pointerType 'pen' + pressure), palm rejection
// (ignore 'touch'), multi-page, pen/eraser/colours, undo. Strokes are stored as
// vectors in a fixed logical page space so they re-edit and export crisply.

export interface HwStroke { tool: 'pen'; color: string; size: number; points: number[][] } // points: [x, y, pressure]
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
const ERASE_R = 18   // logical-px radius for stroke erase

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy
}

// Render one page's strokes onto a 2D context already transformed to logical coords.
function paintPage(ctx: CanvasRenderingContext2D, page: HwPage) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const s of page.strokes) {
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color
    const pts = s.points
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], s.size / 2, 0, Math.PI * 2); ctx.fill(); continue
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]
      ctx.lineWidth = s.size * (0.4 + 0.6 * (((a[2] ?? 0.5) + (b[2] ?? 0.5)) / 2))
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
    }
  }
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

    const canvasRef  = useRef<HTMLCanvasElement>(null)
    const wrapRef    = useRef<HTMLDivElement>(null)
    const drawing    = useRef<HwStroke | null>(null)
    const pagesRef   = useRef(pages);   pagesRef.current = pages
    const idxRef     = useRef(pageIdx); idxRef.current = pageIdx

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

    // Size the backing store to the displayed size (× dpr) and map drawing to
    // the fixed logical page space, then repaint the current page.
    function redraw() {
      const canvas = canvasRef.current; if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(canvas.width / PAGE_W, 0, 0, canvas.height / PAGE_H, 0, 0)
      ctx.clearRect(0, 0, PAGE_W, PAGE_H)
      paintPage(ctx, pagesRef.current[idxRef.current] ?? { strokes: [] })
      // Also paint the in-progress stroke. Without this, a fast next stroke
      // started before the previous commit's redraw runs would have its
      // already-drawn segments wiped — looking like the stroke "didn't take".
      if (drawing.current && drawing.current.points.length) {
        paintPage(ctx, { strokes: [drawing.current] })
      }
    }

    useEffect(() => { redraw() }, [pages, pageIdx])
    useEffect(() => {
      const ro = new ResizeObserver(() => redraw())
      if (wrapRef.current) ro.observe(wrapRef.current)
      return () => ro.disconnect()
    }, [])

    function toLogical(e: { clientX: number; clientY: number }): [number, number] {
      const r = canvasRef.current!.getBoundingClientRect()
      return [(e.clientX - r.left) / r.width * PAGE_W, (e.clientY - r.top) / r.height * PAGE_H]
    }

    function eraseAt(x: number, y: number) {
      setPages(prev => prev.map((p, i) => {
        if (i !== idxRef.current) return p
        const kept = p.strokes.filter(s => !s.points.some(pt => dist2(pt[0], pt[1], x, y) <= ERASE_R * ERASE_R))
        return kept.length === p.strokes.length ? p : { strokes: kept }
      }))
    }

    // Commit the in-progress stroke (if any) into the current page. Shared by
    // onUp and onDown — on iPad, very fast Pencil writing can drop a stroke's
    // pointerup entirely, so the next pointerdown has to flush the pending
    // stroke before starting a new one, otherwise it'd be silently overwritten.
    function commitCurrent() {
      const cur = drawing.current
      drawing.current = null
      if (!cur || !cur.points.length) return
      setPages(prev => prev.map((p, i) => i === idxRef.current ? { strokes: [...p.strokes, cur] } : p))
    }

    function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
      if (tool === 'pan') return                       // pan mode → let the wrap scroll
      if (e.pointerType === 'touch') return            // palm / finger rejection
      e.preventDefault()
      commitCurrent()                                   // flush any stroke whose pointerup was missed
      canvasRef.current!.setPointerCapture(e.pointerId)
      const [x, y] = toLogical(e)
      if (tool === 'eraser') { eraseAt(x, y); return }
      drawing.current = { tool: 'pen', color, size, points: [[x, y, e.pressure || 0.5]] }
    }

    function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
      if (tool === 'pan') return
      if (e.pointerType === 'touch') return
      if (tool === 'eraser') { if (e.buttons) { const [x, y] = toLogical(e); eraseAt(x, y) } return }
      const cur = drawing.current; if (!cur) return
      const evs = (e.nativeEvent.getCoalescedEvents?.() as PointerEvent[] | undefined) ?? [e.nativeEvent as PointerEvent]
      const ctx = canvasRef.current!.getContext('2d')!
      ctx.strokeStyle = cur.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      for (const ev of evs) {
        const [x, y] = toLogical(ev)
        const prev = cur.points[cur.points.length - 1]
        cur.points.push([x, y, ev.pressure || 0.5])
        // incremental segment (avoids a full repaint per move)
        ctx.lineWidth = cur.size * (0.4 + 0.6 * (((prev[2] ?? 0.5) + (ev.pressure || 0.5)) / 2))
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(x, y); ctx.stroke()
      }
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
      setPages(prev => { const next = [...prev, { strokes: [] }]; return next }); setPageIdx(pages.length)
    }
    function deletePage() {
      if (pages.length <= 1) { clearPage(); return }
      const i = pageIdx
      setPages(prev => prev.filter((_, k) => k !== i))
      setPageIdx(Math.max(0, i - 1))
    }

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
          <canvas
            ref={canvasRef}
            className="hw-canvas"
            style={tool === 'pan' ? { touchAction: 'auto', cursor: 'grab' } : undefined}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onPointerLeave={onUp}
          />
        </div>
      </div>
    )
  },
)

export default HandwritingPad
