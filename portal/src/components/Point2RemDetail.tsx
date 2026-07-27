import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import { sanitizeHtml } from '../lib/sanitize'
import type { P2RItem } from '../adapters/point2remRepo'
import { P2R_MAX_CONTENT } from '../adapters/point2remRepo'
import type { LCProblem } from '../adapters/adsRepo'

// Right-hand page for one Point2Rem note — view and edit. Shares the
// detail-pane chrome with the problem detail (same header classes) so
// switching between the two reads as one pane, not two layouts.
interface Props {
  item:           P2RItem
  problems:       LCProblem[]
  knownTags:      string[]
  startEditing:   boolean
  onOpenProblem:  (p: LCProblem) => void
  onSave:         (draft: P2RItem) => Promise<void>
  onDelete:       (id: string) => Promise<void>
  onClose:        () => void
  expanded:       boolean
  onToggleExpand: () => void
  onHeaderDoubleClick: () => void
}

function diffClass(d: string): string {
  const k = d.toLowerCase()
  return k === 'easy' ? 'lc-easy' : k === 'medium' ? 'lc-medium' : k === 'hard' ? 'lc-hard' : ''
}

function renderContent(content: string, format: 'md' | 'html'): string {
  if (format === 'html') return sanitizeHtml(content)
  try { return sanitizeHtml(marked.parse(content, { async: false }) as string) }
  catch { return sanitizeHtml(content) }
}

export default function Point2RemDetail({
  item, problems, knownTags, startEditing, onOpenProblem, onSave, onDelete,
  onClose, expanded, onToggleExpand, onHeaderDoubleClick,
}: Props) {
  const [editing, setEditing] = useState(startEditing)
  const [draft, setDraft]     = useState<P2RItem>(item)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState('')
  const [preview, setPreview] = useState(false)

  // Switching notes (or reloading the open one) discards any half-typed draft
  // — the pane always reflects the note named in the header.
  useEffect(() => {
    setDraft(item); setEditing(startEditing); setErr(''); setPreview(false)
  }, [item, startEditing])

  const html = useMemo(() => renderContent(item.content, item.format), [item.content, item.format])
  const draftHtml = useMemo(
    () => preview ? renderContent(draft.content, draft.format) : '',
    [preview, draft.content, draft.format],
  )

  // Resolve the note's linked ids against the loaded archive. Ids with no
  // match still render (greyed) rather than vanishing silently — a typo
  // should be visible.
  const linked = useMemo(() => item.problems.map(id => {
    const num = String(parseInt(id, 10))
    return { id, problem: problems.find(p => p.frontendId === id || p.frontendId === num) ?? null }
  }), [item.problems, problems])

  const isNew = !item.id
  const set = <K extends keyof P2RItem>(k: K, v: P2RItem[K]) => setDraft(d => ({ ...d, [k]: v }))
  const splitList = (s: string) => s.split(/\s*;\s*/).map(x => x.trim()).filter(Boolean)

  // Tags not yet on the draft, for the one-click suggestion row.
  const tagSuggestions = useMemo(
    () => knownTags.filter(t => !draft.tags.includes(t)).slice(0, 12),
    [knownTags, draft.tags],
  )

  async function handleSave() {
    if (!draft.title.trim()) { setErr('Title is required'); return }
    setSaving(true); setErr('')
    try {
      await onSave(draft)
      setEditing(false); setPreview(false)
    } catch (e) {
      setErr((e as Error).message)
    } finally { setSaving(false) }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete “${item.title}”? This removes the note from the sheet.`)) return
    setSaving(true)
    try { await onDelete(item.id) }
    catch (e) { setErr((e as Error).message); setSaving(false) }
  }

  return (
    <div className="browse-col-detail has-selection" style={{ flex: 1 }}>
      <div
        className="col-hd doc-detail-hd"
        style={{ padding: '10px 12px', flexShrink: 0, position: 'relative' }}
        onDoubleClick={onHeaderDoubleClick}
        title="Double-click to widen / restore the detail pane"
      >
        <span className="doc-detail-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          📌 {editing ? (isNew ? 'New point' : draft.title || item.title) : item.title}
        </span>
        <div style={{ display: 'flex', gap: 6 }} onDoubleClick={e => e.stopPropagation()}>
          {!editing && item.updated && <span className="p2r-updated">{item.updated}</span>}
          {!editing && (
            <>
              <button className="bci-edit-btn bci-edit-btn-hd" onClick={() => setEditing(true)} title="Edit this point">✎</button>
              <button className="bci-edit-btn bci-edit-btn-hd" onClick={handleDelete} disabled={saving} title="Delete this point">🗑</button>
            </>
          )}
          <button
            className={`bci-edit-btn bci-edit-btn-hd${expanded ? ' active' : ''}`}
            onClick={onToggleExpand}
            title={expanded ? 'Restore list' : 'Maximize'}
          >{expanded ? '⤡' : '⤢'}</button>
          <button className="detail-close-btn" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="adshub-detail-body">
        <div className="adshub-desc-col p2r-body">
          {editing ? (
            <div className="p2r-form">
              <label>Title *
                <input
                  className="rf-input" value={draft.title} disabled={saving} autoFocus
                  onChange={e => set('title', e.target.value)}
                  placeholder="One line you'd want to reread before an interview"
                />
              </label>

              <label>Tags <span className="p2r-hint">· <code>;</code> separated, <code>::</code> for hierarchy</span>
                <input
                  className="rf-input" value={draft.tags.join('; ')} disabled={saving}
                  onChange={e => set('tags', splitList(e.target.value))}
                  placeholder="_ds::graph::undirected; _prob::graph::cycle-detect"
                />
              </label>
              {tagSuggestions.length > 0 && (
                <div className="doc-tag-suggestions">
                  {tagSuggestions.map(t => (
                    <button
                      key={t} type="button" className="doc-tag-suggestion" disabled={saving}
                      onMouseDown={e => { e.preventDefault(); set('tags', [...draft.tags, t]) }}
                    >+ {t}</button>
                  ))}
                </div>
              )}

              <label>Linked problems <span className="p2r-hint">· LC ids, <code>;</code> separated</span>
                <input
                  className="rf-input" value={draft.problems.join('; ')} disabled={saving}
                  onChange={e => set('problems', splitList(e.target.value))}
                  placeholder="261; 684; 685"
                />
              </label>

              <label>References <span className="p2r-hint">· one per line, <code>label | url</code></span>
                <textarea
                  className="rf-textarea" rows={2} disabled={saving}
                  value={draft.links.map(l => l.label ? `${l.label} | ${l.url}` : l.url).join('\n')}
                  onChange={e => set('links', e.target.value.split(/\r?\n/).map(line => {
                    const t = line.trim()
                    if (!t) return null
                    const bar = t.indexOf('|')
                    if (bar < 0) return { url: t }
                    const label = t.slice(0, bar).trim()
                    const url   = t.slice(bar + 1).trim()
                    return url ? (label ? { label, url } : { url }) : null
                  }).filter(Boolean) as P2RItem['links'])}
                  placeholder="LC Explore — Graph | https://leetcode.com/explore/"
                />
              </label>

              <div className="p2r-form-bar">
                <div className="adshub-diff-pills">
                  {(['md', 'html'] as const).map(f => (
                    <button
                      key={f} className={`adshub-diff-pill${draft.format === f ? ' active' : ''}`}
                      onClick={() => set('format', f)} disabled={saving}
                    >{f === 'md' ? 'Markdown' : '</> HTML'}</button>
                  ))}
                </div>
                <button
                  className={`adshub-diff-pill${preview ? ' active' : ''}`}
                  onClick={() => setPreview(p => !p)}
                >{preview ? '✎ Write' : '👁 Preview'}</button>
                <span className={`p2r-hint${draft.content.length > P2R_MAX_CONTENT ? ' over' : ''}`} style={{ marginLeft: 'auto' }}>
                  {draft.content.length.toLocaleString()} / {P2R_MAX_CONTENT.toLocaleString()}
                </span>
              </div>

              {preview ? (
                <div
                  className="adshub-desc section-html-body adshub-editor-preview"
                  dangerouslySetInnerHTML={{ __html: draftHtml || '<em style="opacity:.5">Nothing to preview</em>' }}
                />
              ) : (
                <textarea
                  className="rf-textarea adshub-html-editor" spellCheck={false} disabled={saving}
                  value={draft.content} onChange={e => set('content', e.target.value)}
                  placeholder={draft.format === 'md'
                    ? '## The rule\n\n`visited neighbour == parent` → OK…'
                    : '<p>Raw HTML…</p>'}
                />
              )}

              {err && <div className="login-error">{err}</div>}
              <div className="rf-actions">
                <button
                  className="rf-btn-cancel" disabled={saving}
                  onClick={() => { if (isNew) onClose(); else { setDraft(item); setEditing(false); setErr('') } }}
                >Cancel</button>
                <button className="rf-btn-save" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : isNew ? 'Create point' : 'Save point'}
                </button>
              </div>
            </div>
          ) : (
            <>
              {item.tags.length > 0 && (
                <div className="adshub-meta-row">
                  {item.tags.map(t => <span key={t} className="tag" title={t}>{t}</span>)}
                </div>
              )}

              <div className="adshub-desc section-html-body" dangerouslySetInnerHTML={{ __html: html }} />

              {linked.length > 0 && (
                <div className="p2r-links">
                  <div className="detail-section-hd" style={{ padding: '6px 0' }}>
                    Linked problems <span className="tree-cnt">{linked.length}</span>
                  </div>
                  <ul className="adshub-prob-results">
                    {linked.map(({ id, problem }) => (
                      <li
                        key={id}
                        onClick={() => problem && onOpenProblem(problem)}
                        title={problem ? `Open #${id} ${problem.title}` : `#${id} is not in the archive`}
                        style={problem ? undefined : { opacity: .5, cursor: 'default' }}
                      >
                        <span className={`adshub-diff-dot ${problem ? diffClass(problem.difficulty) : ''}`} />
                        <span className="adshub-pid">#{id}</span>
                        <span className="adshub-prob-title">{problem ? problem.title : 'not in the archive'}</span>
                        {problem && <span className="adshub-prob-add">↗</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {item.links.length > 0 && (
                <div className="p2r-links">
                  <div className="detail-section-hd" style={{ padding: '6px 0' }}>
                    References <span className="tree-cnt">{item.links.length}</span>
                  </div>
                  <ul className="p2r-ref-list">
                    {item.links.map(l => (
                      <li key={l.url}>
                        <a href={l.url} target="_blank" rel="noopener noreferrer">{l.label || l.url} ↗</a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="adshub-end-footer">· end of point ·</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
