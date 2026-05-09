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
      const parts = t.split('::').filter(Boolean)
      let cur = root
      let path = ''
      for (const part of parts) {
        path = path ? `${path}::${part}` : part
        if (!cur.children[part]) {
          cur.children[part] = { children: {}, count: 0, fullPath: path }
        }
        cur = cur.children[part]
        if (!seen.has(path)) {
          cur.count += 1
          seen.add(path)
        }
      }
    }
  }
  return root
}

function TreeNode({
  name, node, depth, selected, onToggle,
}: {
  name:     string
  node:     TrieNode
  depth:    number
  selected: string[]
  onToggle: (path: string) => void
}) {
  const [open, setOpen] = useState(depth < 1)
  const childKeys = Object.keys(node.children).sort()
  const hasChildren = childKeys.length > 0
  const isSel = selected.includes(node.fullPath)

  return (
    <div>
      <div
        className={`tdt-row${isSel ? ' sel' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onToggle(node.fullPath)}
      >
        {hasChildren ? (
          <button
            className="tdt-caret"
            onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
            aria-label={open ? 'Collapse' : 'Expand'}
          >{open ? '▾' : '▸'}</button>
        ) : <span className="tdt-caret-spacer" />}
        <span className="tdt-name">{name}</span>
        <span className="tdt-count">{node.count}</span>
      </div>
      {open && hasChildren && (
        <div>
          {childKeys.map(k => (
            <TreeNode
              key={k}
              name={k}
              node={node.children[k]}
              depth={depth + 1}
              selected={selected}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function DocTagTree({
  docs, selectedTags, onToggleTag, onClearAll, collapsed, onCollapse,
}: Props) {
  const trie = useMemo(() => buildTrie(docs.map(d => d.tags)), [docs])
  const topKeys = Object.keys(trie.children).sort()

  if (collapsed) {
    return (
      <div className="browse-col-tags-inner collapsed">
        <button className="col-collapse-btn" onClick={onCollapse} title="Show tags">›</button>
      </div>
    )
  }

  return (
    <div className="browse-col-tags-inner">
      <div className="col-hd">
        <span>Tags</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {selectedTags.length > 0 && (
            <button className="col-clear-btn" onClick={onClearAll}>Clear</button>
          )}
          <button className="col-collapse-btn" onClick={onCollapse} title="Hide tags">‹</button>
        </div>
      </div>
      <div className="tdt-list">
        {topKeys.length === 0 && <div className="tdt-empty">No tags yet</div>}
        {topKeys.map(k => (
          <TreeNode
            key={k}
            name={k}
            node={trie.children[k]}
            depth={0}
            selected={selectedTags}
            onToggle={onToggleTag}
          />
        ))}
      </div>
    </div>
  )
}
