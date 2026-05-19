import { useMemo, useState } from 'react'
import type { DocRecord } from '../adapters/docsRepo'

interface Props {
  docs:         DocRecord[]
  selectedTags: string[]
  onToggleTag:  (tag: string) => void
  onClearAll:   () => void
  collapsed:    boolean
  onCollapse:   () => void
}

// ── Trie ─────────────────────────────────────────────────────────────────────

interface TrieNode {
  children: Record<string, TrieNode>
  count:    number
  fullPath: string
}

function buildTrie(tagLists: string[][]): TrieNode {
  const root: TrieNode = { children: {}, count: 0, fullPath: '' }
  for (const tags of tagLists) {
    const seen = new Set<string>()
    for (const t of tags) {
      const parts = t.split('::').map(p => p.trim()).filter(Boolean)
      if (parts.length === 0) continue
      let node = root
      let path = ''
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        path = i === 0 ? part : `${path}::${part}`
        if (!node.children[part]) {
          node.children[part] = { children: {}, count: 0, fullPath: path }
        }
        if (!seen.has(path)) {
          node.children[part].count += 1
          seen.add(path)
        }
        node = node.children[part]
      }
    }
  }
  return root
}

// ── Tree node ────────────────────────────────────────────────────────────────

interface TreeNodeProps {
  name:        string
  node:        TrieNode
  selected:    string[]
  onToggle:    (path: string) => void
  searchLower: string
}

function TreeNode({ name, node, selected, onToggle, searchLower }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const hasChildren = Object.keys(node.children).length > 0
  const isActive    = selected.includes(node.fullPath)

  const matchesSearch = (n: TrieNode, label: string): boolean => {
    if (!searchLower) return true
    if (label.toLowerCase().includes(searchLower)) return true
    return Object.entries(n.children).some(([k, v]) => matchesSearch(v, k))
  }
  if (searchLower && !matchesSearch(node, name)) return null

  return (
    <div className="tree-node-wrap">
      <div className="tree-row">
        {hasChildren ? (
          <button className="tree-toggle" onClick={() => setExpanded(e => !e)}>
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="tree-indent" />
        )}
        <button
          className={`tree-lbl${isActive ? ' active' : ''}`}
          onClick={() => onToggle(node.fullPath)}
        >
          <span className="tree-tag">{name}</span>
          <span className="tree-cnt">{node.count}</span>
        </button>
      </div>
      {expanded && hasChildren && (
        <div className="tree-kids" style={{ paddingLeft: 16 }}>
          {Object.entries(node.children)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([childName, childNode]) => (
              <TreeNode
                key={childNode.fullPath}
                name={childName}
                node={childNode}
                selected={selected}
                onToggle={onToggle}
                searchLower={searchLower}
              />
            ))}
        </div>
      )}
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

type ViewMode = 'tree' | 'flat'

export default function DocTagTree({
  docs, selectedTags, onToggleTag, onClearAll, collapsed, onCollapse,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('tree')
  const [search,   setSearch]   = useState('')
  const searchLower = search.toLowerCase()

  const trie = useMemo(() => buildTrie(docs.map(d => d.tags)), [docs])

  const flatTags = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const d of docs) for (const t of d.tags) counts[t] = (counts[t] || 0) + 1
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
  }, [docs])

  if (collapsed) {
    return (
      <button className="panel-strip-btn" onClick={onCollapse} title="Expand">▸</button>
    )
  }

  const filteredFlat = searchLower
    ? flatTags.filter(([path]) => path.toLowerCase().includes(searchLower))
    : flatTags

  return (
    <>
      {/* Header bar with view toggle + collapse — mirrors TagDeckTree pattern */}
      <div className="left-tab-bar">
        <div className="left-tab active" style={{ cursor: 'default' }}>Tags</div>
        <div className="view-mode-toggle">
          <button
            className={`vm-btn${viewMode === 'tree' ? ' active' : ''}`}
            title="Hierarchical tree"
            onClick={() => setViewMode('tree')}
          >⊞</button>
          <button
            className={`vm-btn${viewMode === 'flat' ? ' active' : ''}`}
            title="Flat list"
            onClick={() => setViewMode('flat')}
          >≡</button>
        </div>
        <button className="panel-toggle-btn" onClick={onCollapse} title="Collapse">◂</button>
      </div>

      {/* Search + clear */}
      <div style={{ padding: '8px 8px 0' }}>
        <input
          className="col-search"
          placeholder="Search tags…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {selectedTags.length > 0 && (
          <button
            className="col-hd-clear"
            style={{ marginTop: 6, width: '100%' }}
            onClick={onClearAll}
          >
            Clear all filters
          </button>
        )}
      </div>

      {/* Tree view */}
      {viewMode === 'tree' && (
        <div className="tag-tree" style={{ padding: '4px 8px 8px' }}>
          {Object.entries(trie.children)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, node]) => (
              <TreeNode
                key={node.fullPath}
                name={name}
                node={node}
                selected={selectedTags}
                onToggle={onToggleTag}
                searchLower={searchLower}
              />
            ))}
          {Object.keys(trie.children).length === 0 && (
            <div className="col-empty">No tags yet</div>
          )}
        </div>
      )}

      {/* Flat view */}
      {viewMode === 'flat' && (
        <div className="tag-flat-list">
          {filteredFlat.length === 0 && (
            <div className="col-empty">No tags found</div>
          )}
          {filteredFlat.map(([path, count]) => {
            const isActive = selectedTags.includes(path)
            const parts    = path.split('::')
            const prefix   = parts.slice(0, -1).join('::')
            const leaf     = parts[parts.length - 1]
            return (
              <button
                key={path}
                className={`flat-tag-row${isActive ? ' active' : ''}`}
                onClick={() => onToggleTag(path)}
                title={path}
              >
                <span className="flat-tag-path">
                  {prefix && <span className="flat-tag-prefix">{prefix}::</span>}
                  <span className="flat-tag-leaf">{leaf}</span>
                </span>
                <span className="flat-tag-right">
                  <span className="tree-cnt">{count}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
