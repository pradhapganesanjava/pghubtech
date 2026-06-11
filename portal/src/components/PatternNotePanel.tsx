/**
 * Editable note panel for the Patterns reference (Group By combos + DS/Topic
 * micros). A floating side window (same shell as AskAIPanel / ProblemAIChat)
 * that VIEWS a saved note and EDITS it with the shared RichEditor — reusing the
 * exact Browse note pipeline (Drive image upload, sanitise) but persisting via
 * patternNotesRepo (its own sheet tab + Drive folder). Browse notes untouched.
 *
 * Triggered from patterns.html (the iframe) via a `pgnote-open` postMessage,
 * which AdsHubView maps to opening this panel for a given note `key`.
 */
import { useEffect, useRef, useState } from 'react'
import RichEditor from './RichEditor'
import { sanitizeHtml } from '../lib/sanitize'
import { fetchDriveFile, resolveDriveImagesInHtml } from '../lib/drive'
import { getOrCreateImageFolder, uploadImageBlob, inferFilename, uploadInlineImages } from '../lib/driveImages'
import { GAuth } from '../lib/gauth'
import { getPatternNote, savePatternNote, deletePatternNote } from '../adapters/patternNotesRepo'

interface Props {
  open:     boolean
  noteKey:  string
  title:    string
  onClose:  () => void
  onSaved:  (key: string, hasNote: boolean, bodyHtml: string) => void
}

const DEFAULT_W = 480, DEFAULT_H = 600, MIN_W = 340, MIN_H = 320, MAX_W = 1100, MAX_H = 1000

// Pull the editable body out of a wrapped note document (mirrors AdsHubView).
function extractEditableBody(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  let inner = m ? m[1] : html
  inner = inner.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  return inner.trim()
}
// Map known blob: image URLs back to their Drive URLs before saving.
function blobUrlsToDrive(html: string, blobToDrive: Map<string, string>): string {
  let out = html
  blobToDrive.forEach((driveUrl, blobUrl) => { if (out.includes(blobUrl)) out = out.split(blobUrl).join(driveUrl) })
  return out
}

export default function PatternNotePanel({ open, noteKey, title, onClose, onSaved }: Props) {
  const [editing, setEditing]   = useState(false)
  const [viewHtml, setViewHtml] = useState('')
  const [editorHtml, setEditor] = useState('')
  const [loading, setLoading]   = useState(false)
  const [busy, setBusy]         = useState(false)
  const [err, setErr]           = useState('')
  const [maximized, setMax]     = useState(false)
  const [size, setSize]         = useState({ w: DEFAULT_W, h: DEFAULT_H })

  const blobUrlsRef    = useRef<string[]>([])
  const blobToDriveRef = useRef<Map<string, string>>(new Map())
  const resizingRef    = useRef(false)
  const resizeStart    = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  function revokeBlobs() {
    blobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch { /* ignore */ } })
    blobUrlsRef.current = []
    blobToDriveRef.current = new Map()
  }

  // Load the note (or open empty in edit mode) whenever the key changes.
  useEffect(() => {
    if (!open || !noteKey) return
    let cancelled = false
    setErr(''); setEditing(false); setViewHtml(''); setEditor(''); setLoading(true)
    revokeBlobs()
    ;(async () => {
      try {
        const got = await getPatternNote(noteKey)
        if (cancelled) return
        if (got) {
          const body     = extractEditableBody(got.raw)
          const resolved = await resolveDriveImagesInHtml(body, GAuth.getToken() || '', blobUrlsRef.current, blobToDriveRef.current)
          if (cancelled) return
          setEditor(resolved); setViewHtml(sanitizeHtml(resolved)); setEditing(false)
        } else {
          setEditor(''); setViewHtml(''); setEditing(true)   // no note yet → add mode
        }
      } catch (e) { if (!cancelled) setErr((e as Error).message) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true; revokeBlobs() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, noteKey])

  async function handlePasteImage(blob: Blob): Promise<string> {
    const token = GAuth.getToken()
    if (!token) throw new Error('not signed in')
    const folderId = await getOrCreateImageFolder(token)
    const driveUrl = await uploadImageBlob(token, folderId, blob, inferFilename(blob))
    const blobUrl  = URL.createObjectURL(blob)
    blobUrlsRef.current.push(blobUrl)
    blobToDriveRef.current.set(blobUrl, driveUrl)
    return blobUrl
  }

  async function save() {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const token = GAuth.getToken()
      if (!token) throw new Error('Not signed in — sign in to the portal first.')
      let html = blobUrlsToDrive(editorHtml, blobToDriveRef.current)
      html = await uploadInlineImages(html, token)
      html = sanitizeHtml(html)
      await savePatternNote(noteKey, title, html)
      setViewHtml(sanitizeHtml(editorHtml))   // editor's blob: urls stay valid this session
      setEditing(false)
      onSaved(noteKey, true, html)
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  async function remove() {
    if (!window.confirm('Delete this note?')) return
    setBusy(true); setErr('')
    try {
      await deletePatternNote(noteKey)
      setEditor(''); setViewHtml(''); setEditing(true)
      onSaved(noteKey, false, '')
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  // Resize handle (bottom-left; panel anchored top-right) — mirrors AskAIPanel.
  function onResizeDown(e: React.PointerEvent<HTMLDivElement>) {
    if (maximized) return
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    resizingRef.current = true
    resizeStart.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h }
    document.body.classList.add('resizing-h')
  }
  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizingRef.current || !resizeStart.current) return
    const s = resizeStart.current
    setSize({
      w: Math.min(MAX_W, Math.max(MIN_W, s.w + (s.x - e.clientX))),
      h: Math.min(MAX_H, Math.max(MIN_H, s.h + (e.clientY - s.y))),
    })
  }
  function onResizeUp(e: React.PointerEvent<HTMLDivElement>) {
    resizingRef.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  if (!open) return null
  const wrapStyle: React.CSSProperties = maximized ? {} : { width: size.w, height: size.h }

  return (
    <div className={`ai-panel pattern-note-panel${maximized ? ' maximized' : ''}`} style={wrapStyle} role="dialog" aria-label="Pattern note">
      <div className="ai-panel-hd">
        <span className="ai-panel-title">📝 Note <span style={{ color: 'var(--text2)', fontWeight: 400, fontSize: 11 }}>· {title}</span></span>
        <div className="ai-panel-hd-actions">
          {!editing && !loading && <button className="ai-icon-btn" onClick={() => setEditing(true)} title="Edit note">✏️</button>}
          <button className="ai-icon-btn" onClick={() => setMax(m => !m)} title={maximized ? 'Restore' : 'Maximize'}>{maximized ? '🗗' : '🗖'}</button>
          <button className="ai-icon-btn" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {err && <div className="ai-panel-err">{err}</div>}

      <div className="pattern-note-body">
        {loading ? (
          <div className="pattern-note-empty">Loading…</div>
        ) : editing ? (
          <>
            <RichEditor value={editorHtml} onChange={setEditor} onPasteImage={handlePasteImage} allowHtmlEmbed />
            <div className="pattern-note-actions">
              <button className="pn-btn pn-btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : '💾 Save'}</button>
              <button className="pn-btn" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
              <button className="pn-btn pn-btn-danger" onClick={remove} disabled={busy} style={{ marginLeft: 'auto' }}>🗑 Delete</button>
            </div>
          </>
        ) : viewHtml ? (
          <div className="pattern-note-view section-html-body" dangerouslySetInnerHTML={{ __html: viewHtml }} />
        ) : (
          <div className="pattern-note-empty">No note yet. Click ✏️ to add one.</div>
        )}
      </div>

      {!maximized && (
        <div className="ai-panel-resize" onPointerDown={onResizeDown} onPointerMove={onResizeMove}
             onPointerUp={onResizeUp} onPointerCancel={onResizeUp} title="Drag to resize" />
      )}
    </div>
  )
}
