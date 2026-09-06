import { useState, useEffect } from 'react'
import { Config } from '../services/config'
import { checkAccess, loadSettings, saveSetting } from '../adapters/sheetsRepo'
import { loadAnkiTemplates, saveAnkiTemplate } from '../adapters/ankiRepo'
import type { AnkiTemplate, AnkiField } from '../adapters/ankiRepo'
import { LLM } from '../lib/llm'
import { TTS } from '../lib/tts'
import { useToast } from '../components/Toast'
// Sheet-key ↔ Config-field mapping for the AI assistant settings, shared with
// the boot-time hydration in App so the two can never drift. Saving the AI
// panel writes one row per non-empty field to the Settings tab.
import { AI_KEYS } from '../services/aiConfig'

const TTS_VOICES = [
  { id: 'alloy',   label: 'Alloy'   },
  { id: 'echo',    label: 'Echo'    },
  { id: 'fable',   label: 'Fable'   },
  { id: 'onyx',    label: 'Onyx'    },
  { id: 'nova',    label: 'Nova'    },
  { id: 'shimmer', label: 'Shimmer' },
]

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

        {/* AI Assistant */}
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <AIAssistantPanel />
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

// ── AI assistant panel ────────────────────────────────────────────────────────

function AIAssistantPanel() {
  const { toast } = useToast()
  const [endpoint,    setEndpoint]    = useState(Config.azureEndpoint)
  const [apiKey,      setApiKey]      = useState(Config.azureApiKey)
  const [deployment,  setDeployment]  = useState(Config.azureDeployment)
  const [apiVersion,  setApiVersion]  = useState(Config.azureApiVersion)
  const [ttsEndpoint, setTtsEndpoint] = useState(Config.azureTtsEndpoint)
  const [ttsApiKey,   setTtsApiKey]   = useState(Config.azureTtsApiKey)
  const [ttsDeploy,   setTtsDeploy]   = useState(Config.azureTtsDeployment)
  const [ttsVersion,  setTtsVersion]  = useState(Config.azureTtsApiVersion)
  const [ttsVoice,    setTtsVoice]    = useState(Config.ttsVoice)
  const [audioOn,     setAudioOn]     = useState(Config.audioOn)
  const [saving,      setSaving]      = useState(false)
  const [testing,     setTesting]     = useState<'ai' | 'tts' | null>(null)

  // Hydrate from the Sheet on mount so any values added directly to the
  // Settings tab show up here.
  useEffect(() => {
    loadSettings().then(s => {
      const apply = (k: string, set: (v: string) => void, target: keyof typeof Config) => {
        if (s[k] !== undefined && s[k] !== '') {
          set(s[k])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(Config as any)[target] = s[k]
        }
      }
      apply(AI_KEYS.endpoint,    setEndpoint,    'azureEndpoint')
      apply(AI_KEYS.apiKey,      setApiKey,      'azureApiKey')
      apply(AI_KEYS.deployment,  setDeployment,  'azureDeployment')
      apply(AI_KEYS.apiVersion,  setApiVersion,  'azureApiVersion')
      apply(AI_KEYS.ttsEndpoint, setTtsEndpoint, 'azureTtsEndpoint')
      apply(AI_KEYS.ttsApiKey,   setTtsApiKey,   'azureTtsApiKey')
      apply(AI_KEYS.ttsDeploy,   setTtsDeploy,   'azureTtsDeployment')
      apply(AI_KEYS.ttsVersion,  setTtsVersion,  'azureTtsApiVersion')
      apply(AI_KEYS.ttsVoice,    setTtsVoice,    'ttsVoice')
      if (s[AI_KEYS.audioOn] !== undefined) {
        const on = s[AI_KEYS.audioOn] !== 'false'
        setAudioOn(on)
        Config.audioOn = on
      }
    }).catch(() => { /* fall back to local cache values already in state */ })
  }, [])

  async function persist(): Promise<void> {
    setSaving(true)
    try {
      // Mirror locally so other modules (LLM/TTS) see the new values
      // synchronously, then push each row to the Sheet.
      Config.azureEndpoint      = endpoint.trim()
      Config.azureApiKey        = apiKey.trim()
      Config.azureDeployment    = deployment.trim()
      Config.azureApiVersion    = apiVersion.trim()
      Config.azureTtsEndpoint   = ttsEndpoint.trim()
      Config.azureTtsApiKey     = ttsApiKey.trim()
      Config.azureTtsDeployment = ttsDeploy.trim()
      Config.azureTtsApiVersion = ttsVersion.trim()
      Config.ttsVoice           = ttsVoice.trim()
      Config.audioOn            = audioOn

      await Promise.all([
        saveSetting(AI_KEYS.endpoint,    Config.azureEndpoint),
        saveSetting(AI_KEYS.apiKey,      Config.azureApiKey),
        saveSetting(AI_KEYS.deployment,  Config.azureDeployment),
        saveSetting(AI_KEYS.apiVersion,  Config.azureApiVersion),
        saveSetting(AI_KEYS.ttsEndpoint, Config.azureTtsEndpoint),
        saveSetting(AI_KEYS.ttsApiKey,   Config.azureTtsApiKey),
        saveSetting(AI_KEYS.ttsDeploy,   Config.azureTtsDeployment),
        saveSetting(AI_KEYS.ttsVersion,  Config.azureTtsApiVersion),
        saveSetting(AI_KEYS.ttsVoice,    Config.ttsVoice),
        saveSetting(AI_KEYS.audioOn,     String(Config.audioOn)),
      ])
      toast('AI settings saved', 'success')
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function testAi(): Promise<void> {
    setTesting('ai')
    try {
      const reply = await LLM.ask('Reply with the single word: ready')
      toast(`AI: ${reply.slice(0, 60)}`, 'success')
    } catch (e) {
      toast(`AI test failed: ${(e as Error).message}`, 'error')
    } finally {
      setTesting(null)
    }
  }

  async function testTts(): Promise<void> {
    setTesting('tts')
    try {
      await TTS.speak(`Hello, I am ${ttsVoice || 'your assistant'}. This is a voice test.`)
    } catch (e) {
      toast(`TTS failed: ${(e as Error).message}`, 'error')
    } finally {
      setTesting(null)
    }
  }

  return (
    <>
      <h2>AI Assistant (Azure OpenAI)</h2>
      <p className="sub">
        Configure your Azure OpenAI deployment for the floating Ask AI panel
        and text-to-speech. Values persist to the Settings tab in your Sheet.
      </p>

      <div className="settings-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="form-group">
          <label>Endpoint</label>
          <input
            type="text"
            value={endpoint}
            onChange={e => setEndpoint(e.target.value)}
            placeholder="https://my-resource.openai.azure.com"
          />
        </div>
        <div className="form-group">
          <label>API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <div className="form-group">
          <label>Chat Deployment</label>
          <input
            type="text"
            value={deployment}
            onChange={e => setDeployment(e.target.value)}
            placeholder="gpt-4o"
          />
        </div>
        <div className="form-group">
          <label>API Version</label>
          <input
            type="text"
            value={apiVersion}
            onChange={e => setApiVersion(e.target.value)}
            placeholder="2024-12-01-preview"
          />
        </div>

        <div className="form-group">
          <label>TTS Endpoint <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
          <input
            type="text"
            value={ttsEndpoint}
            onChange={e => setTtsEndpoint(e.target.value)}
            placeholder="leave blank to reuse chat endpoint"
          />
        </div>
        <div className="form-group">
          <label>TTS API Key <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
          <input
            type="password"
            value={ttsApiKey}
            onChange={e => setTtsApiKey(e.target.value)}
            placeholder="leave blank to reuse chat key"
          />
        </div>
        <div className="form-group">
          <label>TTS Deployment</label>
          <input
            type="text"
            value={ttsDeploy}
            onChange={e => setTtsDeploy(e.target.value)}
            placeholder="tts-1 (leave blank → browser voice)"
          />
        </div>
        <div className="form-group">
          <label>TTS API Version</label>
          <input
            type="text"
            value={ttsVersion}
            onChange={e => setTtsVersion(e.target.value)}
            placeholder="2025-03-01-preview"
          />
        </div>

        <div className="form-group">
          <label>Voice</label>
          <select
            value={ttsVoice}
            onChange={e => setTtsVoice(e.target.value)}
          >
            {TTS_VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={audioOn}
              onChange={e => setAudioOn(e.target.checked)}
            />
            <span>Auto-speak AI replies</span>
          </label>
        </div>
      </div>

      <div className="form-actions" style={{ marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={persist} disabled={saving}>
          {saving ? 'Saving…' : 'Save AI settings'}
        </button>
        <button
          className="btn btn-secondary"
          onClick={testAi}
          disabled={testing !== null || !endpoint || !apiKey}
        >{testing === 'ai' ? 'Testing…' : 'Test chat'}</button>
        <button
          className="btn btn-secondary"
          onClick={testTts}
          disabled={testing !== null}
        >{testing === 'tts' ? 'Speaking…' : 'Test voice'}</button>
      </div>
    </>
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
            <button
              className="mgmt-back-btn"
              onClick={() => setSelected(null)}
              title="Back to templates"
              aria-label="Back to templates list"
            >←</button>
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
