// The Thoughts navigator: path groups with the thoughts themselves as leaves,
// so a title in the tree opens that one thought rather than only filtering a
// stacked list. Same '::' paths as the Docs / AdsHub tag trees, but those trees
// carry counts alone — this one has to carry items, hence its own trie.

import { useEffect, useMemo, useState } from 'react'
import type { DartThought } from '../adapters/dartRepo'

export const UNFILED = 'Unfiled'

export interface TNode {
  name:     string
  path:     string                 // full '::' path to this node
  children: Map<string, TNode>
  items:    DartThought[]          // thoughts filed exactly here
  count:    number                 // thoughts in this whole subtree
}

function emptyNode(name: string, path: string): TNode {
  return { name, path, children: new Map(), items: [], count: 0 }
}

export function buildThoughtTree(thoughts: DartThought[]): TNode {
  const root = emptyNode('', '')
  for (const t of thoughts) {
    const parts = (t.path || UNFILED).split('::').map(p => p.trim()).filter(Boolean)
    let node = root
    node.count++
    let path = ''
    for (const part of parts.length ? parts : [UNFILED]) {
      path = path ? `${path}::${part}` : part
      let next = node.children.get(part)
      if (!next) { next = emptyNode(part, path); node.children.set(part, next) }
      next.count++
      node = next
    }
    node.items.push(t)
  }
  return root
}

export function titleOf(t: DartThought): string {
  const s = (t.summary || '').trim()
  if (s) return s
  const line = (t.raw || '').split('\n').map(x => x.trim()).find(Boolean) ?? '(empty)'
  return line.length > 70 ? line.slice(0, 67) + '…' : line
}

// Every ancestor path of a node, so the tree can open itself to a selection.
function ancestorsOf(path: string): string[] {
  const parts = path.split('::')
  return parts.map((_, i) => parts.slice(0, i + 1).join('::'))
}

interface Props {
  thoughts:     DartThought[]      // already filtered by search / bucket
  selectedId:   string | null
  selectedPath: string             // '' = no group filter
  onPickThought: (t: DartThought) => void
  onPickPath:    (path: string) => void
  /** Open every node — used while a search is narrowing the list. */
  expandAll:    boolean
}

export default function ThoughtTree({
  thoughts, selectedId, selectedPath, onPickThought, onPickPath, expandAll,
}: Props) {
  const root = useMemo(() => buildThoughtTree(thoughts), [thoughts])
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  // Reveal the selected thought wherever it lives, so picking one from search
  // or from the list leaves the tree pointing at it.
  const selected = thoughts.find(t => t.id === selectedId)
  useEffect(() => {
    if (!selected) return
    setOpen(prev => {
      const next = new Set(prev)
      for (const p of ancestorsOf(selected.path || UNFILED)) next.add(p)
      return next
    })
  }, [selected?.id, selected?.path]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(path: string) {
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      return next
    })
  }

  if (root.count === 0) return <div className="col-empty">Nothing here.</div>

  return (
    <div className="tt-root">
      {[...root.children.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(n => (
          <TreeBranch
            key={n.path} node={n} depth={0}
            open={open} expandAll={expandAll} onToggle={toggle}
            selectedId={selectedId} selectedPath={selectedPath}
            onPickThought={onPickThought} onPickPath={onPickPath}
          />
        ))}
    </div>
  )
}

function TreeBranch({
  node, depth, open, expandAll, onToggle,
  selectedId, selectedPath, onPickThought, onPickPath,
}: {
  node: TNode; depth: number
  open: Set<string>; expandAll: boolean; onToggle: (p: string) => void
  selectedId: string | null; selectedPath: string
  onPickThought: (t: DartThought) => void; onPickPath: (p: string) => void
}) {
  const isOpen   = expandAll || open.has(node.path)
  const hasKids  = node.children.size > 0 || node.items.length > 0
  const isActive = selectedPath === node.path

  return (
    <div className="tt-branch">
      <div className="tt-row" style={{ paddingLeft: depth * 12 }}>
        {hasKids ? (
          <button
            className="tt-caret" onClick={() => onToggle(node.path)}
            aria-expanded={isOpen} title={isOpen ? 'Collapse' : 'Expand'}
          >{isOpen ? '▾' : '▸'}</button>
        ) : <span className="tt-caret-gap" />}
        <button
          className={`tt-group${isActive ? ' active' : ''}`}
          onClick={() => onPickPath(node.path)}
          title={node.path}
        >
          <span className="tt-group-name">{node.name}</span>
          <span className="tt-count">{node.count}</span>
        </button>
      </div>

      {isOpen && (
        <>
          {[...node.children.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(c => (
              <TreeBranch
                key={c.path} node={c} depth={depth + 1}
                open={open} expandAll={expandAll} onToggle={onToggle}
                selectedId={selectedId} selectedPath={selectedPath}
                onPickThought={onPickThought} onPickPath={onPickPath}
              />
            ))}
          {node.items.map(t => (
            <button
              key={t.id}
              className={`tt-leaf${selectedId === t.id ? ' active' : ''}`}
              style={{ paddingLeft: (depth + 1) * 12 + 20 }}
              onClick={() => onPickThought(t)}
              title={titleOf(t)}
            >
              <span className="tt-leaf-dot" aria-hidden>💭</span>
              <span className="tt-leaf-title">{titleOf(t)}</span>
              <span className="tt-leaf-date">{t.date.slice(5)}</span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}
