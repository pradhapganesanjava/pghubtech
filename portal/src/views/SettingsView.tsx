import { useState } from 'react'
import { Config } from '../services/config'
import { checkAccess } from '../adapters/sheetsRepo'
import { useToast } from '../components/Toast'

interface Props {
  theme:   string
  onTheme: (t: string) => void
  onChangeSheet: () => void
}

const THEMES = [
  { id: 'dark',     label: 'Dark' },
  { id: 'light',    label: 'Light' },
  { id: 'soft',     label: 'Soft' },
  { id: 'contrast', label: 'Contrast' },
  { id: 'glow',     label: 'Glow' },
  { id: 'cartoon',  label: 'Cartoon' },
]

export default function SettingsView({ theme, onTheme, onChangeSheet }: Props) {
  const { toast } = useToast()
  const [clientId, setClientId] = useState(Config.googleClientId)
  const [sheetId,  setSheetId]  = useState(Config.sheetId)
  const [checking, setChecking] = useState(false)
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
    <div className="main">
      <div className="settings-grid">

        {/* Google OAuth */}
        <div className="panel">
          <h2>Google OAuth</h2>
          <p className="sub">Google Client ID for sign-in. Create one at console.cloud.google.com.</p>
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
                  target="_blank"
                  rel="noreferrer"
                >
                  Open sheet ↗
                </a>
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
        <div className="panel">
          <h2>Appearance</h2>
          <p className="sub">Choose a colour theme.</p>
          <div className="theme-grid">
            {THEMES.map(t => (
              <button
                key={t.id}
                className={`theme-grid-btn${theme === t.id ? ' active' : ''}`}
                onClick={() => onTheme(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}
