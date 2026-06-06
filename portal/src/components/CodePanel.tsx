import { useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { oneDark } from '@codemirror/theme-one-dark'
import { loadCode, saveCode, EMPTY_CODE } from '../adapters/adsRepo'
import type { ProblemCode } from '../adapters/adsRepo'
import { useToast } from './Toast'

type Lang = 'python3' | 'java'
const MOD_KEY = { python3: 'py3Modified', java: 'javaModified' } as const

// Per-problem starter-code editor (Python3 / Java), persisted to the LCCode
// sheet tab. Save / Copy / Pin / History. (Run needs a code runtime — omitted.)
//   headerRight — content pinned to the right of the header (e.g. notes toggle)
//   headerLeft  — REPLACES the default 'Starter Code · Python3 · Java' title +
//                  lang-tabs when set. Used by callers when an overlay
//                  (e.g. notes) takes over the body — they shouldn't see
//                  the code-specific header.
//   overlay     — when set, fills the editor space instead of the code editor
//                 (used to show the problem's notes in the code area)
interface Props {
  slug: string
  headerRight?: React.ReactNode
  headerLeft?:  React.ReactNode
  overlay?: React.ReactNode
  onHeaderDoubleClick?: () => void
}

export default function CodePanel({ slug, headerRight, headerLeft, overlay, onHeaderDoubleClick }: Props) {
  const { toast } = useToast()
  const [code, setCode]       = useState<ProblemCode>(EMPTY_CODE())
  const [lang, setLang]       = useState<Lang>('python3')
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty]     = useState(false)
  const [saving, setSaving]   = useState(false)
  const [histOpen, setHistOpen] = useState(false)

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
  const extensions = useMemo(() => [lang === 'python3' ? python() : java()], [lang])
  // Match the editor to the app theme. For dark we use the One Dark theme,
  // which ships a high-contrast syntax highlight style — the plain "dark"
  // theme reuses the light-tuned default highlight style, so keywords come out
  // nearly invisible on a dark background (that's the "no colours" bug).
  const cmTheme = useMemo(() => {
    const t = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null
    return (t === 'light' || t === 'cartoon') ? 'light' as const : oneDark
  }, [])

  function onEdit(v: string) {
    setCode(prev => ({ ...prev, [lang]: v }))
    setDirty(true)
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
      <div className="code-panel-hd" onDoubleClick={onHeaderDoubleClick} title={onHeaderDoubleClick ? 'Double-click to widen / restore the code panel' : undefined}>
        {/* If the caller supplied headerLeft (typically because an
            overlay has taken over the body), swap in their title in
            place of the code-specific 'Starter Code · Python3 · Java'.
            Keeps headers honest — Notes section no longer shows the
            Code header. */}
        {headerLeft ? headerLeft : (
          <>
            <span className="code-panel-title">Starter Code</span>
            <div className="code-lang-tabs">
              {(['python3', 'java'] as Lang[]).map(l => (
                <button key={l} className={`code-lang-tab${lang === l ? ' active' : ''}`} onClick={() => setLang(l)}>
                  {l === 'python3' ? 'Python3' : 'Java'}
                </button>
              ))}
            </div>
          </>
        )}
        {headerRight && <span className="code-hd-right">{headerRight}</span>}
      </div>

      {/* Notes (or any caller-supplied content) take over the editor space. */}
      {overlay ? overlay : loading ? (
        <div className="doc-viewer-state"><div className="spinner" /><span>Loading code…</span></div>
      ) : (
        <>
          <div className="code-editor code-cm">
            <CodeMirror
              value={value}
              height="100%"
              theme={cmTheme}
              extensions={extensions}
              onChange={onEdit}
              placeholder={`# your ${lang === 'python3' ? 'Python3' : 'Java'} solution…`}
              basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: true, autocompletion: false }}
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
