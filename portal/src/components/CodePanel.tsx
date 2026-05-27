import { useEffect, useMemo, useRef, useState } from 'react'
import { loadCode, saveCode, EMPTY_CODE } from '../adapters/adsRepo'
import type { ProblemCode } from '../adapters/adsRepo'
import { useToast } from './Toast'

type Lang = 'python3' | 'java'
const MOD_KEY = { python3: 'py3Modified', java: 'javaModified' } as const

// Per-problem starter-code editor (Python3 / Java), persisted to the LCCode
// sheet tab. Save / Copy / Pin / History. (Run needs a code runtime — omitted.)
//   headerRight — content pinned to the right of the header (e.g. notes toggle)
//   overlay     — when set, fills the editor space instead of the code editor
//                 (used to show the problem's notes in the code area)
interface Props { slug: string; headerRight?: React.ReactNode; overlay?: React.ReactNode }

export default function CodePanel({ slug, headerRight, overlay }: Props) {
  const { toast } = useToast()
  const [code, setCode]       = useState<ProblemCode>(EMPTY_CODE())
  const [lang, setLang]       = useState<Lang>('python3')
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty]     = useState(false)
  const [saving, setSaving]   = useState(false)
  const [histOpen, setHistOpen] = useState(false)
  const taRef     = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setDirty(false); setHistOpen(false)
    loadCode(slug)
      .then(c => { if (!cancelled) setCode(c) })
      .catch(() => { if (!cancelled) setCode(EMPTY_CODE()) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [slug])

  const value   = code[lang]
  const modified = code[MOD_KEY[lang]]
  const lineCount = useMemo(() => Math.max(value.split('\n').length, 1), [value])

  function onEdit(v: string) {
    setCode(prev => ({ ...prev, [lang]: v }))
    setDirty(true)
  }

  function syncScroll() {
    if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop
  }

  function handleTab(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Tab') return
    e.preventDefault()
    const ta = e.currentTarget
    const s = ta.selectionStart, end = ta.selectionEnd
    const next = value.slice(0, s) + '    ' + value.slice(end)
    onEdit(next)
    requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 4 })
  }

  async function persist(next: ProblemCode, msg = 'Code saved') {
    setSaving(true)
    try {
      await saveCode(slug, next)
      setCode(next); setDirty(false)
      toast(msg, 'success')
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally { setSaving(false) }
  }

  function save() {
    persist({ ...code, [MOD_KEY[lang]]: new Date().toISOString() })
  }

  function pin() {
    if (!value.trim()) { toast('Nothing to pin', 'info'); return }
    const pins = { ...code.pins, [lang]: [{ code: value, ts: new Date().toISOString() }, ...code.pins[lang]].slice(0, 20) }
    persist({ ...code, pins, [MOD_KEY[lang]]: new Date().toISOString() }, 'Version pinned')
  }

  function restore(pinCode: string) {
    onEdit(pinCode); setHistOpen(false)
  }

  async function copy() {
    try { await navigator.clipboard.writeText(value); toast('Code copied', 'success') }
    catch { toast('Copy failed', 'error') }
  }

  const langPins = code.pins[lang]

  return (
    <div className="code-panel">
      <div className="code-panel-hd">
        <span className="code-panel-title">Starter Code</span>
        <div className="code-lang-tabs">
          {(['python3', 'java'] as Lang[]).map(l => (
            <button key={l} className={`code-lang-tab${lang === l ? ' active' : ''}`} onClick={() => setLang(l)}>
              {l === 'python3' ? 'Python3' : 'Java'}
            </button>
          ))}
        </div>
        {headerRight && <span className="code-hd-right">{headerRight}</span>}
      </div>

      {/* Notes (or any caller-supplied content) take over the editor space. */}
      {overlay ? overlay : loading ? (
        <div className="doc-viewer-state"><div className="spinner" /><span>Loading code…</span></div>
      ) : (
        <>
          <div className="code-editor">
            <div className="code-gutter" ref={gutterRef}>
              {Array.from({ length: lineCount }, (_, i) => <div key={i}>{i + 1}</div>)}
            </div>
            <textarea
              ref={taRef}
              className="code-textarea"
              value={value}
              spellCheck={false}
              placeholder={`# your ${lang === 'python3' ? 'Python3' : 'Java'} solution…`}
              onChange={e => onEdit(e.target.value)}
              onScroll={syncScroll}
              onKeyDown={handleTab}
            />
          </div>

          <div className="code-toolbar">
            <button className="code-btn" disabled title="Run needs a code runtime (not available in the hosted app)">▶ Run</button>
            <button className="code-btn" onClick={pin} disabled={saving}>📌 Pin</button>
            <div className="code-hist-wrap">
              <button className={`code-btn${histOpen ? ' active' : ''}`} onClick={() => setHistOpen(o => !o)}>🕑 History{langPins.length ? ` (${langPins.length})` : ''}</button>
              {histOpen && (
                <div className="code-hist-menu" onMouseLeave={() => setHistOpen(false)}>
                  {langPins.length === 0 && <div className="adshub-list-menu-empty">No pinned versions</div>}
                  {langPins.map((p, i) => (
                    <button key={i} className="adshub-list-menu-item" onClick={() => restore(p.code)} title="Restore this version">
                      <span>v{langPins.length - i}</span>
                      <span className="tree-cnt">{new Date(p.ts).toLocaleDateString()}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="code-btn" onClick={copy}>⎘ Copy</button>
            <button className="code-btn code-btn-save" onClick={save} disabled={saving || !dirty}>
              {saving ? 'Saving…' : dirty ? 'Save' : '✓ Saved'}
            </button>
            <span className="code-saved-at">
              {modified ? `✓ ${new Date(modified).toLocaleString()}` : 'not saved yet'}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
