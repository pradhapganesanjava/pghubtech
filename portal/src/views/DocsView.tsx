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
  const [selected, setSelected]         = useState<DocRecord | null>(null)
  const [search, setSearch]             = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [leftCollapsed, setLeftColl]    = useState(false)

  const [pickedFile, setPickedFile]     = useState<File | null>(null)
  const [editing, setEditing]           = useState(false)
  const [editAlias, setEditAlias]       = useState('')
  const [editTags, setEditTags]         = useState<string>('')

  const fileInputRef = useRef<HTMLInputElement>(null)

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
    setEditing(true)
  }
  async function saveEdit() {
    if (!selected) return
    const updated: DocRecord = {
      ...selected,
      alias: editAlias.trim() || selected.alias,
      tags:  editTags.split(',').map(t => t.trim()).filter(Boolean),
    }
    try {
      await updateDoc(updated)
      setDocs(prev => prev.map(d => d.id === updated.id ? updated : d))
      setSelected(updated)
      setEditing(false)
      toast('Doc updated', 'success')
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    }
  }
  async function doDelete() {
    if (!selected) return
    if (!window.confirm(`Delete "${selected.alias}"? This removes the Drive file too.`)) return
    const target = selected
    try {
      const token = GAuth.getToken()
      if (!token) throw new Error('Not signed in')
      await deleteDriveFile(token, target.id).catch(() => { /* keep going */ })
      await deleteDocRow(target.id)
      setDocs(prev => prev.filter(d => d.id !== target.id))
      setSelected(null)
      toast('Doc deleted', 'success')
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'error')
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="browse-body-wrap">
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

      {/* Left: tag tree */}
      <div className={`browse-col-tags${leftCollapsed ? ' collapsed' : ''}`}>
        <DocTagTree
          docs={docs}
          selectedTags={selectedTags}
          onToggleTag={t =>
            setSelectedTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
          }
          onClearAll={() => setSelectedTags([])}
          collapsed={leftCollapsed}
          onCollapse={() => setLeftColl(c => !c)}
        />
      </div>

      {/* Main: list + viewer */}
      <div className="browse-main">
        <div className="browse-toolbar">
          <button className="rf-btn-save" onClick={pickFile} style={{ marginLeft: 0 }}>
            ＋ Upload
          </button>
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

        <div className="browse-cards-split">
          {/* Doc list */}
          <div
            className="browse-col-cards"
            style={selected ? { flex: '0 0 32%' } : undefined}
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
                          {d.tags.map(t => <span key={t} className="tag">{t.split('::').pop()}</span>)}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {/* Viewer pane */}
          {selected && (
            <div className="browse-col-detail has-selection" style={{ flex: 1 }}>
              <div className="col-hd" style={{ padding: '10px 12px', flexShrink: 0 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selected.alias || selected.filename}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="bci-edit-btn bci-edit-btn-hd" onClick={startEdit} title="Edit tags / alias">✎</button>
                  <button className="bci-edit-btn bci-edit-btn-hd" onClick={doDelete} title="Delete">🗑</button>
                  <button className="detail-close-btn" onClick={() => setSelected(null)}>✕</button>
                </div>
              </div>

              {editing ? (
                <div style={{ padding: 12 }}>
                  <label className="rf-label">Alias</label>
                  <input
                    className="rf-input"
                    value={editAlias}
                    onChange={e => setEditAlias(e.target.value)}
                    style={{ width: '100%', marginBottom: 10 }}
                  />
                  <label className="rf-label">Tags (comma-separated, ‹parent::child› for nesting)</label>
                  <input
                    className="rf-input"
                    value={editTags}
                    onChange={e => setEditTags(e.target.value)}
                    style={{ width: '100%' }}
                  />
                  <div className="rf-actions" style={{ marginTop: 12 }}>
                    <button className="rf-btn-cancel" onClick={() => setEditing(false)}>Cancel</button>
                    <button className="rf-btn-save" onClick={saveEdit}>Save</button>
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
