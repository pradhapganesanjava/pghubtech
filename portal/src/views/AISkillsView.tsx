import { useEffect, useState } from 'react'
import {
  createSkill, deleteSkill, listSkills, updateSkill,
} from '../adapters/aiSkillsRepo'
import type { AISkill } from '../adapters/aiSkillsRepo'
import { useToast } from '../components/Toast'

export default function AISkillsView() {
  const { toast } = useToast()
  const [skills, setSkills]     = useState<AISkill[]>([])
  const [selected, setSelected] = useState<AISkill | null>(null)
  const [loading, setLoading]   = useState(true)
  const [busy, setBusy]         = useState(false)
  const [draft, setDraft]       = useState<AISkill | null>(null)
  const [dirty, setDirty]       = useState(false)
  const [err, setErr]           = useState('')

  useEffect(() => {
    listSkills()
      .then(list => { setSkills(list); setLoading(false) })
      .catch(e => { setLoading(false); toast(`Load failed: ${(e as Error).message}`, 'error') })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function selectSkill(s: AISkill) {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    setSelected(s); setDraft({ ...s }); setDirty(false); setErr('')
  }

  async function handleNew() {
    setBusy(true); setErr('')
    try {
      const created = await createSkill({ name: 'New skill', description: '', instruction: '', enabled: false })
      setSkills(prev => [...prev, created])
      setSelected(created); setDraft({ ...created }); setDirty(false)
      toast('Skill created', 'success')
    } catch (e) {
      toast(`Create failed: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }

  async function handleSave() {
    if (!draft) return
    setBusy(true); setErr('')
    try {
      const next = { ...draft, name: draft.name.trim() || 'Untitled' }
      await updateSkill(next)
      setSkills(prev => prev.map(s => s.id === next.id ? next : s))
      setSelected(next); setDraft({ ...next }); setDirty(false)
      toast('Saved', 'success')
    } catch (e) {
      const m = (e as Error).message
      setErr(m); toast(`Save failed: ${m}`, 'error')
    } finally { setBusy(false) }
  }

  async function handleDelete() {
    if (!draft) return
    if (!window.confirm(`Delete skill "${draft.name}"?`)) return
    setBusy(true); setErr('')
    try {
      await deleteSkill(draft.id)
      setSkills(prev => prev.filter(s => s.id !== draft.id))
      setSelected(null); setDraft(null); setDirty(false)
      toast('Deleted', 'success')
    } catch (e) {
      toast(`Delete failed: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }

  return (
    <div className="mgmt-layout ai-skills-layout">
      <aside className="mgmt-sidebar">
        <div className="mgmt-sidebar-hd">
          <span>AI Skills</span>
          <button className="mgmt-new-btn" onClick={handleNew} disabled={busy}>+ New</button>
        </div>
        {loading ? (
          <div className="mgmt-empty">Loading…</div>
        ) : skills.length === 0 ? (
          <div className="mgmt-empty">
            No skills yet. Click <strong>+ New</strong> to add the first one.
          </div>
        ) : (
          <ul className="mgmt-list">
            {skills.map(s => (
              <li
                key={s.id}
                className={`mgmt-list-item${selected?.id === s.id ? ' active' : ''}`}
                onClick={() => selectSkill(s)}
              >
                <span className="mgmt-item-name">
                  {s.enabled && <span className="ai-skill-dot" title="Enabled">●</span>}
                  {s.name}
                </span>
                <span className="mgmt-item-sub">{s.description || (s.instruction ? 'Has instruction' : '—')}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {draft ? (
        <div className="mgmt-detail">
          <div className="mgmt-detail-hd">
            <button
              className="mgmt-back-btn"
              onClick={() => { setSelected(null); setDraft(null); setDirty(false) }}
              title="Back to skills list"
            >←</button>
            <h2>{selected?.name ?? 'Skill'}</h2>
            <span style={{ marginLeft: 'auto' }} />
            <label className="ai-skill-enable">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={e => { setDraft({ ...draft, enabled: e.target.checked }); setDirty(true) }}
                disabled={busy}
              />
              <span>Enabled</span>
            </label>
          </div>

          <div className="mgmt-field-row">
            <label className="mgmt-lbl">Name</label>
            <input
              className="mgmt-input"
              value={draft.name}
              onChange={e => { setDraft({ ...draft, name: e.target.value }); setDirty(true) }}
              placeholder="e.g. Code reviewer"
              disabled={busy}
            />
          </div>
          <div className="mgmt-field-row">
            <label className="mgmt-lbl">Description</label>
            <input
              className="mgmt-input"
              value={draft.description}
              onChange={e => { setDraft({ ...draft, description: e.target.value }); setDirty(true) }}
              placeholder="Short summary shown in the list"
              disabled={busy}
            />
          </div>

          <h3 className="mgmt-section-hd">Instruction</h3>
          <p className="ai-skill-help">
            Free-form prompt that will be prepended as a system message when this
            skill is applied to an AI conversation. Be specific — describe the
            role, tone, output format, and any constraints.
          </p>
          <textarea
            className="ai-skill-instruction"
            rows={14}
            value={draft.instruction}
            onChange={e => { setDraft({ ...draft, instruction: e.target.value }); setDirty(true) }}
            placeholder={`You are a senior staff engineer reviewing TypeScript pull requests.\n- Be concise.\n- Flag clear correctness or security issues first.\n- Suggest specific replacement code, not vague advice.`}
            disabled={busy}
          />

          {err && <div className="login-error" style={{ marginTop: 8 }}>{err}</div>}

          <div className="mgmt-actions">
            <button
              className="rf-btn-cancel"
              onClick={() => { if (selected) { setDraft({ ...selected }); setDirty(false) } }}
              disabled={!dirty || busy}
            >Reset</button>
            <button
              className="mgmt-save-btn"
              onClick={handleSave}
              disabled={!dirty || busy}
            >{busy ? 'Saving…' : 'Save'}</button>
            <span style={{ flex: 1 }} />
            <button
              className="rf-btn-cancel ai-skill-delete"
              onClick={handleDelete}
              disabled={busy}
            >Delete skill</button>
          </div>
        </div>
      ) : (
        <div className="mgmt-empty">Select a skill to edit, or click + New.</div>
      )}
    </div>
  )
}
