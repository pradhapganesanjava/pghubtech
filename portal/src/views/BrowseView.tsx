import { useState, useEffect, useMemo } from 'react'
import { loadItems, saveItem, updateItem, deleteItem, type TechItem } from '../adapters/sheetsRepo'
import { useToast } from '../components/Toast'

type SortKey = 'title' | 'category' | 'created_at' | 'status'
type SortDir = 'asc' | 'desc'

const EMPTY_FORM = { title: '', content: '', tags: '', category: '', notes: '', status: 'active' }

export default function BrowseView() {
  const { toast } = useToast()
  const [items, setItems]     = useState<TechItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('created_at')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const [editItem, setEditItem] = useState<TechItem | null>(null)
  const [showAdd, setShowAdd]   = useState(false)
  const [form, setForm]         = useState({ ...EMPTY_FORM })
  const [saving, setSaving]     = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    loadItems()
      .then(setItems)
      .catch(e => toast(e instanceof Error ? e.message : String(e), 'error'))
      .finally(() => setLoading(false))
  }, [toast])

  const categories = useMemo(() => {
    const cats = new Set<string>()
    items.forEach(it => { if (it.category) cats.add(it.category) })
    return Array.from(cats).sort()
  }, [items])

  const filtered = useMemo(() => {
    let list = items
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(it =>
        it.title.toLowerCase().includes(q) ||
        it.content.toLowerCase().includes(q) ||
        it.tags.toLowerCase().includes(q) ||
        it.category.toLowerCase().includes(q)
      )
    }
    if (catFilter) list = list.filter(it => it.category === catFilter)
    list = [...list].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    })
    return list
  }, [items, search, catFilter, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function openEdit(it: TechItem) {
    setEditItem(it)
    setForm({ title: it.title, content: it.content, tags: it.tags, category: it.category, notes: it.notes, status: it.status })
    setShowAdd(false)
  }

  function openAdd() {
    setEditItem(null)
    setForm({ ...EMPTY_FORM })
    setShowAdd(true)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) return
    setSaving(true)
    try {
      if (editItem) {
        const updated: TechItem = { ...editItem, ...form, title: form.title.trim() }
        await updateItem(updated)
        setItems(prev => prev.map(it => it.id === updated.id ? updated : it))
        toast('Updated', 'success')
        setEditItem(null)
      } else {
        const saved = await saveItem({ ...form, title: form.title.trim() })
        setItems(prev => [saved, ...prev])
        toast('Added', 'success')
        setShowAdd(false)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this item?')) return
    setDeleting(id)
    try {
      await deleteItem(id)
      setItems(prev => prev.filter(it => it.id !== id))
      if (editItem?.id === id) setEditItem(null)
      toast('Deleted', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setDeleting(null)
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

  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey === k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  return (
    <div className="browse-layout">
      {/* Controls */}
      <div className="browse-controls">
        <input
          className="browse-search"
          type="text"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="browse-filter"
          value={catFilter}
          onChange={e => setCatFilter(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add</button>
      </div>

      <div className="browse-body">
        {/* Table */}
        <div className="browse-table-wrap">
          <table className="browse-table">
            <thead>
              <tr>
                <th onClick={() => toggleSort('title')} className="sortable">
                  Title<SortIcon k="title" />
                </th>
                <th onClick={() => toggleSort('category')} className="sortable">
                  Category<SortIcon k="category" />
                </th>
                <th>Tags</th>
                <th onClick={() => toggleSort('status')} className="sortable">
                  Status<SortIcon k="status" />
                </th>
                <th onClick={() => toggleSort('created_at')} className="sortable">
                  Created<SortIcon k="created_at" />
                </th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="browse-empty">No items found.</td></tr>
              )}
              {filtered.map(it => (
                <tr
                  key={it.id}
                  className={editItem?.id === it.id ? 'row-selected' : ''}
                  onClick={() => openEdit(it)}
                >
                  <td className="col-title">{it.title}</td>
                  <td>{it.category && <span className="cat-chip">{it.category}</span>}</td>
                  <td>
                    <div className="tag-chips">
                      {it.tags.split(',').filter(Boolean).map(t => (
                        <span key={t} className="tag-chip">{t.trim()}</span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <span className={`status-chip ${it.status}`}>{it.status}</span>
                  </td>
                  <td className="col-date">
                    {it.created_at ? new Date(it.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td>
                    <button
                      className="row-del-btn"
                      onClick={e => { e.stopPropagation(); handleDelete(it.id) }}
                      disabled={deleting === it.id}
                      title="Delete"
                    >
                      {deleting === it.id ? '…' : '✕'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Side form */}
        {(showAdd || editItem) && (
          <div className="browse-form-panel">
            <div className="browse-form-hd">
              <span>{editItem ? 'Edit Item' : 'New Item'}</span>
              <button className="icon-btn" onClick={() => { setShowAdd(false); setEditItem(null) }}>✕</button>
            </div>
            <form onSubmit={handleSave} className="browse-form">
              <div className="form-group">
                <label>Title *</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
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
                    list="cat-list"
                  />
                  <datalist id="cat-list">
                    {categories.map(c => <option key={c} value={c} />)}
                  </datalist>
                </div>
                <div className="form-group">
                  <label>Status</label>
                  <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                    <option value="active">active</option>
                    <option value="draft">draft</option>
                    <option value="archived">archived</option>
                  </select>
                </div>
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
              <div className="form-group">
                <label>Content</label>
                <textarea
                  value={form.content}
                  onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                  rows={6}
                />
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={3}
                />
              </div>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                {editItem && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => handleDelete(editItem.id)}
                    disabled={!!deleting}
                  >
                    Delete
                  </button>
                )}
              </div>
            </form>
          </div>
        )}
      </div>

      <div className="browse-footer">{filtered.length} / {items.length} items</div>
    </div>
  )
}
