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
  cachedScratchList, putScratchList, cachedScratchBody, putScratchBody,
  dropScratchBody, lastScratchId, setLastScratchId,
} from '../adapters/scratchRepo'
import type { ScratchPad as Pad } from '../adapters/scratchRepo'

type Tab = 'rich' | 'html' | 'preview' | 'draw'

/** Where the pad docks. Bottom is the original — a strip under the page. */
type Dock = 'bottom' | 'left' | 'right'
const DOCK_KEY   = 'pghtech_scratch_dock'
const DOCK_ORDER: Dock[] = ['bottom', 'left', 'right']
const DOCK_META: Record<Dock, { icon: string; label: string }> = {
  bottom: { icon: '▭', label: 'Bottom' },
  left:   { icon: '◧', label: 'Left' },
  right:  { icon: '◨', label: 'Right' },
}

/** Share of the window a pad takes when opened, and what ▾ restores to. */
const DEFAULT_FRACTION = 0.65
/** Side docks are measured across, not down, so they get their own share. */
const DEFAULT_W_FRACTION = 0.42
/** Below this the window is too narrow to give a side dock a usable column, so
 *  the dock choice is ignored and the pad goes back to the bottom. */
const SIDE_DOCK_MIN_VW = 720

/** Quiet period after the last edit before a save goes out. Long enough that a
 *  sentence or a run of strokes is one request, short enough that closing the
 *  lid a moment later has still caught it. */
const AUTOSAVE_MS = 1600

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
  // Counts edits. `dirty` is a state ("there is something to save"); this is an
  // event stream, which is what a debounce needs.
  const [rev, setRev]         = useState(0)
  const [autoSaving, setAutoSaving] = useState(false)
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
  // Side docks are sized across instead of down, and the two sizes are kept
  // apart: the height you like for a bottom strip says nothing about the width
  // you want for a column, and collapsing them into one number means every
  // dock switch resizes the pad to something you never chose.
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('pghtech_scratch_w'))
    return saved > 0 ? saved : Math.round(window.innerWidth * DEFAULT_W_FRACTION)
  })
  const [dock, setDock] = useState<Dock>(() => {
    const v = localStorage.getItem(DOCK_KEY)
    return v === 'left' || v === 'right' ? v : 'bottom'
  })
  const [narrow, setNarrow] = useState(() => window.innerWidth <= SIDE_DOCK_MIN_VW)
  // The dock actually in force. A phone keeps the preference on file but shows
  // the pad at the bottom, because a 300px-wide column is not somewhere you can
  // write.
  const side = !narrow && dock !== 'bottom'
  // Bumped on every deliberate pad change (open / new), never when a save merely
  // gives the current pad an id. It keys the drawing pad, so autosave creating
  // the Drive file no longer remounts it mid-stroke the way keying on padId did.
  const [padSeq, setPadSeq] = useState(0)
  // Latest values for the async paths (revalidation, the autosave timer) that
  // would otherwise close over whatever was true when they were scheduled.
  const dirtyRef = useRef(false)
  const padIdRef = useRef<string | null>(null)
  const lastBodyRef = useRef('')       // body as last loaded or saved
  const savingRef = useRef(false)
  const dragging = useRef(false)
  const padRef = useRef<HandwritingPadHandle>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Whether the body actually overflows — no point floating scroll buttons
  // over content that already fits.
  const [scrollable, setScrollable] = useState(false)

  function markEdited() { setDirty(true); setRev(r => r + 1) }
  const revRef = useRef(0)
  revRef.current = rev

  const current = pads.find(p => p.id === padId) ?? null
  dirtyRef.current = dirty
  padIdRef.current = padId

  // ── loading ───────────────────────────────────────────────────────────────
  // Apply a body to the editor. Shared by the cache hit and the network reply so
  // the two can never disagree about how a pad opens.
  const applyBody = useCallback((id: string, body: string) => {
    const doc  = parseHwDoc(body)
    const text = textOf(body)
    setPadId(id)
    setHtml(text)
    setHwDoc(doc)
    setTab(doc && !text ? 'draw' : 'rich')
    setDirty(false)
    lastBodyRef.current = body
    setPadSeq(n => n + 1)      // remount the drawing pad on THIS pad's strokes
  }, [])

  // Cache first, then revalidate. A cached body renders with no spinner at all;
  // the Drive fetch still goes out and replaces it only if it actually differs
  // and you have not started editing in the meantime — a background reply must
  // never overwrite typing that began after it was requested.
  const openPad = useCallback(async (id: string, knownMod?: string) => {
    const hit = cachedScratchBody(id)
    if (hit) applyBody(id, hit.html)
    else setBusy('Loading…')
    setErr(null)
    setLastScratchId(id)
    // A cache entry fetched at the modifiedTime Drive currently reports is known
    // good; skip the round trip entirely.
    if (hit && knownMod && hit.modifiedTime === knownMod) return
    try {
      const body = await loadScratch(id)
      putScratchBody(id, body, knownMod ?? new Date().toISOString())
      if (!dirtyRef.current && padIdRef.current === id && body !== lastBodyRef.current) {
        applyBody(id, body)
      }
    } catch (e) {
      // A cached pad on screen is still usable — say so quietly rather than
      // replacing it with an error.
      if (!hit) setErr((e as Error).message)
    } finally { setBusy(null) }
  }, [applyBody])

  // Opening starts a blank, UNSAVED pad. Nothing is written to Drive until you
  // press Save — clicking the button to glance at something should not leave a
  // file behind, and the previous design created one on every open and then had
  // to sweep the empties back up again.
  //
  // The cost is that an unsaved pad is lost on close. That is the trade a
  // scratch pad makes: Save is what turns a jotting into something kept.
  useEffect(() => {
    if (!open) return
    let cancelled = false

    // Show the cached list at once so the picker is populated and the resume
    // below can start without waiting on Drive.
    const seeded = cachedScratchList()
    if (seeded?.length) setPads(seeded)

    // Resume straight from the cache while the list is still in flight.
    const last = lastScratchId()
    if (last) void openPad(last)
    else { setPadId(null); setName(defaultScratchName()); setHtml(''); setHwDoc(null); setTab('draw'); setDirty(false) }

    ;(async () => {
      if (!seeded?.length) setBusy('Loading…')
      setErr(null)
      try {
        const list = await listScratch()
        if (cancelled) return
        setPads(list)
        putScratchList(list)
        // Fall back to the newest pad when there was nothing remembered, or the
        // remembered one has since been deleted (possibly on another device).
        // The valid-and-remembered case is already open or opening below, so
        // this must not fire for it and start a second fetch.
        const stillThere = !!last && list.some(p => p.id === last)
        if (last && !stillThere) setLastScratchId(null)
        if (!padIdRef.current && !dirtyRef.current && !stillThere && list[0]) {
          void openPad(list[0].id, list[0].modifiedTime)
        }
      } catch (e) { if (!cancelled) setErr((e as Error).message) }
      finally { if (!cancelled) setBusy(null) }
    })()

    return () => { cancelled = true }
  }, [open, openPad])

  function switchPad(id: string) {
    if (id === padId) return
    void openPad(id, pads.find(p => p.id === id)?.modifiedTime)
  }


  useEffect(() => { if (current) setName(current.name) }, [current])

  // ── saving ────────────────────────────────────────────────────────────────
  // Save is what CREATES the pad. Until it runs there is no Drive file, so an
  // opened-and-abandoned pad costs nothing.
  // Compose the body from whatever the editor currently holds. Strokes come off
  // the pad's ref rather than state: the component owns them and only reports on
  // demand.
  function composeBody(): { body: string; doc: HwDoc | null } {
    const doc = tab === 'draw' && padRef.current ? padRef.current.getDoc() : hwDoc
    const drawing = doc && doc.pages.some(p => p.strokes.length) ? hwDocToBlockHtml(doc) : ''
    return { body: [html, drawing].filter(Boolean).join('\n'), doc }
  }

  // `silent` is the autosave path: it must not drive `busy`, which gates the
  // Save button and the ⌘S shortcut — a background write is not a reason to take
  // the controls away.
  async function persist(silent = false): Promise<void> {
    // One write at a time. A caller that arrives mid-flight is not dropped: the
    // finally below notices the edit counter moved and schedules another pass.
    if (savingRef.current) return
    const startedAt = revRef.current
    const { body, doc } = composeBody()
    // Never let an autosave conjure a file out of an untouched pad. This is the
    // one thing the old open-blank behaviour got right, and it still holds: a
    // pad exists on Drive because you put something in it.
    if (!padId && !body.trim()) return
    savingRef.current = true
    if (silent) setAutoSaving(true); else setBusy('Saving…')
    setErr(null)
    try {
      let id = padId
      if (id) {
        await saveScratch(id, body)
        setPads(prev => prev.map(p => p.id === id
          ? { ...p, modifiedTime: new Date().toISOString() } : p))
      } else {
        const created = await createScratch(name.trim() || defaultScratchName(), body)
        id = created.id
        setPadId(created.id)
        setLastScratchId(created.id)
        setPads(prev => [created, ...prev])
      }
      lastBodyRef.current = body
      putScratchBody(id, body, new Date().toISOString())
      if (doc) setHwDoc(doc)
      setDirty(false)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      savingRef.current = false
      if (silent) setAutoSaving(false); else setBusy(null)
      // Edits that landed while this write was in flight need their own pass.
      // Comparing counters rather than reading `dirty` matters: setDirty(false)
      // above has not reached a render yet, so dirtyRef would still say true
      // here and this would never stop rescheduling itself.
      if (revRef.current !== startedAt) setRev(r => r + 1)
    }
  }

  const save = () => { void persist(false) }

  // Held in a ref so the timer below spends the newest closure. Scheduling
  // captures `tab` among other things, and switching Draw → Rich inside the
  // debounce window would otherwise compose the body from a stale doc.
  const persistRef = useRef(persist)
  persistRef.current = persist

  // Debounced on an edit counter rather than on `dirty`: dirty stays true for
  // the whole run of edits, so it would fire once and never reschedule.
  useEffect(() => {
    if (!rev) return
    const t = window.setTimeout(() => { void persistRef.current(true) }, AUTOSAVE_MS)
    return () => window.clearTimeout(t)
  }, [rev])

  // Closing the panel cancels the pending timer, so flush first — otherwise the
  // last 1.6 seconds of work is the one thing autosave loses.
  useEffect(() => {
    if (open) return
    if (dirtyRef.current) void persistRef.current(true)
  }, [open])

  // Same for the app going to the background, which on a phone is how a session
  // usually ends. `hidden` is the last event that reliably fires.
  useEffect(() => {
    function flush() {
      if (document.visibilityState === 'hidden' && dirtyRef.current) void persistRef.current(true)
    }
    document.addEventListener('visibilitychange', flush)
    return () => document.removeEventListener('visibilitychange', flush)
  }, [])

  // ＋ is "start over", not "create a file" — same as opening the pad.
  // ＋ is the ONLY way to a blank pad now that opening resumes. Still creates
  // nothing on Drive until there is something in it — see persist().
  function addPad() {
    setPadId(null)
    setLastScratchId(null)
    setName(defaultScratchName())
    setHtml(''); setHwDoc(null); setTab('draw'); setDirty(false)
    setRev(0)
    lastBodyRef.current = ''
    setPadSeq(n => n + 1)
  }

  async function removePad() {
    if (!padId || !current) return
    if (!confirm(`Delete “${current.name}”? This cannot be undone.`)) return
    setBusy('Deleting…'); setErr(null)
    try {
      await deleteScratch(padId)
      dropScratchBody(padId)
      setLastScratchId(null)
      const rest = pads.filter(p => p.id !== padId)
      setPads(rest)
      putScratchList(rest)
      if (rest.length) await openPad(rest[0].id, rest[0].modifiedTime)
      else { setPadId(null); setHtml(''); setHwDoc(null); lastBodyRef.current = ''; setPadSeq(n => n + 1) }
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  async function commitName() {
    const next = name.trim()
    // Not saved yet ⇒ nothing to rename; the typed name is simply what the file
    // will be called when Save creates it.
    if (!padId) { if (!next) setName(defaultScratchName()); return }
    if (!current || !next || next === current.name) { setName(current?.name ?? ''); return }
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
  const MIN_W = 300
  const maxH  = () => Math.max(MIN_H, window.innerHeight - 48)   // leave the top bar reachable
  const maxW  = () => Math.max(MIN_W, window.innerWidth  - 48)   // never swallow the page entirely
  const clamp  = (h: number) => Math.min(maxH(), Math.max(MIN_H, h))
  const clampW = (w: number) => Math.min(maxW(), Math.max(MIN_W, w))
  const isMax = side ? width >= maxW() - 2 : height >= maxH() - 2

  // Persist across opens — the size you chose is a preference, not a per-visit
  // accident.
  useEffect(() => {
    try { localStorage.setItem('pghtech_scratch_h2', String(Math.round(height))) } catch { /* private mode */ }
  }, [height])
  useEffect(() => {
    try { localStorage.setItem('pghtech_scratch_w', String(Math.round(width))) } catch { /* private mode */ }
  }, [width])

  // Keep it legal when the window itself shrinks, and re-decide whether a side
  // dock still fits.
  useEffect(() => {
    function onResize() {
      setHeight(h => clamp(h))
      setWidth(w => clampW(w))
      setNarrow(window.innerWidth <= SIDE_DOCK_MIN_VW)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const nextDock = DOCK_ORDER[(DOCK_ORDER.indexOf(dock) + 1) % DOCK_ORDER.length]
  function cycleDock() {
    setDock(nextDock)
    try { localStorage.setItem(DOCK_KEY, nextDock) } catch { /* private mode */ }
  }

  function toggleMax() {
    if (side) setWidth(isMax ? Math.round(window.innerWidth * DEFAULT_W_FRACTION) : maxW())
    else      setHeight(isMax ? Math.round(window.innerHeight * DEFAULT_FRACTION) : maxH())
  }

  // Drag the top edge. Pointer capture keeps the drag alive over the iframe or
  // any other element the cursor crosses.
  function gripDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = true
    document.body.classList.add(side ? 'resizing-h' : 'resizing-v')
  }
  function gripMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    // The grip always sits on the edge facing the page, so the drag measures
    // from the opposite side of the window in every dock.
    if (!side)                 setHeight(clamp(window.innerHeight - e.clientY))
    else if (dock === 'left')  setWidth(clampW(e.clientX))
    else                       setWidth(clampW(window.innerWidth - e.clientX))
  }
  function gripUp(e: React.PointerEvent<HTMLDivElement>) {
    dragging.current = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
    document.body.classList.remove('resizing-v')
    document.body.classList.remove('resizing-h')
  }

  // Which element actually scrolls. In Rich / HTML / Preview it is the body,
  // but in Draw the body is exactly the pad's height and the overflow lives in
  // HandwritingPad's own .hw-canvas-wrap — the canvas is 1000:1400, so on a
  // narrow screen it is far taller than the pane. Measuring only the body
  // therefore reported "nothing to scroll" in Draw, which is the default mode
  // and the whole of the mobile experience.
  //
  // That wrapper also sets touch-action: none so the canvas can capture
  // strokes, meaning a finger cannot scroll it at all — these buttons are the
  // only way to move the page there.
  const scroller = useCallback((): HTMLElement | null => {
    const root = bodyRef.current
    if (!root) return null
    if (root.scrollHeight > root.clientHeight + 4) return root
    const inner = root.querySelector<HTMLElement>('.hw-canvas-wrap')
    if (inner && inner.scrollHeight > inner.clientHeight + 4) return inner
    return null
  }, [])

  // Re-measure whenever the content or the pad's size could have changed. A
  // drawing grows as you draw, so this watches the elements themselves rather
  // than only React's renders.
  useEffect(() => {
    const el = bodyRef.current
    if (!open || !el) return
    const measure = () => setScrollable(!!scroller())
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    const inner = el.querySelector<HTMLElement>('.hw-canvas-wrap')
    if (inner) { ro.observe(inner); inner.addEventListener('scroll', measure, { passive: true }) }
    el.addEventListener('scroll', measure, { passive: true })
    // The canvas mounts a tick after the tab switch, so measure once more when
    // layout has settled rather than only on the frame that swapped it in.
    const t = window.setTimeout(measure, 120)
    return () => {
      ro.disconnect()
      window.clearTimeout(t)
      el.removeEventListener('scroll', measure)
      inner?.removeEventListener('scroll', measure)
    }
  }, [open, tab, html, height, padId, scroller])

  // A page at a time would overshoot handwriting; ~45% keeps a couple of lines
  // of context on screen either side of the jump.
  function scrollBody(dir: -1 | 1) {
    const el = scroller()
    if (!el) return
    el.scrollBy({ top: dir * Math.max(80, el.clientHeight * 0.45), behavior: 'smooth' })
  }

  if (!open) return null

  return (
    <section
      className={`scratch-pad dock-${side ? dock : 'bottom'}`}
      style={side ? { width } : { height }}
      aria-label="Scratch Pad"
    >
      {/* Drag handle on the edge facing the page — the whole border is the
          target, not a few pixels of it. Bottom dock grips its top edge; a side
          dock grips its inner edge, which is the same gesture turned 90°. */}
      <div
        className={`scratch-grip${side ? ' scratch-grip-v' : ''}`}
        onPointerDown={gripDown}
        onPointerMove={gripMove}
        onPointerUp={gripUp}
        onPointerCancel={gripUp}
        onDoubleClick={toggleMax}
        role="separator"
        aria-orientation={side ? 'vertical' : 'horizontal'}
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
               : autoSaving ? 'Saving…'
               : dirty ? 'Unsaved'
               // A blank pad has never been saved; calling it "Saved" would
               // claim a file exists when none does.
               : padId ? 'Saved' : 'New'}
        </span>

        {/* Enabled without a padId: on a fresh pad Save is what CREATES it.
            Gated on having something to save, so an untouched pad cannot spawn
            an empty file by a stray click. */}
        <button className="scratch-btn scratch-save" onClick={save}
          disabled={!!busy || (!padId && !dirty)}
          title="Save (⌘S)">Save</button>
        {/* One button rather than three: the header already wraps on a narrow
            window, and cycling bottom → left → right is two taps at worst. The
            glyph shows where the pad IS, the tooltip where it goes next. */}
        <button
          className="scratch-btn"
          onClick={cycleDock}
          disabled={narrow}
          title={narrow
            ? 'Side docks need a wider window — the pad stays at the bottom here'
            : `Dock: ${DOCK_META[dock].label} — click for ${DOCK_META[nextDock].label}`}
          aria-label={`Dock position: ${DOCK_META[dock].label}. Click for ${DOCK_META[nextDock].label}`}
        >{DOCK_META[side ? dock : 'bottom'].icon}</button>
        <button
          className="scratch-btn"
          onClick={toggleMax}
          title={isMax ? 'Restore' : 'Maximise'}
          aria-label={isMax ? 'Restore' : 'Maximise'}
        >{
          !side            ? (isMax ? '▾' : '▴')
          : dock === 'left' ? (isMax ? '◂' : '▸')
          :                   (isMax ? '▸' : '◂')
        }</button>
        <button className="scratch-btn scratch-close" onClick={onClose} title="Close Scratch Pad" aria-label="Close Scratch Pad">✕</button>
      </header>

      {scrollable && (
        // Floated over the pad, not in the toolbar: while writing, your hand is
        // already at the page, and a control at the top would cost a round trip.
        <div className="scratch-scroll">
          <button onClick={() => scrollBody(-1)} title="Scroll up" aria-label="Scroll up">▲</button>
          <button onClick={() => scrollBody(1)} title="Scroll down" aria-label="Scroll down">▼</button>
        </div>
      )}

      {/* In Draw the pane must BOUND the pad rather than grow to it. Left to
          size itself the pad is as tall as its 1000x1400 page, so the body
          became the scroller and carried the tools off the top of the window —
          the very thing the floating cluster is there to avoid. With the pane
          bounded, the overflow lands back in HandwritingPad's own
          .hw-canvas-wrap, which is also what scroller() below prefers. */}
      <div className={`scratch-body${tab === 'draw' ? ' is-draw' : ''}`} ref={bodyRef}>
        {tab === 'rich' && (
          <RichEditor value={html} onChange={v => { setHtml(v); markEdited() }} allowHtmlEmbed />
        )}
        {tab === 'html' && (
          <textarea className="rf-textarea scratch-html" value={html} spellCheck={false}
            onChange={e => { setHtml(e.target.value); markEdited() }}
            placeholder="<p>Paste or write raw HTML…</p>" />
        )}
        {tab === 'preview' && (
          <div className="rf-preview" dangerouslySetInnerHTML={{ __html: html }} />
        )}
        {tab === 'draw' && (
          // Keyed on the pad so switching pads remounts with that pad's strokes
          // rather than carrying the previous one's over.
          //
          // onChange only flips the dirty flag — it does NOT lift the strokes
          // into state. save() reads them live off the ref, and re-rendering
          // this component on every committed stroke would fight the paint
          // path HandwritingPad goes to some length to keep cheap. The pad
          // skips its own initial mount, so opening a saved drawing does not
          // announce itself as an edit.
          <HandwritingPad
            key={padSeq}
            ref={padRef}
            initialDoc={hwDoc ?? undefined}
            floatingTools
            onChange={markEdited}
          />
        )}
      </div>
    </section>
  )
}
