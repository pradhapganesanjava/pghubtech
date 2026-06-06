import { useEffect, useMemo, useRef, useState } from 'react'
import { GAuth } from '../lib/gauth'
import { fetchDriveFile, resolveDriveImagesInHtml } from '../lib/drive'
import {
  getOrCreateImageFolder, uploadImageBlob, inferFilename, uploadInlineImages,
} from '../lib/driveImages'
import { sanitizeHtml } from '../lib/sanitize'
import { loadFilters, saveFilters } from '../lib/persistedFilters'
import { csvFromRows, htmlToCsvText, downloadCsv } from '../lib/csvExport'

// Filter state persisted across logout/login (see lib/persistedFilters.ts).
const ADSHUB_FILTERS_KEY = 'pghub.adshub.filters'
// Difficulty filter switched from single 'All' | Easy | Med | Hard to a
// multi-select set of {Easy, Medium, Hard}. Empty set ≡ 'All'.
interface AdsHubFilters {
  tags: string[]; companies: string[]; list: string | null
  diff: ('Easy' | 'Medium' | 'Hard')[]; customOnly: boolean; search: string
}
const ADSHUB_FILTERS_DEFAULTS: AdsHubFilters = {
  tags: [], companies: [], list: null, diff: [], customOnly: false, search: '',
}
import {
  loadProblems, getCachedProblems, saveProblemNote, updateProblemTags, appendProblem,
  loadLists, getCachedLists, addToList, removeFromList, renameList,
} from '../adapters/adsRepo'
import type { LCProblem, LCList } from '../adapters/adsRepo'
import AdsHubSidebar from '../components/AdsHubSidebar'
import AdsLineage from '../components/AdsLineage'
import CodePanel from '../components/CodePanel'
import HandwritingPad from '../components/HandwritingPad'
import type { HwDoc, HandwritingPadHandle } from '../components/HandwritingPad'
import RichEditor from '../components/RichEditor'
import { useToast } from '../components/Toast'
import AudioReader from '../components/AudioReader'
import { htmlToSpokenText } from '../lib/audioMode'
import ProblemAIChat from '../components/ProblemAIChat'

type NoteMode = 'hidden' | 'view' | 'edit'

// Pull the editable body out of a stored note doc: drop the <head>, and any
// inline <style>/<script> so the rich editor shows clean content.
function extractEditableBody(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  let inner = m ? m[1] : html
  inner = inner.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  return inner.trim()
}

// Map any known blob: image URLs back to their Drive URLs before saving.
function blobUrlsToDrive(html: string, blobToDrive: Map<string, string>): string {
  let out = html
  blobToDrive.forEach((driveUrl, blobUrl) => {
    if (out.includes(blobUrl)) out = out.split(blobUrl).join(driveUrl)
  })
  return out
}

// On SAVE: replace each editor placeholder (.rf-html-embed[data-html]) with its
// raw HTML verbatim, wrapped in .note-html-embed. This deliberately bypasses
// sanitisation for the embed (styles/markup are preserved); it's safe because
// NoteViewer renders the note inside a sandboxed iframe.
function expandHtmlEmbeds(html: string): string {
  const c = document.createElement('div')
  c.innerHTML = html
  c.querySelectorAll('.rf-html-embed').forEach(el => {
    const raw  = el.getAttribute('data-html') ?? ''
    const wrap = document.createElement('div')
    wrap.className = 'note-html-embed'
    wrap.innerHTML = raw            // raw is decoded by getAttribute; not executed here
    el.replaceWith(wrap)
  })
  return c.innerHTML
}

// On LOAD (edit): turn saved .note-html-embed blocks back into editable
// placeholders so re-editing round-trips. innerHTML never executes scripts.
function contractHtmlEmbeds(html: string): string {
  const c = document.createElement('div')
  c.innerHTML = html
  c.querySelectorAll('.note-html-embed').forEach(el => {
    const raw = el.innerHTML
    const ph  = document.createElement('div')
    ph.className = 'rf-html-embed'
    ph.setAttribute('contenteditable', 'false')
    ph.setAttribute('data-html', raw)
    ph.innerHTML =
      '<div class="rf-html-embed-label">⧉ HTML section — click to edit</div>' +
      `<div class="rf-html-embed-preview">${sanitizeHtml(raw) || '<em>empty</em>'}</div>`
    el.replaceWith(ph)
  })
  return c.innerHTML
}

// Pull the body inner from a stored note HTML document.
function bodyInner(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  return m ? m[1] : html
}

// Split a note body into its handwriting section (.hw-doc + .hw-page <img>s)
// and the remaining rich-text content, plus the parsed HwDoc if present.
// Uses DOMParser so attribute values containing '>' (e.g. data-doc JSON)
// don't trip naive regexes. Used by startEdit (load both) and handleSaveNote
// (preserve the other side so saving one never wipes the other).
function splitNoteBody(body: string): { text: string; hw: string; hwDoc: HwDoc | null } {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${body}</body></html>`, 'text/html')
  const hwDocEl = doc.querySelector('.hw-doc') as HTMLElement | null
  const hwImgs  = Array.from(doc.querySelectorAll('img.hw-page')) as HTMLElement[]
  const hw = (hwDocEl?.outerHTML ?? '') + hwImgs.map(i => i.outerHTML).join('')
  let hwDoc: HwDoc | null = null
  if (hwDocEl) {
    try { hwDoc = JSON.parse(hwDocEl.getAttribute('data-doc') ?? '') as HwDoc } catch { /* keep null */ }
  }
  hwDocEl?.remove(); hwImgs.forEach(i => i.remove())
  return { text: doc.body.innerHTML.trim(), hw, hwDoc }
}

// Cap the rendered list so a 3,900-row archive stays snappy; filters/search
// narrow it down and the toolbar shows the true match count.
const LIST_CAP = 400

const DIFFS = ['Easy', 'Medium', 'Hard'] as const
type Diff = typeof DIFFS[number]

function diffClass(d: string): string {
  const k = d.toLowerCase()
  return k === 'easy' ? 'lc-easy' : k === 'medium' ? 'lc-medium' : k === 'hard' ? 'lc-hard' : ''
}

// ── Notes pane: fetch the Drive-hosted note HTML, swap its Drive image URLs
// to blob: URLs, and render it in a style-isolated sandboxed iframe. ──────────
function NoteViewer({ driveId }: { driveId: string }) {
  const [html, setHtml]       = useState<string | null>(null)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(true)
  const blobUrlsRef = useRef<string[]>([])

  useEffect(() => {
    setHtml(null); setError(''); setLoading(true)
    let cancelled = false
    const blobUrls: string[] = []
    blobUrlsRef.current = blobUrls
    ;(async () => {
      try {
        const token = GAuth.getToken()
        if (!token) throw new Error('Not signed in')
        const raw      = await (await fetchDriveFile(token, driveId)).text()
        const resolved = await resolveDriveImagesInHtml(raw, token, blobUrls, new Map())
        if (!cancelled) setHtml(resolved)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      // Defer revoke so the iframe finishes loading its images first.
      const urls = blobUrls
      setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 30_000)
    }
  }, [driveId])

  if (loading) return <div className="doc-viewer-state"><div className="spinner" /><span>Loading notes…</span></div>
  if (error)   return <div className="doc-viewer-state error">Failed to load notes: {error}</div>
  if (html == null) return null
  // allow-scripts so embedded HTML sections (which may carry <script>) run, and
  // allow-same-origin so the parent-created blob: image URLs resolve. This is
  // the user's own note content — same sandbox posture as DocViewer for
  // user-uploaded docs. (Browsers log an advisory that this combo can escape
  // the sandbox; that's expected, not a block.)
  return <iframe title="Notes" className="adshub-note-iframe" sandbox="allow-scripts allow-same-origin allow-popups" srcDoc={html} />
}

export default function AdsHubView() {
  const { toast } = useToast()
  // Seed from the module cache so re-opening the tab is instant (no spinner,
  // no refetch of ~4k rows). First-ever open falls through to the fetch below.
  const cached = getCachedProblems()
  const [problems, setProblems]   = useState<LCProblem[]>(cached ?? [])
  const [loading, setLoading]     = useState(cached == null)
  const [refreshing, setRefresh]  = useState(false)
  const [selected, setSelected]   = useState<LCProblem | null>(null)
  // Persisted filter state — load once on mount; an effect below saves on
  // every change. Clear All resets state, the effect writes empty back so the
  // next session starts cleared too.
  // Load persisted filters with a one-time migration of the legacy
  // single-string diff ('All' | 'Easy' | …) to the new array shape.
  const _persisted = useMemo(() => {
    const raw = loadFilters(ADSHUB_FILTERS_KEY, ADSHUB_FILTERS_DEFAULTS)
    const out = { ...raw } as AdsHubFilters
    if (typeof (raw as unknown as { diff: unknown }).diff === 'string') {
      const old = (raw as unknown as { diff: string }).diff
      out.diff = old === 'All' || !old ? [] : [old as Diff]
    }
    if (!Array.isArray(out.diff)) out.diff = []
    return out
  }, [])
  const [search, setSearch]       = useState<string>(_persisted.search)
  const [diff, setDiff]           = useState<Diff[]>(_persisted.diff)
  // Difficulty + Custom multi-select dropdown.
  const [diffMenuOpen, setDiffMenuOpen] = useState(false)
  const diffMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!diffMenuOpen) return
    function onClick(e: MouseEvent) {
      if (diffMenuRef.current && !diffMenuRef.current.contains(e.target as Node)) setDiffMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [diffMenuOpen])
  // Custom problems live at frontend_id >= 10000 (see scripts/add-custom-problem.mjs).
  // A toggle is friendlier than substring-searching "1000" (which only catches
  // 10000–10009 due to substring semantics, not 10010 / 10020 / etc).
  const CUSTOM_ID_MIN = 10000
  const [customOnly, setCustomOnly] = useState<boolean>(_persisted.customOnly)
  const [selectedTags, setTags]   = useState<string[]>(_persisted.tags)
  const [noteMode, setNoteMode]   = useState<NoteMode>('hidden')
  const [noteRev, setNoteRev]     = useState(0)        // bump to force NoteViewer reload after save
  const [editorHtml, setEditorHtml] = useState('')
  const [editorView, setEditorView] = useState<'rich' | 'html' | 'preview' | 'draw'>('rich')

  // ── AI helper (per-problem) ─────────────────────────────────────────────
  // Toggle that opens a small inline ProblemAIChat under the prob/code area.
  // No persistence — fresh state per problem selection.
  const [aiOpen, setAiOpen] = useState(false)
  useEffect(() => { setAiOpen(false) }, [selected?.slug])

  // ── Audio mode (per-problem) ────────────────────────────────────────────
  // Persisted in localStorage (matches HomeView's pattern). When on,
  // auto-reads the problem description (or notes if notes are open) every
  // time the selection changes — like Home's auto-read on card change.
  const [audioMode, setAudioMode] = useState<boolean>(() => {
    try { return localStorage.getItem('pghub.adsHubAudioMode') === '1' } catch { return false }
  })
  function toggleAudioMode() {
    setAudioMode(v => {
      const next = !v
      try { localStorage.setItem('pghub.adsHubAudioMode', next ? '1' : '0') } catch {}
      return next
    })
  }
  // Plain-text version of the user's notes for THIS problem — fetched
  // lazily when audio mode AND notes are open (or when AI is opened with
  // notes visible). Cached per driveId so repeated views don't re-fetch.
  const [notesPlainText, setNotesPlainText] = useState<string>('')
  const notesPlainCacheRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    // Only fetch when notes are currently in view AND a driveId exists.
    // Resets to '' on every selection change so the OLD problem's notes
    // don't bleed into the new problem's audio / AI context.
    setNotesPlainText('')
    if (noteMode !== 'view' || !selected?.notesDriveId) return
    const driveId = selected.notesDriveId
    const cached  = notesPlainCacheRef.current.get(driveId)
    if (cached !== undefined) { setNotesPlainText(cached); return }
    let dead = false
    ;(async () => {
      try {
        const token = GAuth.getToken()
        if (!token) return
        const blob  = await fetchDriveFile(token, driveId)
        const html  = await blob.text()
        const text  = new DOMParser().parseFromString(html, 'text/html')
                        .body.textContent?.replace(/\s+/g, ' ').trim() || ''
        if (dead) return
        notesPlainCacheRef.current.set(driveId, text)
        setNotesPlainText(text)
      } catch { /* silent — audio just falls back to question text */ }
    })()
    return () => { dead = true }
  }, [selected?.slug, selected?.notesDriveId, noteMode])
  const [hwInitialDoc, setHwInitialDoc] = useState<HwDoc | null>(null)
  const hwPadRef = useRef<HandwritingPadHandle>(null)
  const [editorLoading, setEditorLoading] = useState(false)
  const [savingNote, setSavingNote] = useState(false)
  const blobUrlsRef    = useRef<string[]>([])
  const blobToDriveRef = useRef<Map<string, string>>(new Map())
  const [selectedCompanies, setCompanies] = useState<string[]>(_persisted.companies)
  const [lists, setLists]                  = useState<LCList[]>(getCachedLists() ?? [])
  const [selectedList, setSelectedList]    = useState<string | null>(_persisted.list)

  // Persist all filter state — Clear All triggers this too via state resets.
  useEffect(() => {
    saveFilters<AdsHubFilters>(ADSHUB_FILTERS_KEY, {
      tags: selectedTags, companies: selectedCompanies, list: selectedList,
      diff, customOnly, search,
    })
  }, [selectedTags, selectedCompanies, selectedList, diff, customOnly, search])
  const [adsMode, setAdsMode]              = useState<'browse' | 'lineage' | 'patterns'>('browse')

  // Patterns iframe (public/patterns.html) → parent message bridge. When
  // the user clicks an anchor #NNN or a "Browse all <topic>" link inside
  // the embedded reference, we switch back to browse mode and either
  // select the problem (expanded) or apply the search filter — same UX
  // as clicking a row in the AdsHub list. Avoids opening a new tab +
  // re-login flow.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data
      if (!d || typeof d !== 'object') return
      if (d.type === 'pghub-open-problem' && (typeof d.id === 'number' || typeof d.id === 'string')) {
        const id = String(d.id)
        const num = String(parseInt(id, 10))
        const p = problems.find(x => x.frontendId === id || x.frontendId === num)
        // STAY in patterns mode (don't setAdsMode('browse')) — selected
        // problem appears in the detail pane to the right of the iframe;
        // user can keep browsing patterns and opening more problems
        // without losing context. Also don't auto-expand the detail —
        // user keeps both panes visible (they can dblclick the detail
        // header to widen if they want).
        if (p) setSelected(p)
      } else if (d.type === 'pghub-search' && typeof d.q === 'string') {
        // 'Browse all <topic>' link → flip to Browse mode and apply the
        // filter (that's the whole point of the link — leave Patterns).
        // Also clear any previously-selected problem so the user lands
        // on a clean filtered list, not a stale problem-detail pane.
        setSearch(d.q); setAdsMode('browse'); setSelected(null)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [problems])
  const [lineageFocus, setLineageFocus]    = useState<number | null>(null)
  // Add-a-problem modal.
  const EMPTY_ADD = { frontendId: '', title: '', slug: '', difficulty: 'Medium', topics: '', companies: '', tags: '', leetcodeUrl: '', description: '' }
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ ...EMPTY_ADD })
  const [addErr, setAddErr]   = useState('')
  const [addBusy, setAddBusy] = useState(false)
  // Tag editing on the selected problem.
  const [editingTags, setEditingTags] = useState(false)
  const [tagDraft, setTagDraft]       = useState<string[]>([])
  const [tagInput, setTagInput]       = useState('')
  const [savingTags, setSavingTags]   = useState(false)
  // Collapsed on load (desktop + mobile); expand via the ▸ strip button.
  const [leftCollapsed, setLeftColl] = useState(true)
  // Resizable / expandable detail pane (mirrors DocsView).
  const [viewerExpanded, setViewerExpanded] = useState(false)
  const [listRatio, setListRatio]           = useState(40)  // list width % when a problem is open
  const [tagsRatio, setTagsRatio]           = useState(20)  // sidebar width %
  const [codeRatio, setCodeRatio]           = useState(42)  // code-panel width % within the detail body
  const [codeCollapsed, setCodeCollapsed]   = useState(true) // code/notes panel collapsed to a strip on load

  // Auto-snap the list↔detail divider to its min when a problem is open, and
  // the details↔code divider to its max when the code/notes panel is expanded.
  // (Same effect as double-clicking the dividers; the user can still drag.)
  useEffect(() => { setListRatio(selected ? 15 : 40) }, [selected?.slug])

  // Per-problem study timer (mm:ss). Resets when the selection changes.
  // Visual escalation: orange + bold at 10 min, red at 15 min, blinking at 20+.
  const [timerSec, setTimerSec] = useState(0)
  useEffect(() => {
    setTimerSec(0)
    if (!selected) return
    const id = window.setInterval(() => setTimerSec(s => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [selected?.slug])
  useEffect(() => { setCodeRatio(codeCollapsed ? 42 : 75) }, [codeCollapsed])
  const descCodeRef = useRef<HTMLDivElement>(null)
  const dragCodeRef = useRef(false)
  // Add-to-list menu in the detail header.
  const [listMenuOpen, setListMenuOpen] = useState(false)
  const [newListName, setNewListName]   = useState('')
  // List Manager modal (create / rename / delete / add-remove problems).
  const [managerOpen, setManagerOpen] = useState(false)
  const [managerName, setManagerName] = useState('')   // persisted list name; '' while creating
  const [nameDraft, setNameDraft]     = useState('')
  const [probQuery, setProbQuery]     = useState('')
  const [managerBusy, setManagerBusy] = useState(false)
  const splitRef    = useRef<HTMLDivElement>(null)
  const bodyWrapRef = useRef<HTMLDivElement>(null)
  const dragListRef = useRef(false)
  const dragLeftRef = useRef(false)

  function revokeEditorBlobs() {
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []
    blobToDriveRef.current = new Map()
  }

  // ── Note create / edit ──────────────────────────────────────────────────
  function startCreate() {
    revokeEditorBlobs()
    setEditorHtml('')
    setHwInitialDoc(null)
    setEditorView('rich')
    setNoteMode('edit')
  }

  async function copyEditorHtml() {
    try { await navigator.clipboard.writeText(editorHtml); toast('HTML copied', 'success') }
    catch { toast('Copy failed', 'error') }
  }

  async function startEdit() {
    if (!selected?.notesDriveId) { startCreate(); return }
    revokeEditorBlobs()
    setHwInitialDoc(null)
    setEditorView('rich')
    setNoteMode('edit')
    setEditorLoading(true)
    try {
      const token = GAuth.getToken()
      if (!token) throw new Error('Not signed in')
      const raw  = await (await fetchDriveFile(token, selected.notesDriveId)).text()
      // Load BOTH the text and the handwriting (if present) so the user can
      // switch tabs and edit either independently. Save preserves the other side.
      const split = splitNoteBody(extractEditableBody(raw))
      const textForEditor = contractHtmlEmbeds(split.text)
      const resolved = await resolveDriveImagesInHtml(textForEditor, token, blobUrlsRef.current, blobToDriveRef.current)
      setEditorHtml(resolved)
      if (split.hwDoc) {
        setHwInitialDoc(split.hwDoc)
        setEditorView('draw')   // default to Draw when there's handwriting
      }
    } catch (e) {
      toast(`Couldn't load note: ${(e as Error).message}`, 'error')
      setNoteMode(selected?.notesDriveId ? 'view' : 'hidden')
    } finally {
      setEditorLoading(false)
    }
  }

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

  async function handleSaveNote() {
    if (!selected) return
    setSavingNote(true)
    try {
      const token = GAuth.getToken()
      if (!token) throw new Error('Not signed in')

      // Fetch the existing note body once so we can preserve whichever side
      // (text or handwriting) the user is NOT actively editing in this save.
      // Without this, saving from Draw would wipe rich text and vice versa.
      // ABORT on any fetch/parse failure — silently swallowing it once cost a
      // user their note when a transient fetch error left prevText empty and
      // the save proceeded with just the handwriting.
      let prevText = '', prevHw = ''
      if (selected.notesDriveId) {
        const prevRaw = await (await fetchDriveFile(token, selected.notesDriveId)).text()
        if (!prevRaw.trim()) {
          throw new Error("Couldn't read the existing note (empty response). Refusing to overwrite — please try Save again.")
        }
        const s = splitNoteBody(bodyInner(prevRaw))
        prevText = s.text; prevHw = s.hw
      }

      // ── Handwriting note: upload page PNGs + embed the stroke JSON ──────────
      if (editorView === 'draw' && hwPadRef.current) {
        const doc  = hwPadRef.current.getDoc()
        const pngs = await hwPadRef.current.exportPagePngs()
        const folderId = await getOrCreateImageFolder(token)
        const urls: string[] = []
        for (let i = 0; i < pngs.length; i++) {
          urls.push(await uploadImageBlob(token, folderId, pngs[i], `hw-${selected.slug}-${Date.now()}-${i}.png`))
        }
        const root = document.createElement('div')
        const data = document.createElement('div')
        data.className = 'hw-doc'
        data.setAttribute('data-doc', JSON.stringify(doc))   // outerHTML escapes the attribute
        root.appendChild(data)
        for (const u of urls) { const img = document.createElement('img'); img.className = 'hw-page'; img.src = u; root.appendChild(img) }
        const hwBody = root.innerHTML
        const finalBody = prevText ? `${prevText}\n${hwBody}` : hwBody
        const id = await saveProblemNote(selected, finalBody)
        const patched = { ...selected, notesDriveId: id, hasNotes: true }
        setProblems(prev => prev.map(p => p.slug === selected.slug ? patched : p))
        setSelected(patched)
        setNoteRev(r => r + 1)
        setNoteMode('view')
        toast('Handwriting saved', 'success')
        return
      }

      let html = blobUrlsToDrive(editorHtml, blobToDriveRef.current)
      html = await uploadInlineImages(html, token)   // upload any leftover data:/blob: images
      html = sanitizeHtml(html)
      html = expandHtmlEmbeds(html)                  // raw HTML sections, preserved verbatim
      const finalBody = prevHw ? `${html}\n${prevHw}` : html
      const id = await saveProblemNote(selected, finalBody)
      const patched = { ...selected, notesDriveId: id, hasNotes: true }
      setProblems(prev => prev.map(p => p.slug === selected.slug ? patched : p))
      setSelected(patched)
      revokeEditorBlobs()
      setNoteRev(r => r + 1)
      setNoteMode('view')
      toast('Notes saved', 'success')
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally {
      setSavingNote(false)
    }
  }

  function cancelEdit() {
    revokeEditorBlobs()
    setEditorHtml('')
    setNoteMode(selected?.notesDriveId ? 'view' : 'hidden')
  }

  // (Delete-note action removed to avoid accidental deletion. clearProblemNote
  // + deleteDriveFile are still exported by their modules if needed later.)

  useEffect(() => {
    if (cached != null) return  // already have data; use ↻ to refresh
    ;(async () => {
      try {
        setProblems(await loadProblems())
      } catch (e) {
        toast(`Failed to load problems: ${(e as Error).message}`, 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Deep-linking via URL query string ───────────────────────────────────
  // Supported on initial load AND on browser back/forward:
  //
  //   /pghubtech/adshub?id=223          ← open problem #223
  //   /pghubtech/adshub?q={id:223}      ← same (user's documented format —
  //                                       we extract id:NNN from the q value)
  //   /pghubtech/adshub?q=trees         ← set search filter to "trees"
  //   /pghubtech/adshub?id=223&q=hash   ← both
  //
  // Selection from the UI then writes ?id= back via replaceState so the URL
  // is shareable. We use replaceState (not pushState) for clicks within the
  // tab so the browser back button leaves the tab rather than undoing
  // individual selections (which would be noisy).
  //
  // urlApplied gates the selection→URL sync effect below. Without the gate,
  // both effects fire on mount and the sync effect (seeing selected=null
  // because the parse effect's setSelected hasn't re-rendered yet) would
  // wipe the ?id= out of the URL BEFORE the parse effect could honour it.
  const [urlApplied, setUrlApplied] = useState(false)
  useEffect(() => {
    function apply() {
      const sp = new URLSearchParams(window.location.search)
      let id = sp.get('id') ?? ''
      let q  = sp.get('q')  ?? ''
      // User's documented format: ?q={id:223} — pull the id out of q.
      const m = q.match(/\bid\s*:\s*(\d+)/i)
      if (m) { id = id || m[1]; q = q.replace(/\{?\s*id\s*:\s*\d+\s*\}?/i, '').trim() }
      if (q) setSearch(q)
      if (id && problems.length > 0) {
        const num = String(parseInt(id, 10))
        const p = problems.find(p => p.frontendId === id || p.frontendId === num)
        if (p) {
          setSelected(p)
          // Deep links land in expanded/maximized view — the visitor came
          // for THIS problem, give it the full pane (matches the behavior
          // when a typed search narrows to one match, see auto-open below).
          setViewerExpanded(true)
        }
      }
      // Open the gate only once problems are loaded — otherwise the sync
      // effect would wipe a ?id= we still need to honour after fetch.
      if (problems.length > 0) setUrlApplied(true)
    }
    apply()
    function onPop() { apply() }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [problems])

  // Write the current selection back into the URL (?id=NNN) so the link is
  // shareable. Gated on urlApplied so we don't wipe a still-pending ?id=
  // before the parse effect has had a chance to read it.
  useEffect(() => {
    if (!urlApplied) return
    if (!/\/adshub\b/i.test(window.location.pathname)) return
    const sp = new URLSearchParams(window.location.search)
    if (selected?.frontendId) sp.set('id', selected.frontendId)
    else                       sp.delete('id')
    const qs = sp.toString()
    const next = window.location.pathname + (qs ? '?' + qs : '')
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState({}, '', next)
    }
  }, [selected?.frontendId, urlApplied])

  async function refresh() {
    if (refreshing) return
    setRefresh(true)
    try {
      setProblems(await loadProblems(true))
      toast('Refreshed', 'success')
    } catch (e) {
      toast(`Refresh failed: ${(e as Error).message}`, 'error')
    } finally {
      setRefresh(false)
    }
  }

  // Reset the note + tag panels whenever the selection changes.
  useEffect(() => {
    revokeEditorBlobs()
    setEditorHtml('')
    setHwInitialDoc(null)
    setEditorView('rich')
    setNoteMode('hidden')
    setEditingTags(false)
    setCodeCollapsed(true)   // code/notes start collapsed for each problem
  }, [selected?.slug]) // eslint-disable-line react-hooks/exhaustive-deps

  // Expand the right panel into code or notes.
  function openCode()  { setNoteMode('hidden'); setCodeCollapsed(false) }
  function openNotes() {
    setCodeCollapsed(false)
    if (selected?.hasNotes && selected.notesDriveId) setNoteMode('view')
    else startCreate()   // no note yet → open the editor to add one
  }

  // Load MyList collections once (unless cached).
  useEffect(() => {
    if (getCachedLists() != null) return
    loadLists().then(setLists).catch(() => { /* tab may not exist yet */ })
  }, [])

  const listSlugs = useMemo(
    () => selectedList ? new Set(lists.find(l => l.name === selectedList)?.slugs ?? []) : null,
    [selectedList, lists],
  )

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    return problems.filter(p => {
      if (diff.length > 0 && !diff.includes(p.difficulty as Diff)) return false
      // Tags: AND across selections, prefix-matching the :: hierarchy.
      if (selectedTags.length > 0 &&
          !selectedTags.every(st => p.tags.some(t => t === st || t.startsWith(st + '::')))) return false
      // Companies: OR (problem asked by any of the selected companies).
      if (selectedCompanies.length > 0 && !selectedCompanies.some(c => p.companies.includes(c))) return false
      // MyList membership.
      if (listSlugs && !listSlugs.has(p.slug)) return false
      // Custom-only toggle: hide everything below the custom id range.
      if (customOnly) {
        const n = Number(p.frontendId)
        if (!Number.isFinite(n) || n < CUSTOM_ID_MIN) return false
      }
      if (s) {
        const hay = `#${p.frontendId} ${p.frontendId} ${p.title} ${p.slug} ${p.tags.join(' ')} ${p.topics.join(' ')} ${p.companies.join(' ')}`.toLowerCase()
        if (!hay.includes(s)) return false
      }
      return true
    })
  }, [problems, diff, selectedTags, selectedCompanies, listSlugs, search, customOnly])

  const shown = filtered.slice(0, LIST_CAP)
  const activeFilterCount = selectedTags.length + selectedCompanies.length + (selectedList ? 1 : 0) + (customOnly ? 1 : 0)

  // The auto-open rules below should only fire in response to LIVE search
  // input — not on initial mount when search is rehydrated from
  // localStorage and the URL has its own ?id= that we should honour.
  // searchTouchedRef flips true the first time the user types in the
  // search box; both rules gate on it so a hard load on
  //   /pghubtech/adshub?id=9
  // (with a stale persisted search of, say, '8') opens #9 — not #8.
  const searchTouchedRef = useRef(false)
  function handleSearchChange(v: string) {
    searchTouchedRef.current = true
    setSearch(v)
  }

  // Exact-frontend_id match: when the search box value is a pure integer
  // that equals an existing frontend_id, open THAT problem — even when
  // substring search surfaces many other IDs containing the same digits
  // (typing "6" should open #6, not wait until only #6 remains in the
  // filtered list). Wins over the lone-match rule below because it's
  // strictly more specific. Same expanded-view side effect as the
  // deep-link parse so the two feel identical.
  useEffect(() => {
    if (!urlApplied || !searchTouchedRef.current) return
    const s = search.trim()
    if (!/^\d+$/.test(s)) return
    const exact = problems.find(p => p.frontendId === s)
    if (!exact) return
    if (selected?.slug !== exact.slug) {
      setSelected(exact)
      setViewerExpanded(true)
    }
  }, [search, problems, urlApplied]) // eslint-disable-line react-hooks/exhaustive-deps

  // Lone-match: when the current filter narrows to exactly one problem
  // (e.g. the user typed a specific title fragment), open it. Skipped
  // when the search is an exact-id match because the rule above will
  // have handled it already. Same searchTouchedRef gate as above.
  useEffect(() => {
    if (!urlApplied || !searchTouchedRef.current) return
    if (filtered.length !== 1) return
    const onlyMatch = filtered[0]
    if (selected?.slug !== onlyMatch.slug) {
      setSelected(onlyMatch)
      setViewerExpanded(true)
    }
  }, [filtered, urlApplied]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleTag(t: string) {
    setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  }
  function toggleCompany(c: string) {
    setCompanies(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])
  }
  function clearAllFilters() {
    setTags([]); setCompanies([]); setSelectedList(null)
  }

  // Download the currently-filtered problem list as a CSV. Columns mirror
  // what's most useful for offline review / sharing:
  //   id, title, difficulty, topics, tags, slug, statement
  // The statement column is HTML-stripped to plain text. Filename is
  // timestamped so multiple exports don't collide in Downloads.
  function exportFilteredCsv() {
    if (filtered.length === 0) { toast('No problems to export (filter is empty)', 'info'); return }
    const header = ['id', 'title', 'difficulty', 'topics', 'tags', 'slug', 'statement']
    const rows = filtered.map(p => [
      p.frontendId,
      p.title,
      p.difficulty,
      p.topics.join('; '),
      p.tags.join('; '),
      p.slug,
      htmlToCsvText(p.descriptionHtml),
    ])
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    downloadCsv(csvFromRows(header, rows), `adshub-problems-${ts}.csv`)
    toast(`Exported ${filtered.length.toLocaleString()} problem${filtered.length === 1 ? '' : 's'} to CSV`, 'success')
  }

  // ── Add a new problem ───────────────────────────────────────────────────
  const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  // Custom (non-LeetCode) problems live in the 10000+ id range to avoid any
  // collision with a real LC number. Suggest max(existing 10000+) + 1, or
  // 10000 if none yet — the user can still type a different id.
  const CUSTOM_ID_BASE = 10000
  function nextCustomId(): string {
    let max = CUSTOM_ID_BASE - 1
    for (const p of problems) {
      const n = Number(p.frontendId)
      if (Number.isFinite(n) && n >= CUSTOM_ID_BASE && n > max) max = n
    }
    return String(max + 1)
  }
  function openAddProblem() {
    setAddForm({ ...EMPTY_ADD, frontendId: nextCustomId() })
    setAddErr(''); setAddOpen(true)
  }
  function setAdd(k: keyof typeof EMPTY_ADD, v: string) { setAddForm(f => ({ ...f, [k]: v })) }
  async function saveNewProblem() {
    const id = addForm.frontendId.trim()
    const title = addForm.title.trim()
    const slug = addForm.slug.trim() || slugify(title)
    if (!id)    { setAddErr('Problem id (#) is required'); return }
    if (!title) { setAddErr('Title is required'); return }
    if (!slug)  { setAddErr('Enter a slug (could not derive one from the title)'); return }
    if (problems.some(p => p.frontendId === id))   { setAddErr(`Id #${id} is already taken`); return }
    if (problems.some(p => p.slug === slug))        { setAddErr(`Slug "${slug}" already exists`); return }
    const list = (s: string) => s.split(/\s*[;,]\s*/).map(x => x.trim()).filter(Boolean)
    const desc = addForm.description.trim()
    const p: LCProblem = {
      slug, frontendId: id, title, difficulty: addForm.difficulty,
      topics: list(addForm.topics), companies: list(addForm.companies), companiesRecent: [],
      tags: list(addForm.tags),
      leetcodeUrl: addForm.leetcodeUrl.trim() || `https://leetcode.com/problems/${slug}/`,
      descriptionHtml: desc && !/</.test(desc) ? `<p>${desc}</p>` : desc,
      notesDriveId: '', hasNotes: false,
    }
    setAddBusy(true); setAddErr('')
    try {
      await appendProblem(p)
      setProblems(prev => [...prev, p])
      setSelected(p)
      setAddOpen(false)
      toast(`Added #${id} ${title}`, 'success')
    } catch (e) {
      setAddErr((e as Error).message)
    } finally { setAddBusy(false) }
  }

  // ── Tag editing on the selected problem ─────────────────────────────────
  const knownTags = useMemo(() => {
    const set = new Set<string>()
    for (const p of problems) for (const t of p.tags) set.add(t)
    return [...set].sort()
  }, [problems])

  function startEditTags() {
    if (!selected) return
    setTagDraft(selected.tags)
    setTagInput('')
    setEditingTags(true)
  }
  function addTagDraft(t: string) {
    const clean = t.trim().replace(/[;,]+$/, '').trim()
    if (!clean) { setTagInput(''); return }
    setTagDraft(prev => prev.includes(clean) ? prev : [...prev, clean])
    setTagInput('')
  }
  function removeTagDraft(t: string) {
    setTagDraft(prev => prev.filter(x => x !== t))
  }
  async function saveTags() {
    if (!selected) return
    const finalTags = tagInput.trim() ? [...tagDraft, tagInput.trim()] : tagDraft
    setSavingTags(true)
    try {
      const saved = await updateProblemTags(selected.slug, finalTags)
      // Update state so buildLineage (in AdsLineage) recomputes + re-pushes to the graph.
      const patched = { ...selected, tags: saved }
      setProblems(prev => prev.map(p => p.slug === selected.slug ? patched : p))
      setSelected(patched)
      setEditingTags(false)
      toast('Tags updated', 'success')
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally {
      setSavingTags(false)
    }
  }

  const tagSuggestions = knownTags
    .filter(t => !tagDraft.includes(t) && (!tagInput || t.toLowerCase().includes(tagInput.toLowerCase())))
    .slice(0, 12)

  // ── MyList membership for the open problem ──────────────────────────────
  const listsForSelected = useMemo(
    () => selected ? lists.filter(l => l.slugs.includes(selected.slug)).map(l => l.name) : [],
    [lists, selected],
  )
  async function toggleMembership(listName: string) {
    if (!selected) return
    const inList = listsForSelected.includes(listName)
    try {
      if (inList) await removeFromList(listName, selected.slug)
      else        await addToList(listName, selected.slug)
      setLists(await loadLists(true))
    } catch (e) {
      toast(`List update failed: ${(e as Error).message}`, 'error')
    }
  }
  async function createListWithSelected() {
    const name = newListName.trim()
    if (!name || !selected) return
    try {
      await addToList(name, selected.slug)
      setLists(await loadLists(true))
      setNewListName('')
      toast(`Added to “${name}”`, 'success')
    } catch (e) {
      toast(`Create list failed: ${(e as Error).message}`, 'error')
    }
  }
  async function deleteList(name: string) {
    const l = lists.find(x => x.name === name)
    if (!l) return
    if (!window.confirm(`Delete list “${name}” (${l.slugs.length} problems)? This only removes the list, not the problems.`)) return
    try {
      for (const slug of [...l.slugs]) await removeFromList(name, slug)
      setLists(await loadLists(true))
      if (selectedList === name) setSelectedList(null)
      if (managerName === name) setManagerOpen(false)
      toast(`Deleted “${name}”`, 'success')
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'error')
    }
  }

  // ── List Manager modal ──────────────────────────────────────────────────
  function openCreateList() {
    setManagerName(''); setNameDraft(''); setProbQuery(''); setManagerOpen(true)
  }
  function openManageList(name: string) {
    setManagerName(name); setNameDraft(name); setProbQuery(''); setManagerOpen(true)
  }
  // Members of the list currently open in the manager.
  const managedSlugs = useMemo(
    () => new Set(lists.find(l => l.name === managerName)?.slugs ?? []),
    [lists, managerName],
  )
  const managedProblems = useMemo(
    () => problems.filter(p => managedSlugs.has(p.slug)),
    [problems, managedSlugs],
  )
  // Problem search results inside the manager (by #id / title / slug), excluding members.
  const probResults = useMemo(() => {
    const q = probQuery.trim().toLowerCase()
    if (!q) return []
    return problems
      .filter(p => !managedSlugs.has(p.slug) &&
        `#${p.frontendId} ${p.frontendId} ${p.title} ${p.slug}`.toLowerCase().includes(q))
      .slice(0, 25)
  }, [problems, probQuery, managedSlugs])

  async function saveListName() {
    const next = nameDraft.trim()
    if (!next || next === managerName) return
    setManagerBusy(true)
    try {
      if (managerName) {            // persisted list → rename all its rows
        await renameList(managerName, next)
        setLists(await loadLists(true))
        if (selectedList === managerName) setSelectedList(next)
      }
      setManagerName(next)          // new (unsaved) list → just adopt the draft name
      toast('List renamed', 'success')
    } catch (e) {
      toast(`Rename failed: ${(e as Error).message}`, 'error')
    } finally { setManagerBusy(false) }
  }

  async function addProblemToList(slug: string) {
    const name = (managerName || nameDraft).trim()
    if (!name) { toast('Name the list first', 'info'); return }
    setManagerBusy(true)
    try {
      await addToList(name, slug)
      setLists(await loadLists(true))
      setManagerName(name)          // first add persists the list under this name
    } catch (e) {
      toast(`Add failed: ${(e as Error).message}`, 'error')
    } finally { setManagerBusy(false) }
  }

  async function removeProblemFromList(slug: string) {
    if (!managerName) return
    setManagerBusy(true)
    try {
      await removeFromList(managerName, slug)
      setLists(await loadLists(true))
    } catch (e) {
      toast(`Remove failed: ${(e as Error).message}`, 'error')
    } finally { setManagerBusy(false) }
  }

  // ── Draggable dividers ──────────────────────────────────────────────────
  function startListDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    dragListRef.current = true; document.body.classList.add('resizing-h')
  }
  function moveListDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragListRef.current || !splitRef.current) return
    const r = splitRef.current.getBoundingClientRect()
    setListRatio(Math.min(Math.max(((e.clientX - r.left) / r.width) * 100, 15), 70))
  }
  function endListDrag(e: React.PointerEvent<HTMLDivElement>) {
    dragListRef.current = false; e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }
  function startLeftDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    dragLeftRef.current = true; document.body.classList.add('resizing-h')
  }
  function moveLeftDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragLeftRef.current || !bodyWrapRef.current) return
    const r = bodyWrapRef.current.getBoundingClientRect()
    setTagsRatio(Math.min(Math.max(((e.clientX - r.left) / r.width) * 100, 12), 45))
  }
  function endLeftDrag(e: React.PointerEvent<HTMLDivElement>) {
    dragLeftRef.current = false; e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }
  // Details ↔ code divider inside the detail body (code is the right column).
  function startCodeDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    dragCodeRef.current = true; document.body.classList.add('resizing-h')
  }
  function moveCodeDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragCodeRef.current || !descCodeRef.current) return
    const r = descCodeRef.current.getBoundingClientRect()
    setCodeRatio(Math.min(Math.max(((r.right - e.clientX) / r.width) * 100, 20), 75))
  }
  function endCodeDrag(e: React.PointerEvent<HTMLDivElement>) {
    dragCodeRef.current = false; e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  // Collapse the add-to-list menu + reset expand when selection clears.
  useEffect(() => { setListMenuOpen(false); setNewListName('') }, [selected?.slug])
  useEffect(() => { if (!selected) setViewerExpanded(false) }, [selected])

  const sidebarHidden = leftCollapsed || viewerExpanded || adsMode === 'lineage' || adsMode === 'patterns'

  // Difficulty/topics row + editable lineage tags. Sits at the top of the
  // detail's left content in every mode (so it lines up with Starter Code).
  function renderMeta() {
    if (!selected) return null
    return (
      <>
        <div className="adshub-meta-row">
          {selected.difficulty && (
            <span className={`adshub-diff-badge ${diffClass(selected.difficulty)}`}>{selected.difficulty}</span>
          )}
          {selected.topics.map(t => <span key={t} className="tag">{t}</span>)}
        </div>
        <details className="adshub-tags-section" key={selected.slug + '::tags'}>
          <summary className="adshub-tags-summary">
            <span>Tags (lineage)</span>
            <span className="tree-cnt">{selected.tags.length}</span>
            {!editingTags && (
              <button
                className="bci-edit-btn bci-edit-btn-hd" style={{ marginLeft: 6 }}
                onClick={e => { e.preventDefault(); e.currentTarget.closest('details')?.setAttribute('open', ''); startEditTags() }}
                title="Edit tags"
              >✎</button>
            )}
          </summary>
          <div className="adshub-tags-body">
          {!editingTags ? (
            selected.tags.length > 0 ? (
              <div className="doc-list-tags">
                {selected.tags.map(t => <span key={t} className="tag" title={t}>{t}</span>)}
              </div>
            ) : (
              <button className="adshub-diff-pill" onClick={startEditTags}>➕ Add tags</button>
            )
          ) : (
            <div className="adshub-tag-edit">
              <div className="doc-tag-input-wrap">
                {tagDraft.map(t => (
                  <span key={t} className="doc-tag-chip" title={t}>
                    {t}
                    <button type="button" onClick={() => removeTagDraft(t)} disabled={savingTags}>×</button>
                  </span>
                ))}
                <input
                  className="doc-tag-input"
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onBlur={() => addTagDraft(tagInput)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); addTagDraft(tagInput) }
                    else if (e.key === 'Backspace' && !tagInput && tagDraft.length) removeTagDraft(tagDraft[tagDraft.length - 1])
                  }}
                  placeholder={tagDraft.length ? '' : 'e.g. _ds::array::subset::triplet'}
                  disabled={savingTags}
                  autoFocus
                />
              </div>
              {tagSuggestions.length > 0 && (
                <div className="doc-tag-suggestions">
                  {tagSuggestions.map(s => (
                    <button key={s} type="button" className="doc-tag-suggestion"
                      onMouseDown={e => { e.preventDefault(); addTagDraft(s) }} disabled={savingTags}>+ {s}</button>
                  ))}
                </div>
              )}
              <div className="rf-actions" style={{ marginTop: 8 }}>
                <button className="rf-btn-cancel" onClick={() => setEditingTags(false)} disabled={savingTags}>Cancel</button>
                <button className="rf-btn-save" onClick={saveTags} disabled={savingTags}>
                  {savingTags ? 'Saving…' : 'Save tags'}
                </button>
              </div>
              <div className="adshub-tag-hint">Use <code>::</code> for hierarchy. Saved tags rebuild the lineage graph.</div>
            </div>
          )}
          </div>
        </details>
      </>
    )
  }

  // Notes toggle — rendered at the right end of the code-panel header.
  function renderNotesToggle() {
    if (!selected || noteMode === 'edit') return null
    // Notes button — the existing affordance kept as-is.
    const notesBtn = selected.hasNotes && selected.notesDriveId ? (
      <>
        <button
          className={`code-btn${noteMode === 'view' ? ' active' : ''}`}
          onClick={() => {
            setNoteMode(m => m === 'view' ? 'hidden' : 'view')
            if (aiOpen) setAiOpen(false)
          }}
          title={noteMode === 'view' ? 'Hide notes' : 'Show my notes'}
        >{noteMode === 'view' ? '✕ Notes' : '📝 Notes'}</button>
        {noteMode === 'view' && (
          <button className="code-btn" onClick={startEdit} title="Edit notes">✏️</button>
        )}
      </>
    ) : (
      <button className="code-btn" onClick={startCreate} title="Add notes">➕ Notes</button>
    )
    // NEW: 🤖 AI helper + 🔊/🔇 audio mode beside Notes.
    // AI opens IN the code-panel overlay slot (same vertical column as
    // Code / Notes), so it auto-expands the panel and closes Notes for
    // mutual-exclusion.
    return (
      <>
        {notesBtn}
        <button
          className={`code-btn${aiOpen ? ' active' : ''}`}
          onClick={() => {
            setAiOpen(v => {
              const next = !v
              if (next) { setNoteMode('hidden'); setCodeCollapsed(false) }
              return next
            })
          }}
          title={aiOpen ? 'Close AI helper' : 'Ask AI about this problem'}
        >🤖 AI</button>
        <button
          className={`code-btn${audioMode ? ' active' : ''}`}
          onClick={toggleAudioMode}
          title={audioMode
            ? 'Audio ON — auto-reads each opened problem / note. Click to disable.'
            : 'Audio OFF — click to enable auto-read on prob / notes view.'}
        >{audioMode ? '🔊 Audio' : '🔇 Mute'}</button>
      </>
    )
  }

  // Notes content — shown in the code-editor space when notes are active.
  function renderNotes() {
    if (!selected || noteMode === 'hidden') return null
    if (noteMode === 'view' && selected.notesDriveId) {
      return <NoteViewer key={`${selected.notesDriveId}-${noteRev}`} driveId={selected.notesDriveId} />
    }
    if (noteMode === 'edit') {
      return (
        <div className="adshub-note-editor">
          {editorLoading ? (
            <div className="doc-viewer-state"><div className="spinner" /><span>Loading note…</span></div>
          ) : (
            <>
              <div className="adshub-editor-tabs">
                {(['rich', 'html', 'preview', 'draw'] as const).map(m => (
                  <button key={m} className={`adshub-diff-pill${editorView === m ? ' active' : ''}`} onClick={() => setEditorView(m)}>
                    {m === 'rich' ? 'Rich' : m === 'html' ? '</> HTML' : m === 'preview' ? 'Preview' : '✏️ Draw'}
                  </button>
                ))}
                {editorView !== 'draw' && (
                  <button className="adshub-diff-pill" style={{ marginLeft: 'auto' }} onClick={copyEditorHtml} title="Copy the note's HTML to the clipboard">⧉ Copy HTML</button>
                )}
              </div>
              {editorView === 'draw' && (
                <HandwritingPad key={`${selected.slug}-${hwInitialDoc ? 'edit' : 'new'}`} ref={hwPadRef} initialDoc={hwInitialDoc ?? undefined} />
              )}
              {editorView === 'rich' && (
                <RichEditor value={editorHtml} onChange={setEditorHtml} onPasteImage={handlePasteImage} allowHtmlEmbed />
              )}
              {editorView === 'html' && (
                <textarea className="rf-textarea adshub-html-editor" value={editorHtml} spellCheck={false}
                  onChange={e => setEditorHtml(e.target.value)} placeholder="<p>Paste or write raw HTML…</p>" />
              )}
              {editorView === 'preview' && (
                <div className="adshub-desc section-html-body adshub-editor-preview"
                  dangerouslySetInnerHTML={{ __html: editorHtml ? sanitizeHtml(editorHtml) : '<em style="opacity:.5">Nothing to preview</em>' }} />
              )}
              <div className="rf-actions">
                <button className="rf-btn-cancel" onClick={cancelEdit} disabled={savingNote}>Cancel</button>
                <button className="rf-btn-save" onClick={handleSaveNote} disabled={savingNote}>
                  {savingNote ? 'Saving…' : 'Save notes'}
                </button>
              </div>
            </>
          )}
        </div>
      )
    }
    return null
  }

  return (
    <div className="browse-body-wrap" ref={bodyWrapRef}>
      {/* ── Add-a-problem modal ────────────────────────────────────────── */}
      {addOpen && (
        <div className="adshub-modal-backdrop" onClick={() => setAddOpen(false)}>
          <div className="adshub-manager" onClick={e => e.stopPropagation()}>
            <div className="adshub-manager-hd">
              <span>Add a problem</span>
              <button className="detail-close-btn" onClick={() => setAddOpen(false)}>✕</button>
            </div>
            <div className="adshub-add-form">
              <label>Id (#) *
                <input className="rf-input" value={addForm.frontendId} onChange={e => setAdd('frontendId', e.target.value)} placeholder="LC # or 10000+ for custom" disabled={addBusy} autoFocus />
              </label>
              <label>Difficulty
                <select className="rf-input" value={addForm.difficulty} onChange={e => setAdd('difficulty', e.target.value)} disabled={addBusy}>
                  {['Easy', 'Medium', 'Hard'].map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <label className="adshub-add-full">Title *
                <input className="rf-input" value={addForm.title} onChange={e => setAdd('title', e.target.value)} placeholder="Problem title" disabled={addBusy} />
              </label>
              <label className="adshub-add-full">Slug
                <input className="rf-input" value={addForm.slug} onChange={e => setAdd('slug', e.target.value)} placeholder={slugify(addForm.title) || 'auto from title'} disabled={addBusy} />
              </label>
              <label>Topics
                <input className="rf-input" value={addForm.topics} onChange={e => setAdd('topics', e.target.value)} placeholder="Array; Hash Table" disabled={addBusy} />
              </label>
              <label>Companies
                <input className="rf-input" value={addForm.companies} onChange={e => setAdd('companies', e.target.value)} placeholder="Amazon; Google" disabled={addBusy} />
              </label>
              <label className="adshub-add-full">Tags (:: lineage)
                <input className="rf-input" value={addForm.tags} onChange={e => setAdd('tags', e.target.value)} placeholder="_ds::array::subset; _prob::sum::pair" disabled={addBusy} />
              </label>
              <label className="adshub-add-full">LeetCode URL
                <input className="rf-input" value={addForm.leetcodeUrl} onChange={e => setAdd('leetcodeUrl', e.target.value)} placeholder="auto: https://leetcode.com/problems/<slug>/" disabled={addBusy} />
              </label>
              <label className="adshub-add-full">Description
                <textarea className="rf-textarea" rows={5} value={addForm.description} onChange={e => setAdd('description', e.target.value)} placeholder="Plain text or HTML…" disabled={addBusy} />
              </label>
              {addErr && <div className="login-error adshub-add-full">{addErr}</div>}
              <div className="rf-actions adshub-add-full">
                <button className="rf-btn-cancel" onClick={() => setAddOpen(false)} disabled={addBusy}>Cancel</button>
                <button className="rf-btn-save" onClick={saveNewProblem} disabled={addBusy}>{addBusy ? 'Saving…' : 'Add problem'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── List Manager modal ─────────────────────────────────────────── */}
      {managerOpen && (
        <div className="adshub-modal-backdrop" onClick={() => setManagerOpen(false)}>
          <div className="adshub-manager" onClick={e => e.stopPropagation()}>
            <div className="adshub-manager-hd">
              <span>{managerName ? 'Manage list' : 'New list'}</span>
              <button className="detail-close-btn" onClick={() => setManagerOpen(false)}>✕</button>
            </div>

            {/* Name (create / rename) */}
            <div className="adshub-manager-name">
              <input
                className="rf-input"
                placeholder="List name…"
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveListName() }}
                disabled={managerBusy}
                autoFocus
              />
              {managerName && nameDraft.trim() && nameDraft.trim() !== managerName && (
                <button className="rf-btn-save" onClick={saveListName} disabled={managerBusy}>Rename</button>
              )}
              {managerName && (
                <button className="doc-edit-delete-btn" style={{ marginLeft: 'auto' }} onClick={() => deleteList(managerName)} disabled={managerBusy} title="Delete this list">🗑</button>
              )}
            </div>

            {/* Add problems by #id / title */}
            <div className="adshub-manager-add">
              <input
                className="col-search"
                placeholder="Add a problem — search #id or title…"
                value={probQuery}
                onChange={e => setProbQuery(e.target.value)}
              />
              {probResults.length > 0 && (
                <ul className="adshub-prob-results">
                  {probResults.map(p => (
                    <li key={p.slug} onClick={() => addProblemToList(p.slug)} title="Add to list">
                      <span className={`adshub-diff-dot ${diffClass(p.difficulty)}`} />
                      <span className="adshub-pid">#{p.frontendId}</span>
                      <span className="adshub-prob-title">{p.title}</span>
                      <span className="adshub-prob-add">＋</span>
                    </li>
                  ))}
                </ul>
              )}
              {probQuery.trim() && probResults.length === 0 && (
                <div className="col-empty">No matching problems (or already in the list)</div>
              )}
            </div>

            {/* Members */}
            <div className="adshub-manager-members">
              <div className="detail-section-hd" style={{ padding: '6px 0' }}>
                In this list <span className="tree-cnt">{managedProblems.length}</span>
              </div>
              {managedProblems.length === 0 ? (
                <div className="col-empty">{managerName ? 'Empty — add problems above.' : 'Name the list, then add problems above.'}</div>
              ) : (
                <ul className="adshub-prob-results">
                  {managedProblems.map(p => (
                    <li key={p.slug}>
                      <span className={`adshub-diff-dot ${diffClass(p.difficulty)}`} />
                      <span className="adshub-pid">#{p.frontendId}</span>
                      <span className="adshub-prob-title">{p.title}</span>
                      <button className="adshub-list-del" onClick={() => removeProblemFromList(p.slug)} disabled={managerBusy} title="Remove">×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Left: Tags / Companies / MyList */}
      <div
        className={`browse-col-tags${sidebarHidden ? ' collapsed' : ''}`}
        style={sidebarHidden ? undefined : { width: `${tagsRatio}%` }}
      >
        <AdsHubSidebar
          problems={problems}
          selectedTags={selectedTags}
          onToggleTag={toggleTag}
          selectedCompanies={selectedCompanies}
          onToggleCompany={toggleCompany}
          lists={lists}
          selectedList={selectedList}
          onSelectList={setSelectedList}
          onDeleteList={deleteList}
          onCreateList={openCreateList}
          onManageList={openManageList}
          collapsed={sidebarHidden}
          onCollapse={() => { if (viewerExpanded) setViewerExpanded(false); else setLeftColl(c => !c) }}
        />
      </div>
      {/* Sidebar/main draggable divider */}
      {!sidebarHidden && (
        <div
          className="qa-divider"
          onPointerDown={startLeftDrag}
          onPointerMove={moveLeftDrag}
          onPointerUp={endLeftDrag}
          onPointerCancel={endLeftDrag}
          onDoubleClick={() => setTagsRatio(r => r <= 13 ? 20 : 12)}
          title="Drag to resize · double-click to widen the main area"
        />
      )}
      {!leftCollapsed && <div className="drawer-backdrop" onClick={() => setLeftColl(true)} />}

      {/* Main: list + detail */}
      <div className="browse-main">
        <div className="browse-toolbar">
          <div className="adshub-diff-pills" style={{ marginRight: 4 }}>
            <button
              className={`adshub-diff-pill${adsMode === 'browse' ? ' active' : ''}`}
              onClick={() => setAdsMode('browse')}
            >📋 Browse</button>
            <button
              className={`adshub-diff-pill${adsMode === 'lineage' ? ' active' : ''}`}
              onClick={() => setAdsMode('lineage')}
            >🌳 Lineage</button>
            {/* Patterns mode — renders the standalone reference
                (public/patterns.html) inline in the same right pane via
                iframe, matching how 🌳 Lineage embeds its visualizer.
                Clicking Patterns ALSO dismisses any selected problem so
                the iframe takes the full width — a previously-opened
                Browse selection shouldn't squeeze the reference. Anchor
                clicks INSIDE the iframe still set `selected` again via
                the postMessage handler. */}
            <button
              className={`adshub-diff-pill${adsMode === 'patterns' ? ' active' : ''}`}
              onClick={() => { setAdsMode('patterns'); setSelected(null) }}
              title="DS → micro-pattern reference"
            >📐 Patterns</button>
          </div>
          {adsMode === 'browse' && <>
          <button
            className={`mobile-filter-btn${activeFilterCount > 0 ? ' has-active' : ''}`}
            onClick={() => setLeftColl(false)}
            title="Filters"
          >
            ☰ Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </button>
          {/* Multi-select dropdown: difficulty + ✨ Custom in one pill so
              the toolbar stays compact. Empty diff ≡ All. Auto-applies on
              every checkbox toggle. Click outside (or the trigger again)
              to close. */}
          <div className="adshub-diff-menu-wrap" ref={diffMenuRef}>
            <button
              className={`adshub-diff-pill${diff.length > 0 || customOnly ? ' active' : ''}`}
              onClick={() => setDiffMenuOpen(o => !o)}
              title="Filter by difficulty / custom"
              aria-haspopup="true"
              aria-expanded={diffMenuOpen}
            >
              {diff.length === 0 && !customOnly ? 'All' : [
                diff.length === 0 ? null : diff.join(', '),
                customOnly ? '✨ Custom' : null,
              ].filter(Boolean).join(' · ')}
              <span style={{ marginLeft: 6, opacity: .6 }}>▾</span>
            </button>
            {diffMenuOpen && (
              <div className="adshub-diff-menu" role="menu">
                {DIFFS.map(d => (
                  <label key={d} className={`adshub-diff-menu-item ${diffClass(d)}`}>
                    <input
                      type="checkbox"
                      checked={diff.includes(d)}
                      onChange={() => setDiff(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])}
                    />
                    <span>{d}</span>
                  </label>
                ))}
                <div className="adshub-diff-menu-sep" />
                <label className="adshub-diff-menu-item">
                  <input
                    type="checkbox"
                    checked={customOnly}
                    onChange={() => setCustomOnly(v => !v)}
                  />
                  <span title="Custom problems live at frontend_id ≥ 10000">✨ Custom only</span>
                </label>
                {(diff.length > 0 || customOnly) && (
                  <button
                    className="adshub-diff-menu-clear"
                    onClick={() => { setDiff([]); setCustomOnly(false) }}
                  >Clear</button>
                )}
              </div>
            )}
          </div>
          <input
            className="col-search"
            style={{ width: 220 }}
            placeholder="Search #id, title, tag, company…  ↵ to open top match"
            value={search}
            onChange={e => handleSearchChange(e.target.value)}
            onKeyDown={e => {
              // Enter opens the top filtered match (already auto-selected
              // when there's exactly one, but this gives a clear path when
              // there are multiple — the user picks the top result without
              // touching the list).
              if (e.key === 'Enter' && filtered.length > 0) {
                e.preventDefault()
                setSelected(filtered[0])
              }
            }}
          />
          <button
            className="rf-btn-cancel"
            onClick={refresh}
            disabled={refreshing || loading}
            title="Reload problems from the sheet"
          >{refreshing ? '…' : '↻'}</button>
          <button
            className="rf-btn-save"
            onClick={openAddProblem}
            title="Add a new problem"
            aria-label="Add a new problem"
          >＋</button>
          <button
            className="rf-btn-cancel"
            onClick={exportFilteredCsv}
            disabled={loading || filtered.length === 0}
            title={`Export the ${filtered.length.toLocaleString()} currently-filtered problem${filtered.length === 1 ? '' : 's'} as CSV (id, title, difficulty, topics, tags, slug, statement)`}
            aria-label="Export CSV"
          >⬇</button>
          <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
            {filtered.length.toLocaleString()} / {problems.length.toLocaleString()}
          </span>
          {activeFilterCount > 0 && (
            <div className="applied-filter-chips">
              {selectedTags.map(t => (
                <span key={`t-${t}`} className="applied-chip tag-chip" title={t}>
                  <span className="chip-label">⊞ {t}</span>
                  <button className="chip-rm" onClick={() => toggleTag(t)}>×</button>
                </span>
              ))}
              {selectedCompanies.map(c => (
                <span key={`c-${c}`} className="applied-chip tag-chip" title={c}>
                  <span className="chip-label">🏢 {c}</span>
                  <button className="chip-rm" onClick={() => toggleCompany(c)}>×</button>
                </span>
              ))}
              {selectedList && (
                <span className="applied-chip tag-chip" title={selectedList}>
                  <span className="chip-label">★ {selectedList}</span>
                  <button className="chip-rm" onClick={() => setSelectedList(null)}>×</button>
                </span>
              )}
              <button className="col-hd-clear" onClick={clearAllFilters}>Clear all</button>
            </div>
          )}
          </>}
        </div>

        {adsMode === 'lineage' ? (
          <AdsLineage
            problems={problems}
            focusNum={lineageFocus}
            onOpenProblem={num => {
              const p = problems.find(x => x.frontendId === String(num) || x.frontendId === String(Number(num)))
              if (p) { setSelected(p); setAdsMode('browse') }
            }}
          />
        ) : (
        /* Shared split layout for BOTH Browse and Patterns modes. In
           Patterns mode the left column hosts the iframe (always mounted
           — selecting a problem doesn't reload it); the right column
           shows the same detail pane Browse uses. In Browse the left
           column is the toolbar+table as before. */
        <div className="browse-cards-split" ref={splitRef}>
          {/* Left column — Patterns iframe (mode==='patterns') OR problem
              list (mode==='browse'). Hidden when detail is maximized. */}
          {!viewerExpanded && (
          <div
            className="browse-col-cards"
            style={{
              ...(selected ? { flex: `0 0 ${listRatio}%` } : {}),
              // Patterns mode: make the column a flex container so the
              // <iframe flex:1> can fill remaining vertical space, and
              // drop the column's own overflow:auto (iframe scrolls).
              ...(adsMode === 'patterns'
                ? { display: 'flex', flexDirection: 'column', overflow: 'hidden', maxHeight: 'calc(100vh - 56px)' }
                : {}),
            }}
          >
            {adsMode === 'patterns' ? (
              <>
                {/* Small header strip so the section has a doc-detail-hd-style
                    affordance: double-click snaps the list↔detail divider
                    (widen the iframe / restore split). Mirrors the detail
                    pane's header doubleclick. */}
                <div
                  className="col-hd doc-detail-hd"
                  style={{ padding: '10px 12px', flexShrink: 0 }}
                  onDoubleClick={() => setListRatio(r => r >= 78 ? 60 : 85)}
                  title="📐 Patterns Reference — double-click to widen / restore"
                >
                  <span>📐 Patterns Reference</span>
                </div>
                <iframe
                  title="Micro-Pattern Reference"
                  src={`${import.meta.env.BASE_URL}patterns.html`}
                  style={{ width: '100%', flex: 1, minHeight: 0, border: 0 }}
                />
              </>
            ) : loading ? (
              <div className="browse-stream-init">
                <div className="browse-stream-spinner" />
                <span>Loading…</span>
              </div>
            ) : filtered.length === 0 ? (
              <div className="done-state">
                <div className="done-icon">🧠</div>
                <h3>No problems {problems.length ? 'match' : 'yet'}</h3>
                <p>{problems.length
                  ? 'Try clearing the lineage filter or search.'
                  : 'Run scripts/ads-to-sheets.mjs --write to populate the archive.'}</p>
              </div>
            ) : (
              <ul className="doc-list">
                {shown.map(p => {
                  const isSel = selected?.slug === p.slug
                  return (
                    <li
                      key={p.slug}
                      className={`doc-list-item${isSel ? ' sel' : ''}`}
                      onClick={() => setSelected(prev => prev?.slug === p.slug ? null : p)}
                    >
                      <div className="doc-list-title">
                        <span className={`adshub-diff-dot ${diffClass(p.difficulty)}`} />
                        {p.frontendId && <span className="adshub-pid">#{p.frontendId}</span>}
                        {p.title}
                        {p.hasNotes && <span className="adshub-note-badge" title="Has notes">✎</span>}
                      </div>
                      {p.topics.length > 0 && (
                        <div className="doc-list-meta">{p.topics.join(' · ')}</div>
                      )}
                      {p.tags.length > 0 && (
                        <div className="doc-list-tags">
                          {p.tags.map(t => (
                            <span key={t} className="tag" title={t}>{t.split('::').pop()}</span>
                          ))}
                        </div>
                      )}
                    </li>
                  )
                })}
                {filtered.length > LIST_CAP && (
                  <li className="adshub-more-note">
                    Showing first {LIST_CAP} of {filtered.length.toLocaleString()} — refine the filter to see more.
                  </li>
                )}
              </ul>
            )}
          </div>
          )}

          {/* List/detail draggable divider — only when both panes show */}
          {selected && !viewerExpanded && (
            <div
              className="qa-divider"
              onPointerDown={startListDrag}
              onPointerMove={moveListDrag}
              onPointerUp={endListDrag}
              onPointerCancel={endListDrag}
              onDoubleClick={() => setListRatio(r => r <= 18 ? 40 : 15)}
              title="Drag to resize · double-click to widen the detail"
            />
          )}

          {/* Detail pane */}
          {selected && (
            <div className="browse-col-detail has-selection" style={{ flex: 1 }}>
              <div
                className="col-hd doc-detail-hd"
                style={{ padding: '10px 12px', flexShrink: 0, position: 'relative' }}
                onDoubleClick={() => setListRatio(r => r <= 18 ? 40 : 15)}
                title="Double-click to widen / restore the detail pane"
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selected.frontendId && <>#{selected.frontendId} · </>}{selected.title}
                </span>
                <span
                  className={`doc-detail-timer${
                    timerSec >= 20 * 60 ? ' warn danger blink' :
                    timerSec >= 15 * 60 ? ' warn danger' :
                    timerSec >= 10 * 60 ? ' warn' : ''
                  }`}
                  title="Time on this problem (resets when you switch)"
                >{Math.floor(timerSec / 60)}:{String(timerSec % 60).padStart(2, '0')}</span>
                <div style={{ display: 'flex', gap: 6, position: 'relative' }} onDoubleClick={e => e.stopPropagation()}>
                  {/* Notes toggle now lives in the code-panel header (right end). */}
                  {/* ★ Add to list */}
                  <button
                    className={`bci-edit-btn bci-edit-btn-hd${listsForSelected.length ? ' active' : ''}`}
                    onClick={() => setListMenuOpen(o => !o)}
                    title="Add to a list"
                  >{listsForSelected.length ? '★' : '☆'}</button>
                  {listMenuOpen && (
                    <div className="adshub-list-menu" onMouseLeave={() => setListMenuOpen(false)}>
                      <div className="adshub-list-menu-hd">Add to list</div>
                      {lists.length === 0 && <div className="adshub-list-menu-empty">No lists yet</div>}
                      {lists.map(l => {
                        const inList = listsForSelected.includes(l.name)
                        return (
                          <button key={l.name} className="adshub-list-menu-item" onClick={() => toggleMembership(l.name)}>
                            <span>{inList ? '☑' : '☐'} {l.name}</span>
                            <span className="tree-cnt">{l.slugs.length}</span>
                          </button>
                        )
                      })}
                      <div className="adshub-list-menu-new">
                        <input
                          className="rf-input"
                          placeholder="New list…"
                          value={newListName}
                          onChange={e => setNewListName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') createListWithSelected() }}
                        />
                        <button className="rf-btn-save" onClick={createListWithSelected} disabled={!newListName.trim()}>Add</button>
                      </div>
                    </div>
                  )}
                  <button
                    className="bci-edit-btn bci-edit-btn-hd"
                    onClick={() => { setLineageFocus(Number(selected.frontendId)); setAdsMode('lineage') }}
                    title="Show in lineage graph"
                  >🌳</button>
                  {selected.leetcodeUrl && (
                    <a
                      className="bci-edit-btn bci-edit-btn-hd"
                      href={selected.leetcodeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open on LeetCode"
                    >↗</a>
                  )}
                  <button
                    className={`bci-edit-btn bci-edit-btn-hd${viewerExpanded ? ' active' : ''}`}
                    onClick={() => setViewerExpanded(v => !v)}
                    title={viewerExpanded ? 'Restore list' : 'Maximize'}
                  >{viewerExpanded ? '⤡' : '⤢'}</button>
                  {/* Audio reader in the header — sits next to the other
                      header icons. Re-mounts (and auto-plays) on every
                      selection OR notes-toggle change. */}
                  {audioMode && (
                    <span className="adshub-hd-audio">
                      <AudioReader
                        key={`prob-${selected.slug}-${noteMode === 'view' ? 'N' : 'Q'}`}
                        text={htmlToSpokenText(
                          noteMode === 'view' && notesPlainText
                            ? notesPlainText
                            : (selected.descriptionHtml || ''))}
                        autoPlay
                        label={noteMode === 'view' ? 'N' : 'Q'}
                      />
                    </span>
                  )}
                  <button className="detail-close-btn" onClick={() => setSelected(null)}>✕</button>
                </div>
              </div>

              <div className="adshub-detail-body">
                {/* Details (left, with meta+tags) + code panel (right). Notes,
                    when toggled, take over the code-editor space. */}
                <div className="adshub-desc-code-split" ref={descCodeRef}>
                  <div className="adshub-desc-col">
                    {renderMeta()}
                    {selected.descriptionHtml ? (
                      <div
                        className="adshub-desc section-html-body"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(selected.descriptionHtml) }}
                      />
                    ) : (
                      <div className="section-empty-val">No description.</div>
                    )}
                    {/* AudioReader → renderMeta() (header chips row).
                        AI chat → CodePanel overlay (right vertical
                        section, alongside Code / Notes). Both moved out
                        of this column to keep description full-height. */}
                    {selected.companies.length > 0 && (
                      // key per slug → reopens collapsed for each problem ("on load" collapsed)
                      <details className="adshub-companies" key={selected.slug}>
                        <summary className="adshub-companies-summary">
                          Companies <span className="tree-cnt">{selected.companies.length}</span>
                        </summary>
                        <div className="adshub-company-chips">
                          {selected.companies.map(c => (
                            <span
                              key={c}
                              className={`tag${selected.companiesRecent.includes(c) ? ' adshub-company-recent' : ''}`}
                              title={selected.companiesRecent.includes(c) ? 'Asked in the last 6 months' : c}
                            >{c}</span>
                          ))}
                        </div>
                      </details>
                    )}
                    <div className="adshub-end-footer">· end of problem ·</div>
                  </div>
                  {!codeCollapsed && (
                    <div
                      className="qa-divider"
                      onPointerDown={startCodeDrag}
                      onPointerMove={moveCodeDrag}
                      onPointerUp={endCodeDrag}
                      onPointerCancel={endCodeDrag}
                      onDoubleClick={() => setCodeRatio(r => r >= 70 ? 42 : 75)}
                      title="Drag to resize · double-click to widen the code panel"
                    />
                  )}
                  <div
                    className={`adshub-code-col${codeCollapsed ? ' collapsed' : ''}`}
                    style={codeCollapsed ? { flex: '0 0 48px' } : { flex: `0 0 ${codeRatio}%` }}
                  >
                    {codeCollapsed ? (
                      <div className="adshub-code-strip">
                        <button className="adshub-strip-btn" onClick={openCode} title="Show code">
                          <span>{'{ }'}</span><span className="adshub-strip-lbl">Code</span>
                        </button>
                        <button className="adshub-strip-btn" onClick={openNotes} title="Show notes">
                          <span>📝</span><span className="adshub-strip-lbl">Notes</span>
                        </button>
                        <button
                          className={`adshub-strip-btn${aiOpen ? ' active' : ''}`}
                          onClick={() => {
                            setAiOpen(true)
                            setNoteMode('hidden')
                            setCodeCollapsed(false)
                          }}
                          title="Ask AI about this problem"
                        ><span>🤖</span><span className="adshub-strip-lbl">AI</span></button>
                        <button
                          className={`adshub-strip-btn${audioMode ? ' active' : ''}`}
                          onClick={toggleAudioMode}
                          title={audioMode
                            ? 'Audio ON — auto-reads each opened problem / note. Click to disable.'
                            : 'Audio OFF — click to enable auto-read on prob / notes view.'}
                        ><span>{audioMode ? '🔊' : '🔇'}</span><span className="adshub-strip-lbl">{audioMode ? 'Audio' : 'Mute'}</span></button>
                      </div>
                    ) : (
                      <CodePanel
                        key={selected.slug}
                        slug={selected.slug}
                        onHeaderDoubleClick={() => setCodeRatio(r => r >= 70 ? 42 : 75)}
                        headerRight={<>
                          {renderNotesToggle()}
                          <button className="code-btn" onClick={() => setCodeCollapsed(true)} title="Collapse">⊟</button>
                        </>}
                        // Right-column overlay precedence:
                        //   1) AI chat (highest — explicit user toggle)
                        //   2) Notes view / edit
                        //   3) Code (the default beneath everything)
                        // Mutual-exclusion is enforced in the button
                        // handlers (renderNotesToggle below).
                        overlay={
                          aiOpen ? (
                            <ProblemAIChat
                              problemTitle={selected.title}
                              problemHtml={selected.descriptionHtml || ''}
                              notesPlain={notesPlainText || undefined}
                              onClose={() => setAiOpen(false)}
                            />
                          ) : noteMode !== 'hidden' ? renderNotes() : undefined
                        }
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
