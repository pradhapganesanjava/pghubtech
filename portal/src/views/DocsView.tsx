import { useEffect, useMemo, useRef, useState } from 'react'
import { GAuth } from '../lib/gauth'
import {
  getOrCreateFolder,
  uploadFileToDrive,
  deleteDriveFile,
} from '../lib/drive'
import {
  appendDoc, deleteDocRow, loadDocs, updateDoc,
} from '../adapters/docsRepo'
import type { DocRecord } from '../adapters/docsRepo'
import DocTagTree from '../components/DocTagTree'
import DocViewer from '../components/DocViewer'
import DocUploadModal from '../components/DocUploadModal'
import { useToast } from '../components/Toast'

const DOCS_FOLDER = 'PGHubTechDocs'
const ACCEPT      = '.html,.htm,.md,.markdown,.pdf,.txt,text/*,application/pdf'

function fmtSize(n: number): string {
  if (n < 1024)        return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString()
}

export default function DocsView() {
  const { toast } = useToast()
  const [docs, setDocs]                 = useState<DocRecord[]>([])
  const [loading, setLoading]           = useState(true)
  const [refreshing, setRefreshing]     = useState(false)
  const [selected, setSelected]         = useState<DocRecord | null>(null)
  const [search, setSearch]             = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  // Default closed on phones (drawer pattern), open on desktops.
  const [leftCollapsed, setLeftColl]    = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  )

  const [pickedFile, setPickedFile]     = useState<File | null>(null)
  const [editing, setEditing]           = useState(false)
  const [editAlias, setEditAlias]       = useState('')
  const [editTags, setEditTags]         = useState<string>('')
  const [editBusy, setEditBusy]         = useState(false)
  const [editErr, setEditErr]           = useState('')

  const [listRatio, setListRatio]           = useState(35)
  const [viewerExpanded, setViewerExpanded] = useState(false)
  const [tagsRatio, setTagsRatio]           = useState(18)

  const fileInputRef       = useRef<HTMLInputElement>(null)
  const splitContainerRef  = useRef<HTMLDivElement>(null)
  const bodyWrapRef        = useRef<HTMLDivElement>(null)
  const isDraggingRef      = useRef(false)
  const isLeftDraggingRef  = useRef(false)

  // Whenever the selection changes (different doc OR closed), drop the edit
  // state so the new selection always lands on the read-only viewer.
  useEffect(() => {
    setEditing(false)
    setEditAlias('')
    setEditTags('')
    setEditErr('')
    setEditBusy(false)
  }, [selected?.id])

  // ── Load on mount ─────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      try {
        const list = await loadDocs()
        setDocs(list)
      } catch (e) {
        toast(`Failed to load docs: ${(e as Error).message}`, 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Manual refresh — picks up rows added by other paths (e.g. AI chat
  // panel "Save as doc") without reloading the whole page.
  async function reloadDocs() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const list = await loadDocs()
      const before = docs.length
      setDocs(list)
      const delta = list.length - before
      if (delta > 0)      toast(`${delta} new doc${delta === 1 ? '' : 's'}`, 'success')
      else if (delta < 0) toast(`${-delta} doc${delta === -1 ? '' : 's'} removed`, 'info')
      else                toast('Up to date', 'info')
    } catch (e) {
      toast(`Refresh failed: ${(e as Error).message}`, 'error')
    } finally {
      setRefreshing(false)
    }
  }

  // ── Draggable list/viewer divider ─────────────────────────────────────────
  function handleDividerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    isDraggingRef.current = true
    document.body.classList.add('resizing-h')
  }
  function handleDividerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDraggingRef.current) return
    const c = splitContainerRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    const pct = ((e.clientX - r.left) / r.width) * 100
    setListRatio(Math.min(Math.max(pct, 15), 70))
  }
  function handleDividerUp(e: React.PointerEvent<HTMLDivElement>) {
    isDraggingRef.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  // ── Draggable left/main divider ───────────────────────────────────────────
  function handleLeftDividerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    isLeftDraggingRef.current = true
    document.body.classList.add('resizing-h')
  }
  function handleLeftDividerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isLeftDraggingRef.current) return
    const c = bodyWrapRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    const pct = ((e.clientX - r.left) / r.width) * 100
    setTagsRatio(Math.min(Math.max(pct, 12), 45))
  }
  function handleLeftDividerUp(e: React.PointerEvent<HTMLDivElement>) {
    isLeftDraggingRef.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('resizing-h')
  }

  // Reset expanded state when selection clears so a fresh open of any doc
  // starts from the normal split layout.
  useEffect(() => {
    if (!selected) setViewerExpanded(false)
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Filtering ─────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    return docs.filter(d => {
      if (selectedTags.length > 0) {
        const ok = selectedTags.every(st =>
          d.tags.some(t => t === st || t.startsWith(st + '::')),
        )
        if (!ok) return false
      }
      if (s) {
        const hay = `${d.alias} ${d.filename} ${d.tags.join(' ')}`.toLowerCase()
        if (!hay.includes(s)) return false
      }
      return true
    })
  }, [docs, selectedTags, search])

  const knownTags = useMemo(() => {
    const set = new Set<string>()
    for (const d of docs) for (const t of d.tags) set.add(t)
    return [...set].sort()
  }, [docs])

  // ── Upload flow ───────────────────────────────────────────────────────────
  function pickFile() { fileInputRef.current?.click() }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) setPickedFile(f)
    e.target.value = ''  // allow re-picking the same file
  }

  async function doUpload(alias: string, tags: string[]) {
    if (!pickedFile) return
    const token = GAuth.getToken()
    if (!token) throw new Error('Not signed in')
    const folderId = await getOrCreateFolder(token, DOCS_FOLDER)
    const { id }   = await uploadFileToDrive(
      token, folderId, pickedFile, pickedFile.name,
      pickedFile.type || 'application/octet-stream',
    )
    const rec: DocRecord = {
      id,
      alias,
      filename:  pickedFile.name,
      mime:      pickedFile.type || 'application/octet-stream',
      size:      pickedFile.size,
      tags,
      createdAt: new Date().toISOString(),
    }
    await appendDoc(rec)
    setDocs(prev => [...prev, rec])
    setPickedFile(null)
    setSelected(rec)
    toast('Doc uploaded', 'success')
  }

  // ── Edit / delete the currently-selected doc ──────────────────────────────
  function startEdit() {
    if (!selected) return
    setEditAlias(selected.alias)
    setEditTags(selected.tags.join(', '))
    setEditErr('')
    setEditing(true)
  }
  async function saveEdit() {
    if (!selected) return
    const updated: DocRecord = {
      ...selected,
      alias: editAlias.trim() || selected.alias,
      tags:  editTags.split(',').map(t => t.trim()).filter(Boolean),
    }
    setEditBusy(true); setEditErr('')
    try {
      await updateDoc(updated)
      setDocs(prev => prev.map(d => d.id === updated.id ? updated : d))
      setSelected(updated)
      setEditing(false)
      toast('Doc updated', 'success')
    } catch (e) {
      const msg = (e as Error).message
      setEditErr(msg)
      toast(`Save failed: ${msg}`, 'error')
    } finally {
      setEditBusy(false)
    }
  }
  async function doDelete() {
    if (!selected) return
    if (!window.confirm(`Delete "${selected.alias}"? This removes the Drive file too.`)) return
    const target = selected
    setEditBusy(true); setEditErr('')
    try {
      const token = GAuth.getToken()
      if (!token) throw new Error('Not signed in')
      await deleteDriveFile(token, target.id).catch(() => { /* keep going */ })
      await deleteDocRow(target.id)
      setDocs(prev => prev.filter(d => d.id !== target.id))
      setSelected(null)
      setEditing(false)
      toast('Doc deleted', 'success')
    } catch (e) {
      const msg = (e as Error).message
      setEditErr(msg)
      toast(`Delete failed: ${msg}`, 'error')
    } finally {
      setEditBusy(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="browse-body-wrap" ref={bodyWrapRef}>
      {/* Hidden file input drives the upload picker */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={onFilePicked}
      />
      {pickedFile && (
        <DocUploadModal
          file={pickedFile}
          knownTags={knownTags}
          onCancel={() => setPickedFile(null)}
          onConfirm={doUpload}
        />
      )}

      {/* When the viewer is expanded, force the left panel to collapse so the
          doc gets the entire main-column width. The user's own collapsed
          preference (leftCollapsed) is preserved underneath and is restored
          when they un-expand.
          Left: tag tree (resizable) */}
      <div
        className={`browse-col-tags${(leftCollapsed || viewerExpanded) ? ' collapsed' : ''}`}
        style={(leftCollapsed || viewerExpanded) ? undefined : { width: `${tagsRatio}%` }}
      >
        <DocTagTree
          docs={docs}
          selectedTags={selectedTags}
          onToggleTag={t =>
            setSelectedTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
          }
          onClearAll={() => setSelectedTags([])}
          collapsed={leftCollapsed || viewerExpanded}
          onCollapse={() => {
            // If we're forced-collapsed because the viewer is expanded,
            // clicking the strip should restore the full split layout.
            if (viewerExpanded) {
              setViewerExpanded(false)
              setLeftColl(false)
            } else {
              setLeftColl(c => !c)
            }
          }}
        />
      </div>

      {/* Draggable divider between left tags and the main column — hidden
          whenever the left panel is in its collapsed strip form. */}
      {!(leftCollapsed || viewerExpanded) && (
        <div
          className="qa-divider"
          onPointerDown={handleLeftDividerDown}
          onPointerMove={handleLeftDividerMove}
          onPointerUp={handleLeftDividerUp}
          onPointerCancel={handleLeftDividerUp}
        />
      )}

      {/* Mobile-only backdrop — tap closes the tag drawer */}
      {!leftCollapsed && (
        <div className="drawer-backdrop" onClick={() => setLeftColl(true)} />
      )}

      {/* Main: list + viewer */}
      <div className="browse-main">
        <div className="browse-toolbar">
          <button
            className={`mobile-filter-btn${selectedTags.length > 0 ? ' has-active' : ''}`}
            onClick={() => setLeftColl(false)}
            title="Filter by tag"
          >
            ☰ Filter{selectedTags.length > 0 ? ` (${selectedTags.length})` : ''}
          </button>
          <button className="rf-btn-save" onClick={pickFile} style={{ marginLeft: 0 }}>
            ＋ Upload
          </button>
          <button
            className="rf-btn-cancel"
            onClick={reloadDocs}
            disabled={refreshing || loading}
            title="Reload Docs from the sheet (picks up files saved by AI chat)"
          >{refreshing ? '…' : '↻'} Refresh</button>
          <input
            className="col-search"
            style={{ width: 240 }}
            placeholder="Search docs…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
            {filtered.length.toLocaleString()} / {docs.length.toLocaleString()} docs
          </span>
          {selectedTags.length > 0 && (
            <div className="applied-filter-chips">
              {selectedTags.map(t => (
                <span key={t} className="applied-chip tag-chip" title={t}>
                  <span className="chip-label">{t}</span>
                  <button className="chip-rm" onClick={() => setSelectedTags(prev => prev.filter(x => x !== t))}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="browse-cards-split" ref={splitContainerRef}>
          {/* Doc list — hidden when viewer is expanded */}
          {!viewerExpanded && (
          <div
            className="browse-col-cards"
            style={selected ? { flex: `0 0 ${listRatio}%` } : undefined}
          >
            {loading ? (
              <div className="browse-stream-init">
                <div className="browse-stream-spinner" />
                <span>Loading…</span>
              </div>
            ) : filtered.length === 0 ? (
              <div className="done-state">
                <div className="done-icon">📄</div>
                <h3>No docs {docs.length ? 'match' : 'yet'}</h3>
                <p>{docs.length ? 'Try clearing filters or search.' : 'Click ＋ Upload to add one.'}</p>
              </div>
            ) : (
              <ul className="doc-list">
                {filtered.map(d => {
                  const isSel = selected?.id === d.id
                  return (
                    <li
                      key={d.id}
                      className={`doc-list-item${isSel ? ' sel' : ''}`}
                      onClick={() => setSelected(prev => prev?.id === d.id ? null : d)}
                    >
                      <div className="doc-list-title">{d.alias || d.filename}</div>
                      <div className="doc-list-meta">
                        <span>{d.filename}</span>
                        <span>·</span>
                        <span>{fmtSize(d.size)}</span>
                        {d.createdAt && <><span>·</span><span>{fmtDate(d.createdAt)}</span></>}
                      </div>
                      {d.tags.length > 0 && (
                        <div className="doc-list-tags">
                          {d.tags.map(t => (
                            <span key={t} className="tag" title={t}>{t.split('::').pop()}</span>
                          ))}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          )}

          {/* Draggable list/viewer divider — only when both panes are showing */}
          {selected && !viewerExpanded && (
            <div
              className="qa-divider"
              onPointerDown={handleDividerDown}
              onPointerMove={handleDividerMove}
              onPointerUp={handleDividerUp}
              onPointerCancel={handleDividerUp}
            />
          )}

          {/* Viewer pane */}
          {selected && (
            <div className="browse-col-detail has-selection" style={{ flex: 1 }}>
              <div
                className="col-hd doc-detail-hd"
                style={{ padding: '10px 12px', flexShrink: 0 }}
                onDoubleClick={() => setViewerExpanded(v => !v)}
                title="Double-click to expand / restore"
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {editing ? 'Edit doc' : (selected.alias || selected.filename)}
                </span>
                <div
                  style={{ display: 'flex', gap: 6 }}
                  onDoubleClick={e => e.stopPropagation()}
                >
                  {!editing && (
                    <button
                      className="bci-edit-btn bci-edit-btn-hd"
                      onClick={startEdit}
                      title="Edit tags / alias"
                    >✎</button>
                  )}
                  <button
                    className={`bci-edit-btn bci-edit-btn-hd${viewerExpanded ? ' active' : ''}`}
                    onClick={() => setViewerExpanded(v => !v)}
                    title={viewerExpanded ? 'Show list' : 'Expand viewer'}
                  >{viewerExpanded ? '⤡' : '⤢'}</button>
                  <button className="detail-close-btn" onClick={() => setSelected(null)}>✕</button>
                </div>
              </div>

              {editing ? (
                <div className="doc-edit-form">
                  <label className="rf-label">Alias</label>
                  <input
                    className="rf-input"
                    value={editAlias}
                    onChange={e => setEditAlias(e.target.value)}
                    disabled={editBusy}
                  />

                  <label className="rf-label" style={{ marginTop: 12 }}>
                    Tags <span style={{ fontWeight: 400, color: 'var(--text2)' }}>
                      (comma-separated; use <code>parent::child</code> for nested groups)
                    </span>
                  </label>
                  <input
                    className="rf-input"
                    value={editTags}
                    onChange={e => setEditTags(e.target.value)}
                    placeholder="mcp, anthropic::sdk, frontend"
                    autoFocus
                    disabled={editBusy}
                  />

                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text2)' }}>
                    File: {selected.filename} · {fmtSize(selected.size)} · {selected.mime}
                  </div>

                  {editErr && <div className="login-error" style={{ marginTop: 10 }}>{editErr}</div>}

                  <div className="rf-actions" style={{ marginTop: 14 }}>
                    <button className="rf-btn-cancel" onClick={() => setEditing(false)} disabled={editBusy}>
                      Cancel
                    </button>
                    <button className="rf-btn-save" onClick={saveEdit} disabled={editBusy}>
                      {editBusy ? 'Saving…' : 'Save'}
                    </button>
                  </div>

                  <hr className="doc-edit-divider" />
                  <button
                    className="doc-edit-delete-btn"
                    onClick={doDelete}
                    disabled={editBusy}
                    title="Permanently delete this doc and its Drive file"
                  >
                    🗑 Delete this doc
                  </button>
                  <div className="doc-edit-delete-warn">
                    Removes the Drive file and the sheet row. Cannot be undone.
                  </div>
                </div>
              ) : (
                <div className="doc-viewer-wrap">
                  <DocViewer doc={selected} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
