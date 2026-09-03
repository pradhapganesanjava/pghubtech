import { useEffect, useMemo, useRef, useState } from 'react'
import type { P2RItem } from '../adapters/point2remRepo'
import { P2R_UNTAGGED } from '../adapters/point2remRepo'

// Point2Rem sidebar list. Unlike DocTagTree (which lists *tags* you filter by),
// this tree carries the notes themselves at their tag nodes — the leaf rows are
// clickable items that open in the detail pane. Two shapes, same data:
//   tree — the ::-hierarchy, notes hanging off the node matching their tag
//   flat — one group per full tag path
interface P2RNode {
  children: Record<string, P2RNode>
  items:    P2RItem[]
  fullPath: string
  total:    number      // distinct notes at or below this node
}

const emptyNode = (fullPath: string): P2RNode => ({ children: {}, items: [], fullPath, total: 0 })

function buildP2RTrie(items: P2RItem[]): P2RNode {
  const root = emptyNode('')
  for (const item of items) {
    const tags = item.tags.length ? item.tags : [P2R_UNTAGGED]
    // A note tagged _ds::array AND _ds::heap must count once under _ds, so
    // track which paths this item has already been counted at.
    const counted = new Set<string>()
    for (const tag of tags) {
      const parts = tag.split('::').map(p => p.trim()).filter(Boolean)
      if (parts.length === 0) continue
      let node = root
      let path = ''
      for (let i = 0; i < parts.length; i++) {
        path = i === 0 ? parts[i] : `${path}::${parts[i]}`
        node.children[parts[i]] ??= emptyNode(path)
        node = node.children[parts[i]]
        if (!counted.has(path)) { node.total += 1; counted.add(path) }
      }
      if (!node.items.some(x => x.id === item.id)) node.items.push(item)
    }
  }
  return root
}

interface ItemRowProps {
  item:       P2RItem
  selectedId: string | null
  onSelect:   (item: P2RItem) => void
}

function ItemRow({ item, selectedId, onSelect }: ItemRowProps) {
  return (
    <button
      className={`p2r-item-row${selectedId === item.id ? ' active' : ''}`}
      onClick={() => onSelect(item)}
      title={item.title}
    >
      <span className="p2r-item-title">📌 {item.title}</span>
      {item.problems.length > 0 && (
        <span className="tree-cnt" title={`Linked problems: ${item.problems.map(p => `#${p}`).join(' ')}`}>
          🔗{item.problems.length}
        </span>
      )}
    </button>
  )
}

function expandablePaths(node: P2RNode): string[] {
  const out: string[] = []
  const walk = (n: P2RNode) => {
    for (const child of Object.values(n.children)) {
      if (Object.keys(child.children).length > 0 || child.items.length > 0) {
        out.push(child.fullPath)
      }
      walk(child)
    }
  }
  walk(node)
  return out
}

interface NodeProps {
  name:        string
  node:        P2RNode
  selectedId:  string | null
  selectedTag: string
  onSelect:    (item: P2RItem) => void
  open:        Set<string>
  onToggle:    (path: string) => void
}

function P2RTreeNode({ name, node, selectedId, selectedTag, onSelect, open, onToggle }: NodeProps) {
  const childNames = Object.keys(node.children).sort((a, b) => a.localeCompare(b))
  const hasKids = childNames.length > 0 || node.items.length > 0
  const expanded = open.has(node.fullPath)

  return (
    <div className="tree-node-wrap">
      <div className="tree-row">
        {hasKids ? (
          <button className="tree-toggle" onClick={() => onToggle(node.fullPath)}>{expanded ? '▾' : '▸'}</button>
        ) : (
          <span className="tree-indent" />
        )}
        <button
          className={`tree-lbl${selectedTag === node.fullPath ? ' active' : ''}`}
          onClick={() => onToggle(node.fullPath)}
          title={node.fullPath}
        >
          <span className="tree-tag">{name}</span>
          <span className="tree-cnt">{node.total}</span>
        </button>
      </div>
      {expanded && hasKids && (
        <div className="tree-kids" style={{ paddingLeft: 14 }}>
          {childNames.map(childName => (
            <P2RTreeNode
              key={node.children[childName].fullPath}
              name={childName}
              node={node.children[childName]}
              selectedId={selectedId}
              selectedTag={selectedTag}
              onSelect={onSelect}
              open={open}
              onToggle={onToggle}
            />
          ))}
          {node.items.map(item => (
            <ItemRow key={`${node.fullPath}::${item.id}`} item={item} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

interface Props {
  items:       P2RItem[]
  selectedId:  string | null
  selectedTag: string
  onSelect:    (item: P2RItem) => void
  onPickTag:   (path: string) => void
  searchLower: string
  mode:        'tree' | 'flat'
  loading:     boolean
  error:       string
  // Expand-all / collapse-all, pressed in the sidebar toolbar. The tree owns
  // the per-node open set, so the toolbar sends an instruction (`mode`) and
  // bumps `n` to re-apply it; a repeat press of the same button still works.
  foldCmd:     { mode: 'expand' | 'collapse'; n: number }
}

export default function Point2RemTree({ items, selectedId, selectedTag, onSelect, onPickTag, searchLower, mode, loading, error, foldCmd }: Props) {
  // Filter the notes first, then build the grouping from what survives — so an
  // empty tag branch never shows up while searching.
  const visible = useMemo(() => {
    if (!searchLower) return items
    return items.filter(i =>
      i.title.toLowerCase().includes(searchLower) ||
      i.content.toLowerCase().includes(searchLower) ||
      i.tags.some(t => t.toLowerCase().includes(searchLower)) ||
      i.problems.some(p => `#${p}`.includes(searchLower)))
  }, [items, searchLower])

  const trie = useMemo(() => buildP2RTrie(visible), [visible])
  const foldPaths = useMemo(() => expandablePaths(trie), [trie])
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  function togglePath(path: string) {
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // Depends on the nonce alone: `foldPaths` changes whenever the notes reload,
  // and re-running then would throw away whatever the user had opened.
  useEffect(() => {
    setOpen(foldCmd.mode === 'expand' ? new Set(foldPaths) : new Set())
  }, [foldCmd.n]) // eslint-disable-line react-hooks/exhaustive-deps

  // Searching expands every remaining branch so matches aren't hidden
  // behind a caret; clearing the query collapses back to the roots.
  const searchRef = useRef(searchLower)
  useEffect(() => {
    const prev = searchRef.current
    searchRef.current = searchLower
    if (searchLower) setOpen(new Set(foldPaths))
    else if (prev) setOpen(new Set())
  }, [searchLower, foldPaths])

  // Flat: one group per full tag path, sorted by path.
  const groups = useMemo(() => {
    const byTag = new Map<string, P2RItem[]>()
    for (const item of visible) {
      for (const tag of (item.tags.length ? item.tags : [P2R_UNTAGGED])) {
        const list = byTag.get(tag)
        if (list) list.push(item)
        else byTag.set(tag, [item])
      }
    }
    return [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [visible])

  if (loading) return <div className="col-empty">Loading points…</div>
  if (error)   return <div className="col-empty">Couldn't load Point2Rem: {error}</div>
  if (items.length === 0) {
    return (
      <div className="col-empty" style={{ lineHeight: 1.5 }}>
        No points yet.<br />Use <b>＋ New</b> above to write one.
      </div>
    )
  }
  if (visible.length === 0) return <div className="col-empty">No points match</div>

  if (mode === 'flat') {
    return (
      <div className="tag-flat-list">
        {groups.map(([tag, list]) => {
          const parts  = tag.split('::')
          const prefix = parts.slice(0, -1).join('::')
          const leaf   = parts[parts.length - 1]
          return (
            <div key={tag} className="p2r-group">
              <button
                type="button"
                className={`recall-launch-btn p2r-flat-quiz${selectedTag === tag ? ' active' : ''}`}
                title={`Shuffle Q/A for ${tag}`}
                onClick={() => onPickTag(tag)}
              >
                <span className="recall-launch-label">
                  🎯 <span className="flat-tag-path">
                    {prefix && <span className="flat-tag-prefix">{prefix}::</span>}
                    <span className="flat-tag-leaf">{leaf}</span>
                  </span>
                </span>
                <span className="tree-cnt">{list.length}</span>
              </button>
              {list.map(item => (
                <ItemRow key={`${tag}::${item.id}`} item={item} selectedId={selectedId} onSelect={onSelect} />
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  const roots = Object.keys(trie.children).sort((a, b) => a.localeCompare(b))
  return (
    <div className="tag-tree" style={{ padding: '4px 8px 8px' }}>
      {roots.map(name => (
        <P2RTreeNode
          key={trie.children[name].fullPath}
          name={name}
          node={trie.children[name]}
          selectedId={selectedId}
          selectedTag={selectedTag}
          onSelect={onSelect}
          open={open}
          onToggle={togglePath}
        />
      ))}
    </div>
  )
}
