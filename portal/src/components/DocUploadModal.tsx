import { useState } from 'react'

interface Props {
  file:        File
  knownTags:   string[]
  onCancel:    () => void
  onConfirm:   (alias: string, tags: string[]) => Promise<void> | void
}

function defaultAlias(name: string): string {
  // strip extension, replace separators with spaces, prettify a bit
  const noExt = name.replace(/\.[^./]+$/, '')
  return noExt.replace(/[_-]+/g, ' ').trim() || name
}

export default function DocUploadModal({ file, knownTags, onCancel, onConfirm }: Props) {
  const [alias, setAlias]     = useState(defaultAlias(file.name))
  const [tags, setTags]       = useState<string[]>([])
  const [draftTag, setDraft]  = useState('')
  const [busy, setBusy]       = useState(false)
  const [err, setErr]         = useState('')

  function addTag(t: string) {
    const clean = t.trim()
    if (!clean) return
    if (tags.includes(clean)) return
    setTags(prev => [...prev, clean])
    setDraft('')
  }

  async function submit() {
    if (!alias.trim()) { setErr('Alias is required'); return }
    setBusy(true); setErr('')
    try {
      await onConfirm(alias.trim(), tags)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const suggestions = knownTags
    .filter(t => !tags.includes(t) && (!draftTag || t.toLowerCase().includes(draftTag.toLowerCase())))
    .slice(0, 8)

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 className="modal-title">Upload doc</h3>
        <div className="modal-sub" style={{ marginBottom: 14 }}>
          <span className="doc-file-name">{file.name}</span>
          <span className="doc-file-meta">
            {(file.size / 1024).toFixed(1)} KB · {file.type || 'application/octet-stream'}
          </span>
        </div>

        <label className="rf-label" style={{ display: 'block', marginBottom: 4 }}>Alias</label>
        <input
          className="rf-input"
          value={alias}
          onChange={e => setAlias(e.target.value)}
          autoFocus
          disabled={busy}
          style={{ width: '100%', marginBottom: 14 }}
        />

        <label className="rf-label" style={{ display: 'block', marginBottom: 4 }}>Tags</label>
        <div className="doc-tag-input-wrap">
          {tags.map(t => (
            <span key={t} className="doc-tag-chip">
              {t}
              <button onClick={() => setTags(prev => prev.filter(x => x !== t))} disabled={busy}>×</button>
            </span>
          ))}
          <input
            className="doc-tag-input"
            value={draftTag}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                addTag(draftTag)
              } else if (e.key === 'Backspace' && !draftTag && tags.length) {
                setTags(prev => prev.slice(0, -1))
              }
            }}
            placeholder={tags.length ? '' : 'react::hooks, frontend, …'}
            disabled={busy}
          />
        </div>
        {suggestions.length > 0 && (
          <div className="doc-tag-suggestions">
            {suggestions.map(s => (
              <button
                key={s}
                className="doc-tag-suggestion"
                onClick={() => addTag(s)}
                disabled={busy}
                type="button"
              >+ {s}</button>
            ))}
          </div>
        )}

        {err && <div className="login-error" style={{ marginTop: 10 }}>{err}</div>}

        <div className="rf-actions" style={{ marginTop: 18 }}>
          <button className="rf-btn-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="rf-btn-save" onClick={submit} disabled={busy}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  )
}
