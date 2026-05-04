import { useState, useMemo } from 'react'
import type { AnkiNote } from '../adapters/ankiRepo'

interface Props {
  notes: AnkiNote[]
  selectedTags: string[]
  selectedDecks: string[]
  onToggleTag: (tag: string) => void
  onToggleDeck: (deck: string) => void
  onClearAll: () => void
  collapsed: boolean
  onCollapse: () => void
  notDueIds?: Set<string>
}

// ── Trie ──────────────────────────────────────────────────────────────────────

interface TrieNode {
  children: Record<string, TrieNode>
  count: number
  notDue: number
  fullPath: string
}

function buildTrie(recordTags: string[][], recordIds?: string[], notDueIds?: Set<string>): TrieNode {
  const root: TrieNode = { children: {}, count: 0, notDue: 0, fullPath: '' }
  for (let ri = 0; ri < recordTags.length; ri++) {
    const tags = recordTags[ri]
    const isNotDue = notDueIds != null && recordIds != null && notDueIds.has(recordIds[ri])
    const seen        = new Set<string>()
    const seenNotDue  = new Set<string>()
    for (const item of tags) {
      const parts = item.split('::')
      let node = root
      let path = ''
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        path = i === 0 ? part : `${path}::${part}`
        if (!node.children[part]) {
          node.children[part] = { children: {}, count: 0, notDue: 0, fullPath: path }
        }
        if (!seen.has(path)) {
          node.children[part].count++
          seen.add(path)
        }
        if (isNotDue && !seenNotDue.has(path)) {
          node.children[part].notDue++
          seenNotDue.add(path)
        }
        node = node.children[part]
      }
    }
  }
  return root
}

// ── Tree node ─────────────────────────────────────────────────────────────────

interface TreeNodeProps {
  name: string
  node: TrieNode
  depth: number
  selected: string[]
  onToggle: (path: string) => void
  searchLower: string
}

function TreeNode({ name, node, depth, selected, onToggle, searchLower }: TreeNodeProps) {
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
          {node.notDue > 0 && <span className="tree-notdue" title={`${node.notDue} reviewed — not due yet`}>−{node.notDue}</span>}
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
                depth={depth + 1}
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

// ── Main component ────────────────────────────────────────────────────────────

type TabMode  = 'tags' | 'decks'
type ViewMode = 'tree' | 'flat'

export default function TagDeckTree({
  notes,
  selectedTags,
  selectedDecks,
  onToggleTag,
  onToggleDeck,
  onClearAll,
  collapsed,
  onCollapse,
  notDueIds,
}: Props) {
  const [tab,      setTab]      = useState<TabMode>('tags')
  const [viewMode, setViewMode] = useState<ViewMode>('tree')
  const [search,   setSearch]   = useState('')
  const searchLower = search.toLowerCase()

  // ── Faceted filtering ──────────────────────────────────────────────────────
  const deckFilteredNotes = useMemo(() => {
    if (selectedDecks.length === 0) return notes
    return notes.filter(n => {
      const deck = n.deck
      return selectedDecks.some(sd => deck === sd || deck.startsWith(sd + '::'))
    })
  }, [notes, selectedDecks])

  const tagFilteredNotes = useMemo(() => {
    if (selectedTags.length === 0) return notes
    return notes.filter(n => {
      return selectedTags.every(st => n.tags.some(t => t === st || t.startsWith(st + '::')))
    })
  }, [notes, selectedTags])

  // ── Trie data ─────────────────────────────────────────────────────────────
  const tagTrie = useMemo(() => {
    return buildTrie(
      deckFilteredNotes.map(n => n.tags),
      deckFilteredNotes.map(n => n.noteId),
      notDueIds,
    )
  }, [deckFilteredNotes, notDueIds])

  const deckTrie = useMemo(() => {
    return buildTrie(
      tagFilteredNotes.map(n => n.deck ? [n.deck] : []),
      tagFilteredNotes.map(n => n.noteId),
      notDueIds,
    )
  }, [tagFilteredNotes, notDueIds])

  // ── Flat data ─────────────────────────────────────────────────────────────
  const flatTags = useMemo(() => {
    const counts: Record<string, number> = {}
    const notDueCts: Record<string, number> = {}
    for (const n of deckFilteredNotes) {
      const isNotDue = notDueIds?.has(n.noteId) ?? false
      for (const t of n.tags) {
        counts[t] = (counts[t] || 0) + 1
        if (isNotDue) notDueCts[t] = (notDueCts[t] || 0) + 1
      }
    }
    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([t, c]) => [t, c, notDueCts[t] ?? 0] as [string, number, number])
  }, [deckFilteredNotes, notDueIds])

  const flatDecks = useMemo(() => {
    const counts: Record<string, number> = {}
    const notDueCts: Record<string, number> = {}
    for (const n of tagFilteredNotes) {
      const deck = n.deck
      if (deck) {
        const isNotDue = notDueIds?.has(n.noteId) ?? false
        counts[deck] = (counts[deck] || 0) + 1
        if (isNotDue) notDueCts[deck] = (notDueCts[deck] || 0) + 1
      }
    }
    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, c]) => [d, c, notDueCts[d] ?? 0] as [string, number, number])
  }, [tagFilteredNotes, notDueIds])

  if (collapsed) {
    return (
      <button className="panel-strip-btn" onClick={onCollapse} title="Expand">▸</button>
    )
  }

  const trie     = tab === 'tags' ? tagTrie  : deckTrie
  const selected = tab === 'tags' ? selectedTags  : selectedDecks
  const onToggle = tab === 'tags' ? onToggleTag   : onToggleDeck
  const flatList = tab === 'tags' ? flatTags  : flatDecks

  const filteredFlat = searchLower
    ? flatList.filter(([path]) => path.toLowerCase().includes(searchLower))
    : flatList

  return (
    <>
      {/* Tab bar + view toggle */}
      <div className="left-tab-bar">
        <button
          className={`left-tab${tab === 'tags' ? ' active' : ''}`}
          onClick={() => setTab('tags')}
        >
          Tags
          {selectedDecks.length > 0 && (
            <span className="tab-filter-dot" title="Filtered by active decks" />
          )}
        </button>
        <button
          className={`left-tab${tab === 'decks' ? ' active' : ''}`}
          onClick={() => setTab('decks')}
        >
          Decks
          {selectedTags.length > 0 && (
            <span className="tab-filter-dot" title="Filtered by active tags" />
          )}
        </button>

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
          placeholder={`Search ${tab}…`}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {(selectedTags.length > 0 || selectedDecks.length > 0) && (
          <button className="col-hd-clear" style={{ marginTop: 6, width: '100%' }} onClick={onClearAll}>
            Clear all filters
          </button>
        )}
      </div>

      {/* Context note when filtered */}
      {tab === 'tags' && selectedDecks.length > 0 && (
        <div className="filter-context-note">
          Showing tags in {selectedDecks.length === 1 ? 'selected deck' : `${selectedDecks.length} decks`}
        </div>
      )}
      {tab === 'decks' && selectedTags.length > 0 && (
        <div className="filter-context-note">
          Showing decks with selected tags
        </div>
      )}

      {/* Tree view */}
      {viewMode === 'tree' && (
        <div className="tag-tree" style={{ padding: '4px 8px 8px', overflowY: 'auto', flex: 1 }}>
          {Object.entries(trie.children)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, node]) => (
              <TreeNode
                key={node.fullPath}
                name={name}
                node={node}
                depth={0}
                selected={selected}
                onToggle={onToggle}
                searchLower={searchLower}
              />
            ))}
          {Object.keys(trie.children).length === 0 && (
            <div className="col-empty">No {tab} found</div>
          )}
        </div>
      )}

      {/* Flat view */}
      {viewMode === 'flat' && (
        <div className="tag-flat-list" style={{ overflowY: 'auto', flex: 1 }}>
          {filteredFlat.length === 0 && (
            <div className="col-empty">No {tab} found</div>
          )}
          {filteredFlat.map(([path, count, notDue]) => {
            const isActive = selected.includes(path)
            const parts = path.split('::')
            const prefix = parts.slice(0, -1).join('::')
            const leaf   = parts[parts.length - 1]
            return (
              <button
                key={path}
                className={`flat-tag-row${isActive ? ' active' : ''}`}
                onClick={() => onToggle(path)}
                title={path}
              >
                <span className="flat-tag-path">
                  {prefix && <span className="flat-tag-prefix">{prefix}::</span>}
                  <span className="flat-tag-leaf">{leaf}</span>
                </span>
                <span className="flat-tag-right">
                  {notDue > 0 && <span className="flat-tag-notdue" title={`${notDue} reviewed — not due yet`}>−{notDue}</span>}
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
