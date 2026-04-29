import { useState, useEffect } from 'react'
import { GAuth } from '../lib/gauth'
import { Config } from '../services/config'
import { checkAccess } from '../adapters/sheetsRepo'

interface Props {
  onDone: (sheetId: string) => void
}

export default function SheetSetupModal({ onDone }: Props) {
  const [sheetId, setSheetId]       = useState('')
  const [sheets, setSheets]          = useState<{ id: string; name: string }[]>([])
  const [loadingSheets, setLoadingSheets] = useState(true)
  const [creating, setCreating]      = useState(false)
  const [verifying, setVerifying]    = useState(false)
  const [error, setError]            = useState('')

  useEffect(() => {
    GAuth.listSheets()
      .then(s => setSheets(s))
      .finally(() => setLoadingSheets(false))
  }, [])

  async function handleUseSheet(id: string) {
    setError('')
    setVerifying(true)
    const prev = Config.sheetId
    Config.sheetId = id
    try {
      await checkAccess()
      onDone(id)
    } catch (e) {
      Config.sheetId = prev
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setVerifying(false)
    }
  }

  async function handleCreate() {
    setError('')
    setCreating(true)
    try {
      const newId = await GAuth.createSheet('PG Hub Tech Data')
      Config.sheetId = newId
      onDone(newId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <div className="modal-header">
          <div className="modal-title">Connect a Google Sheet</div>
          <div className="modal-subtitle">
            Your data is stored in a Google Sheet you own. Select an existing sheet or create a new one.
          </div>
        </div>

        {/* Existing sheets from Drive */}
        {loadingSheets ? (
          <div className="modal-loading">Loading your sheets…</div>
        ) : sheets.length > 0 ? (
          <div className="sheet-list-section">
            <div className="sheet-list-label">Your Google Sheets</div>
            <div className="sheet-list">
              {sheets.map(s => (
                <button
                  key={s.id}
                  className="sheet-list-item"
                  onClick={() => handleUseSheet(s.id)}
                  disabled={verifying || creating}
                >
                  <span className="sheet-list-icon">📊</span>
                  <span className="sheet-list-name">{s.name}</span>
                  <span className="sheet-list-arrow">→</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="modal-no-sheets">No existing sheets found.</div>
        )}

        <div className="modal-divider"><span>or paste Sheet ID</span></div>

        {/* Manual sheet ID entry */}
        <div className="sheet-id-section">
          <div className="form-group">
            <label>Sheet ID</label>
            <input
              type="text"
              placeholder="Paste Sheet ID from the URL (…/spreadsheets/d/{ID}/…)"
              value={sheetId}
              onChange={e => setSheetId(e.target.value.trim())}
            />
            <div className="hint">
              Open your Google Sheet → copy the ID between <code>/d/</code> and <code>/edit</code> in the URL.
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => handleUseSheet(sheetId)}
            disabled={!sheetId || verifying || creating}
          >
            {verifying ? 'Verifying…' : 'Use this Sheet'}
          </button>
        </div>

        <div className="modal-divider"><span>or</span></div>

        {/* Create new sheet */}
        <button
          className="btn btn-secondary modal-create-btn"
          onClick={handleCreate}
          disabled={creating || verifying}
        >
          {creating ? 'Creating…' : '✦ Create a new Sheet for me'}
        </button>

        {error && <div className="modal-error">{error}</div>}
      </div>
    </div>
  )
}
