import { useState, useEffect } from 'react'
import { Config } from '../services/config'
import { checkAccess } from '../adapters/sheetsRepo'
import { loadAnkiTemplates, saveAnkiTemplate } from '../adapters/ankiRepo'
import type { AnkiTemplate, AnkiField } from '../adapters/ankiRepo'
import { useToast } from '../components/Toast'

type SettingsTab = 'general' | 'templates'
type FieldType = 'text' | 'html' | 'number' | 'select' | 'tags'

const FIELD_TYPES: FieldType[] = ['text', 'html', 'number', 'select', 'tags']

const THEMES = [
  { id: 'dark',     label: 'Dark',     bg: '#0f0f13', primary: '#6366f1' },
  { id: 'light',    label: 'Light',    bg: '#f5f5ff', primary: '#6366f1' },
  { id: 'soft',     label: 'Soft',     bg: '#1e1b34', primary: '#a78bfa' },
  { id: 'contrast', label: 'Contrast', bg: '#000000', primary: '#faff00' },
  { id: 'glow',     label: 'Glow',     bg: '#050510', primary: '#00e5ff' },
  { id: 'cartoon',  label: 'Cartoon',  bg: '#fff9e6', primary: '#7c3aed' },
]

interface Props {
  theme:         string
  onTheme:       (t: string) => void
  onChangeSheet: () => void
}

export default function SettingsView({ theme, onTheme, onChangeSheet }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="mgmt-tabs">
        <button
          className={`mgmt-tab${activeTab === 'general' ? ' active' : ''}`}
          onClick={() => setActiveTab('general')}
        >General</button>
        <button
          className={`mgmt-tab${activeTab === 'templates' ? ' active' : ''}`}
          onClick={() => setActiveTab('templates')}
        >Templates</button>
      </div>

      <div className="mgmt-tab-content">
        {activeTab === 'general'   && <GeneralTab theme={theme} onTheme={onTheme} onChangeSheet={onChangeSheet} />}
        {activeTab === 'templates' && <TemplatesTab />}
      </div>
    </div>
  )
}

// ── General tab ───────────────────────────────────────────────────────────────

function GeneralTab({ theme, onTheme, onChangeSheet }: Props) {
  const { toast } = useToast()
  const [clientId,    setClientId]    = useState(Config.googleClientId)
  const [sheetId,     setSheetId]     = useState(Config.sheetId)
  const [checking,    setChecking]    = useState(false)
  const [sheetStatus, setSheetStatus] = useState<'idle' | 'ok' | 'err'>('idle')

  async function handleCheckSheet() {
    setChecking(true)
    setSheetStatus('idle')
    const prev = Config.sheetId
    Config.sheetId = sheetId.trim()
    try {
      await checkAccess()
      setSheetStatus('ok')
      toast('Sheet connected successfully', 'success')
    } catch (e) {
      setSheetStatus('err')
      Config.sheetId = prev
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setChecking(false)
    }
  }

  function handleSaveClientId() {
    Config.googleClientId = clientId.trim()
    toast('Client ID saved — reload the page to apply', 'info')
  }

  return (
    <div className="main" style={{ overflowY: 'auto' }}>
      <div className="settings-grid">

        {/* Google OAuth */}
        <div className="panel">
          <h2>Google OAuth</h2>
          <p className="sub">Client ID for sign-in. Create one at console.cloud.google.com.</p>
          <div className="form-group">
            <label>Client ID</label>
            <input
              type="text"
              value={clientId}
              onChange={e => setClientId(e.target.value)}
              placeholder="xxxx.apps.googleusercontent.com"
            />
          </div>
          <div className="form-actions">
            <button className="btn btn-primary" onClick={handleSaveClientId}>Save Client ID</button>
          </div>
        </div>

        {/* Google Sheet */}
        <div className="panel">
          <h2>Google Sheet (Backend)</h2>
          <p className="sub">The Sheet ID from your spreadsheet URL. All data is stored here.</p>
          <div className="form-group">
            <label>Sheet ID</label>
            <input
              type="text"
              value={sheetId}
              onChange={e => setSheetId(e.target.value)}
              placeholder="Paste Sheet ID"
            />
            {Config.sheetId && (
              <div className="hint">
                <a
                  className="sheet-link"
                  href={`https://docs.google.com/spreadsheets/d/${Config.sheetId}`}
                  target="_blank" rel="noreferrer"
                >Open sheet ↗</a>
              </div>
            )}
          </div>
          <div className="form-actions">
            <button
              className="btn btn-primary"
              onClick={handleCheckSheet}
              disabled={checking || !sheetId.trim()}
            >
              {checking ? 'Checking…' : 'Verify & Save'}
            </button>
            <button className="btn btn-secondary" onClick={onChangeSheet}>
              Select different sheet
            </button>
          </div>
          {sheetStatus === 'ok'  && <div className="sheet-status ok">Connected</div>}
          {sheetStatus === 'err' && <div className="sheet-status warn">Connection failed — check the ID</div>}
        </div>

        {/* Theme */}
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2>Appearance</h2>
          <p className="sub">Choose a colour theme. Changes are saved to your Google Sheet.</p>
          <div className="theme-picker">
            {THEMES.map(t => (
              <div
                key={t.id}
                className={`theme-swatch${theme === t.id ? ' sel' : ''}`}
                onClick={() => onTheme(t.id)}
              >
                <div className="ts-preview" style={{ background: t.bg }}>
                  <div className="ts-dot" style={{ background: t.primary }} />
                  <div className="ts-dot" style={{ background: t.bg === '#000000' ? '#555' : t.bg }} />
                </div>
                <span className="ts-label">{t.label}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}

// ── Templates tab ─────────────────────────────────────────────────────────────

function TemplatesTab() {
  const { toast } = useToast()
  const [templates, setTemplates] = useState<AnkiTemplate[]>([])
  const [selected,  setSelected]  = useState<AnkiTemplate | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [saving,    setSaving]    = useState(false)
  const [msg,       setMsg]       = useState('')

  useEffect(() => {
    loadAnkiTemplates()
      .then(map => {
        const list = [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
        setTemplates(list)
        setLoading(false)
      })
      .catch(e => {
        toast(`Failed to load templates: ${(e as Error).message}`, 'error')
        setLoading(false)
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function selectTemplate(t: AnkiTemplate) {
    setSelected(JSON.parse(JSON.stringify(t)))
    setMsg('')
  }

  function updateField(idx: number, patch: Partial<AnkiField>) {
    if (!selected) return
    let resolved = { ...patch }
    if (patch.isFront !== undefined) resolved = { ...resolved, isBack: !patch.isFront }
    const fields = selected.fields.map((f, i) => i === idx ? { ...f, ...resolved } : f)
    setSelected({ ...selected, fields })
  }

  function moveField(idx: number, dir: -1 | 1) {
    if (!selected) return
    const fields = [...selected.fields]
    const swap = idx + dir
    if (swap < 0 || swap >= fields.length) return
    ;[fields[idx], fields[swap]] = [fields[swap], fields[idx]]
    setSelected({ ...selected, fields: fields.map((f, i) => ({ ...f, order: i })) })
  }

  async function handleSave() {
    if (!selected) return
    setSaving(true)
    try {
      await saveAnkiTemplate(selected)
      setTemplates(prev => prev.map(t => t.id === selected.id ? selected : t))
      setMsg('Saved!')
      setTimeout(() => setMsg(''), 2500)
      toast('Template updated', 'success')
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="mgmt-empty">Loading templates…</div>

  return (
    <div className="mgmt-layout">
      {/* Sidebar */}
      <aside className="mgmt-sidebar">
        <div className="mgmt-sidebar-hd">
          <span>Templates</span>
          <span style={{ fontSize: 11, color: 'var(--text2)' }}>{templates.length}</span>
        </div>
        <ul className="mgmt-list">
          {templates.map(t => (
            <li
              key={t.id}
              className={`mgmt-list-item${selected?.id === t.id ? ' active' : ''}`}
              onClick={() => selectTemplate(t)}
            >
              <span className="mgmt-item-name">{t.displayName}</span>
              <span className="mgmt-item-sub">{t.id} · {t.fields.length} fields</span>
            </li>
          ))}
        </ul>
      </aside>

      {/* Detail */}
      {selected ? (
        <div className="mgmt-detail">
          <div className="mgmt-detail-hd">
            <h2>{selected.displayName}</h2>
            {msg && <span className="mgmt-msg">{msg}</span>}
          </div>

          <div className="mgmt-field-row">
            <label className="mgmt-lbl">Display Name</label>
            <input
              className="mgmt-input"
              value={selected.displayName}
              onChange={e => setSelected({ ...selected, displayName: e.target.value })}
            />
          </div>
          <div className="mgmt-field-row">
            <label className="mgmt-lbl">Sheet Tab (ID)</label>
            <input className="mgmt-input mgmt-input-dim" readOnly value={selected.id} />
          </div>

          <h3 className="mgmt-section-hd">Fields</h3>
          <div className="tmpl-fields-hd">
            <span style={{ flex: '0 0 120px' }}>Key</span>
            <span style={{ flex: '0 0 130px' }}>Label</span>
            <span style={{ flex: '0 0 90px' }}>Type</span>
            <span style={{ flex: '0 0 80px', textAlign: 'center' }}>Question</span>
            <span style={{ flex: '0 0 70px' }}>Move</span>
          </div>

          {selected.fields.map((f, idx) => (
            <div key={f.key} className="tmpl-field-row">
              <input
                className="mgmt-input mgmt-input-dim"
                style={{ flex: '0 0 120px' }}
                readOnly
                value={f.key}
                title="Field key comes from Anki — edit via seed script"
              />
              <input
                className="mgmt-input"
                style={{ flex: '0 0 130px' }}
                value={f.label}
                onChange={e => updateField(idx, { label: e.target.value })}
                placeholder="Label"
              />
              <select
                className="mgmt-select"
                style={{ flex: '0 0 90px' }}
                value={f.type}
                onChange={e => updateField(idx, { type: e.target.value as FieldType })}
              >
                {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <div style={{ flex: '0 0 80px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={!!f.isFront}
                  onChange={e => updateField(idx, { isFront: e.target.checked })}
                  title="Show on Question side"
                />
                <span style={{ fontSize: 10, color: f.isFront ? 'var(--primary)' : 'var(--text2)' }}>
                  {f.isFront ? 'Q' : 'A'}
                </span>
              </div>
              <div className="tmpl-move-btns" style={{ flex: '0 0 70px' }}>
                <button onClick={() => moveField(idx, -1)} disabled={idx === 0}>↑</button>
                <button onClick={() => moveField(idx, 1)} disabled={idx === selected.fields.length - 1}>↓</button>
              </div>
            </div>
          ))}

          <div className="mgmt-actions">
            <button className="mgmt-save-btn" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Template'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mgmt-empty">Select a template to view and edit its fields</div>
      )}
    </div>
  )
}
