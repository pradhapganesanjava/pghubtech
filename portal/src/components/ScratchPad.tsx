// Scratch Pad — a page you can open over whatever you were doing.
//
// Deliberately not a modal: no backdrop, no scroll lock, no focus trap. It
// docks to the bottom of the window and leaves the page behind it fully
// usable, because the whole point is to jot something down *about* what is on
// screen — a modal that blocked the thing you were reading would defeat it.
//
// The editor is the same four modes the problem notes use (Rich · HTML ·
// Preview · Draw) over the same body format, so a pad is rich-text plus an
// optional `.hw-doc` handwriting block and nothing here has to convert
// between shapes. Storage is one Drive file per pad — see adapters/scratchRepo.
import { useCallback, useEffect, useRef, useState } from 'react'
import RichEditor from './RichEditor'
import HandwritingPad, { hwDocToBlockHtml, parseHwDoc } from './HandwritingPad'
import type { HwDoc, HandwritingPadHandle } from './HandwritingPad'
import {
  listScratch, createScratch, loadScratch, saveScratch,
  renameScratch, deleteScratch, defaultScratchName,
} from '../adapters/scratchRepo'
import type { ScratchPad as Pad } from '../adapters/scratchRepo'

type Tab = 'rich' | 'html' | 'preview' | 'draw'

/** Share of the window a pad takes when opened, and what ▾ restores to. */
const DEFAULT_FRACTION = 0.65

/** Everything except the handwriting block — the rich-text half of a body. */
function textOf(body: string): string {
  const d = new DOMParser().parseFromString(`<!doctype html><body>${body}</body>`, 'text/html')
  d.querySelectorAll('.hw-doc, img.hw-page').forEach(n => n.remove())
  return d.body.innerHTML.trim()
}

interface Props {
  open:    boolean
  onClose: () => void
}

export default function ScratchPadPanel({ open, onClose }: Props) {
  const [pads, setPads]       = useState<Pad[]>([])
  const [padId, setPadId]     = useState<string | null>(null)
  const [name, setName]       = useState('')
  // A blank pad opens in Draw: this is a scratch pad, and the usual reason to
  // open one mid-thought is to sketch. Typing is one click away; an existing
  // pad still opens in whichever mode its content implies (see openPad).
  const [tab, setTab]         = useState<Tab>('draw')
  const [html, setHtml]       = useState('')
  const [hwDoc, setHwDoc]     = useState<HwDoc | null>(null)
  const [dirty, setDirty]     = useState(false)
  const [busy, setBusy]       = useState<string | null>(null)
  const [err, setErr]         = useState<string | null>(null)
  // Height in px, dragged or toggled. Kept in px rather than vh so the drag
  // maps 1:1 to the pointer; clamped on every write so a resized window can
  // never leave the pad taller than the viewport.
  // 65% of the window by default — enough to draw or write in without the pad
  // feeling like a status bar. Key is versioned (…_h2) so the new default
  // actually reaches anyone who had already dragged the old 42% one.
  const [height, setHeight]   = useState(() => {
    const saved = Number(localStorage.getItem('pghtech_scratch_h2'))
    return saved > 0 ? saved : Math.round(window.innerHeight * DEFAULT_FRACTION)
  })
  const dragging = useRef(false)
  const padRef = useRef<HandwritingPadHandle>(null)

  const current = pads.find(p => p.id === padId) ?? null

  // ── loading ───────────────────────────────────────────────────────────────
  const openPad = useCallback(async (id: string) => {
    setBusy('Loading…'); setErr(null)
    try {
      const body = await loadScratch(id)
      setPadId(id)
      setHtml(textOf(body))
      setHwDoc(parseHwDoc(body))
      setTab(parseHwDoc(body) && !textOf(body) ? 'draw' : 'rich')
      setDirty(false)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }, [])

  // Opening always starts a FRESH pad. A scratch pad is for the thought you
  // are having now, not the one you had yesterday — and every earlier pad is
  // one click away in the picker, so nothing is lost by not reopening it.
  //
  // The cost of that is an empty Drive file per idle open, so an auto-created
  // pad that was never written in is deleted again on close (see below).
  const autoCreated = useRef<string | null>(null)
  useEffect(() => {
    if (!open || padId) return
    let cancelled = false
    ;(async () => {
      setBusy('Loading…'); setErr(null)
      try {
        const list = await listScratch()
        const fresh = await createScratch()
        if (cancelled) return
        autoCreated.current = fresh.id
        setPads([fresh, ...list])
        setName(fresh.name)
        setPadId(fresh.id)
        setHtml(''); setHwDoc(null); setTab('draw'); setDirty(false)
      } catch (e) { if (!cancelled) setErr((e as Error).message) }
      finally { if (!cancelled) setBusy(null) }
    })()
    return () => { cancelled = true }
  }, [open, padId])

  // Drop the auto-created pad if it is still blank. Called on close AND when
  // the user navigates away from it — switching to an older pad or pressing ＋
  // would otherwise strand an empty file in Drive, and the close-time check
  // would by then be inspecting a different pad's content.
  //
  // Only auto-created pads are swept: one you made with ＋ is yours to keep,
  // empty or not.
  function sweepAuto() {
    const id = autoCreated.current
    if (!id) return
    const blank = id === padId
      && !dirty && !html.trim() && !(hwDoc?.pages.some(p => p.strokes.length))
    autoCreated.current = null
    if (!blank) return
    setPads(prev => prev.filter(p => p.id !== id))
    deleteScratch(id).catch(() => { /* a stray empty pad is not worth a toast */ })
  }

  function switchPad(id: string) {
    if (id === padId) return
    sweepAuto()
    void openPad(id)
  }

  useEffect(() => {
    if (open) return
    sweepAuto()
    setPadId(null)
    setPads([])
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (current) setName(current.name) }, [current])

  // ── saving ────────────────────────────────────────────────────────────────
  async function save() {
    if (!padId) return
    setBusy('Saving…'); setErr(null)
    try {
      // Read the pad's live strokes rather than state: the component owns them
      // and only reports on demand.
      const doc = tab === 'draw' && padRef.current ? padRef.current.getDoc() : hwDoc
      const drawing = doc && doc.pages.some(p => p.strokes.length) ? hwDocToBlockHtml(doc) : ''
      await saveScratch(padId, [html, drawing].filter(Boolean).join('\n'))
      if (doc) setHwDoc(doc)
      setDirty(false)
      setPads(prev => prev.map(p => p.id === padId
        ? { ...p, modifiedTime: new Date().toISOString() } : p))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  async function addPad() {
    sweepAuto()               // do not strand the blank pad this open created
    setBusy('Creating…'); setErr(null)
    try {
      const p = await createScratch(defaultScratchName())
      setPads(prev => [p, ...prev])
      setName(p.name)
      setPadId(p.id); setHtml(''); setHwDoc(null); setTab('draw'); setDirty(false)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  async function removePad() {
    if (!padId || !current) return
    if (!confirm(`Delete “${current.name}”? This cannot be undone.`)) return
    setBusy('Deleting…'); setErr(null)
    try {
      await deleteScratch(padId)
      const rest = pads.filter(p => p.id !== padId)
      setPads(rest)
      if (rest.length) await openPad(rest[0].id)
      else { setPadId(null); setHtml(''); setHwDoc(null) }
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  async function commitName() {
    const next = name.trim()
    if (!padId || !current || !next || next === current.name) { setName(current?.name ?? ''); return }
    try {
      await renameScratch(padId, next)
      setPads(prev => prev.map(p => p.id === padId ? { ...p, name: next } : p))
    } catch (e) { setErr((e as Error).message); setName(current.name) }
  }

  // Esc closes, but not while a menu or a text field is mid-edit elsewhere.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const MIN_H = 180
  const maxH  = () => Math.max(MIN_H, window.innerHeight - 48)   // leave the top bar reachable
  const clamp = (h: number) => Math.min(maxH(), Math.max(MIN_H, h))
  const isMax = height >= maxH() - 2

  // Persist across opens — the size you chose is a preference, not a per-visit
  // accident.
  useEffect(() => {
    try { localStorage.setItem('pghtech_scratch_h2', String(Math.round(height))) } catch { /* private mode */ }
  }, [height])

  // Keep it legal when the window itself shrinks.
  useEffect(() => {
    function onResize() { setHeight(h => clamp(h)) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Drag the top edge. Pointer capture keeps the drag alive over the iframe or
  // any other element the cursor crosses.
  function gripDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = true
    document.body.classList.add('resizing-v')
  }
  function gripMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    setHeight(clamp(window.innerHeight - e.clientY))
  }
  function gripUp(e: React.PointerEvent<HTMLDivElement>) {
    dragging.current = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
    document.body.classList.remove('resizing-v')
  }

  if (!open) return null

  return (
    <section className="scratch-pad" style={{ height }} aria-label="Scratch Pad">
      {/* Drag handle on the top edge — the whole border is the target, not a
          few pixels of it. */}
      <div
        className="scratch-grip"
        onPointerDown={gripDown}
        onPointerMove={gripMove}
        onPointerUp={gripUp}
        onPointerCancel={gripUp}
        onDoubleClick={() => setHeight(h => (h >= maxH() - 2 ? Math.round(window.innerHeight * DEFAULT_FRACTION) : maxH()))}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize scratch pad"
        title="Drag to resize · double-click to maximise"
      />
      <header className="scratch-hd">
        <span className="scratch-hd-icon" aria-hidden="true">✎</span>
        <input
          className="scratch-name"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          title="Rename this scratch pad"
          aria-label="Scratch pad name"
        />
        <select
          className="scratch-picker"
          value={padId ?? ''}
          onChange={e => switchPad(e.target.value)}
          title="Switch scratch pad"
          aria-label="Switch scratch pad"
        >
          {pads.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <button className="scratch-btn" onClick={addPad} title="New scratch pad" aria-label="New scratch pad">＋</button>
        <button className="scratch-btn" onClick={removePad} title="Delete this scratch pad" aria-label="Delete this scratch pad" disabled={!padId}>🗑</button>

        {/* Modes sit in the header rather than owning a row: the pad is short
            by design and a third strip of chrome eats the writing area. */}
        <div className="scratch-tabs">
          {(['rich', 'html', 'preview', 'draw'] as const).map(m => (
            <button
              key={m}
              className={`adshub-diff-pill${tab === m ? ' active' : ''}`}
              onClick={() => setTab(m)}
              title={m === 'html' ? 'Raw HTML' : m === 'rich' ? 'Rich text' : m === 'preview' ? 'Preview' : 'Draw'}
            >
              {m === 'rich' ? 'Rich' : m === 'html' ? '</>' : m === 'preview' ? '👁' : '✏️'}
            </button>
          ))}
        </div>

        <span className="scratch-state">
          {err ? <span className="scratch-err" title={err}>⚠ {err}</span>
               : busy ? busy
               : dirty ? 'Unsaved' : 'Saved'}
        </span>

        <button className="scratch-btn scratch-save" onClick={save} disabled={!padId || !!busy}
          title="Save (⌘S)">Save</button>
        <button
          className="scratch-btn"
          onClick={() => setHeight(isMax ? Math.round(window.innerHeight * DEFAULT_FRACTION) : maxH())}
          title={isMax ? 'Restore' : 'Maximise'}
          aria-label={isMax ? 'Restore' : 'Maximise'}
        >{isMax ? '▾' : '▴'}</button>
        <button className="scratch-btn scratch-close" onClick={onClose} title="Close Scratch Pad" aria-label="Close Scratch Pad">✕</button>
      </header>

      <div className="scratch-body">
        {tab === 'rich' && (
          <RichEditor value={html} onChange={v => { setHtml(v); setDirty(true) }} allowHtmlEmbed />
        )}
        {tab === 'html' && (
          <textarea className="rf-textarea scratch-html" value={html} spellCheck={false}
            onChange={e => { setHtml(e.target.value); setDirty(true) }}
            placeholder="<p>Paste or write raw HTML…</p>" />
        )}
        {tab === 'preview' && (
          <div className="rf-preview" dangerouslySetInnerHTML={{ __html: html }} />
        )}
        {tab === 'draw' && (
          // Keyed on the pad so switching pads remounts with that pad's strokes
          // rather than carrying the previous one's over.
          <HandwritingPad key={padId ?? 'none'} ref={padRef} initialDoc={hwDoc ?? undefined} />
        )}
      </div>
    </section>
  )
}
