import { useState, useEffect } from 'react'
import { loadItems, saveItem, type TechItem } from '../adapters/sheetsRepo'
import { useToast } from '../components/Toast'

interface Stats {
  total:      number
  categories: Record<string, number>
  tags:       Record<string, number>
  recent:     TechItem[]
}

function calcStats(items: TechItem[]): Stats {
  const categories: Record<string, number> = {}
  const tags: Record<string, number> = {}

  items.forEach(it => {
    const cat = it.category || 'Uncategorized'
    categories[cat] = (categories[cat] ?? 0) + 1
    it.tags.split(',').map(t => t.trim()).filter(Boolean).forEach(t => {
      tags[t] = (tags[t] ?? 0) + 1
    })
  })

  const recent = [...items]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5)

  return { total: items.length, categories, tags, recent }
}

export default function HomeView() {
  const { toast } = useToast()
  const [items, setItems]     = useState<TechItem[]>([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats]     = useState<Stats>({ total: 0, categories: {}, tags: {}, recent: [] })

  // Quick-add form
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ title: '', content: '', tags: '', category: '' })
  const [saving, setSaving]     = useState(false)

  useEffect(() => {
    loadItems()
      .then(its => { setItems(its); setStats(calcStats(its)) })
      .catch(e => toast(e instanceof Error ? e.message : String(e), 'error'))
      .finally(() => setLoading(false))
  }, [toast])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) return
    setSaving(true)
    try {
      const saved = await saveItem({
        title:    form.title.trim(),
        content:  form.content.trim(),
        tags:     form.tags.trim(),
        category: form.category.trim(),
        notes:    '',
        status:   'active',
      })
      const next = [saved, ...items]
      setItems(next)
      setStats(calcStats(next))
      setForm({ title: '', content: '', tags: '', category: '' })
      setShowForm(false)
      toast('Item added', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading…</span>
      </div>
    )
  }

  const topCats  = Object.entries(stats.categories).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const topTags  = Object.entries(stats.tags).sort((a, b) => b[1] - a[1]).slice(0, 10)

  return (
    <div className="main">
      {/* Stats row */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-value">{stats.total}</div>
          <div className="stat-label">Total Items</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{Object.keys(stats.categories).length}</div>
          <div className="stat-label">Categories</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{Object.keys(stats.tags).length}</div>
          <div className="stat-label">Unique Tags</div>
        </div>
      </div>

      <div className="home-grid">
        {/* Left column */}
        <div className="home-col">
          {/* Quick add */}
          <div className="panel">
            <div className="panel-hd">
              <h2>Quick Add</h2>
              <button className="btn btn-primary btn-sm" onClick={() => setShowForm(v => !v)}>
                {showForm ? 'Cancel' : '+ New Item'}
              </button>
            </div>
            {showForm && (
              <form className="quick-form" onSubmit={handleAdd}>
                <div className="form-group">
                  <label>Title *</label>
                  <input
                    type="text"
                    value={form.title}
                    onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                    placeholder="Item title"
                    autoFocus
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Category</label>
                    <input
                      type="text"
                      value={form.category}
                      onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                      placeholder="e.g. React, DevOps"
                    />
                  </div>
                  <div className="form-group">
                    <label>Tags</label>
                    <input
                      type="text"
                      value={form.tags}
                      onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                      placeholder="comma, separated"
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label>Content</label>
                  <textarea
                    value={form.content}
                    onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                    placeholder="Notes, code snippets, links…"
                    rows={4}
                  />
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            )}
            {!showForm && stats.total === 0 && (
              <p className="empty-msg">No items yet. Add your first tech note!</p>
            )}
          </div>

          {/* Recent items */}
          {stats.recent.length > 0 && (
            <div className="panel">
              <h2>Recent</h2>
              <div className="recent-list">
                {stats.recent.map(it => (
                  <div key={it.id} className="recent-item">
                    <div className="recent-title">{it.title}</div>
                    <div className="recent-meta">
                      {it.category && <span className="cat-chip">{it.category}</span>}
                      {it.tags.split(',').filter(Boolean).slice(0, 3).map(t => (
                        <span key={t} className="tag-chip">{t.trim()}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="home-col">
          {topCats.length > 0 && (
            <div className="panel">
              <h2>Categories</h2>
              <div className="dist-list">
                {topCats.map(([cat, count]) => (
                  <div key={cat} className="dist-row">
                    <span className="dist-label">{cat}</span>
                    <div className="dist-bar-wrap">
                      <div
                        className="dist-bar"
                        style={{ width: `${Math.round((count / stats.total) * 100)}%` }}
                      />
                    </div>
                    <span className="dist-count">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {topTags.length > 0 && (
            <div className="panel">
              <h2>Top Tags</h2>
              <div className="tag-cloud">
                {topTags.map(([tag, count]) => (
                  <span key={tag} className="tag-cloud-item">
                    {tag} <span className="tag-cloud-count">{count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
