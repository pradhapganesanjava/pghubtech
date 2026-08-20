import { useMemo, useState } from 'react'
import { buildTrie, TreeNode } from './DocTagTree'
import Point2RemTree from './Point2RemTree'
import type { LCProblem, LCList } from '../adapters/adsRepo'
import type { P2RItem } from '../adapters/point2remRepo'

type SideTab = 'tags' | 'companies' | 'mylist' | 'point2rem'

interface Props {
  problems:          LCProblem[]
  // Tags (:: lineage)
  selectedTags:      string[]
  onToggleTag:       (t: string) => void
  // Companies
  selectedCompanies: string[]
  onToggleCompany:   (c: string) => void
  // MyList
  lists:             LCList[]
  selectedList:      string | null
  onSelectList:      (name: string | null) => void
  onDeleteList:      (name: string) => void
  onCreateList:      () => void
  onManageList:      (name: string) => void
  // Point2Rem — notes grouped by tag; selecting one opens the detail pane
  p2rItems:          P2RItem[]
  p2rLoading:        boolean
  p2rError:          string
  p2rSelectedId:     string | null
  onSelectP2R:       (item: P2RItem) => void
  onCreateP2R:       () => void
  onRefreshP2R:      () => void
  // Panel chrome
  collapsed:         boolean
  onCollapse:        () => void
}

export default function AdsHubSidebar({
  problems, selectedTags, onToggleTag, selectedCompanies, onToggleCompany,
  lists, selectedList, onSelectList, onDeleteList, onCreateList, onManageList,
  p2rItems, p2rLoading, p2rError, p2rSelectedId, onSelectP2R, onCreateP2R, onRefreshP2R,
  collapsed, onCollapse,
}: Props) {
  const [tab, setTab]       = useState<SideTab>('tags')
  const [search, setSearch] = useState('')
  // Point2Rem grouping shape — hierarchical :: tree, or flat per-tag groups.
  const [p2rMode, setP2rMode] = useState<'tree' | 'flat'>('tree')
  const searchLower = search.toLowerCase()

  const trie = useMemo(() => buildTrie(problems.map(p => p.tags)), [problems])

  // Company → problem count, sorted by frequency then name.
  const companies = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of problems) for (const c of p.companies) counts.set(c, (counts.get(c) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [problems])

  if (collapsed) {
    return <button className="panel-strip-btn" onClick={onCollapse} title="Expand">▸</button>
  }

  const filteredCompanies = searchLower
    ? companies.filter(([c]) => c.toLowerCase().includes(searchLower))
    : companies

  return (
    <>
      <div className="left-tab-bar">
        {/* Titles matter here: the bar is 210px, so equal quarters truncate
            COMPANIES and POINT2REM — hover gives the full label back. */}
        <div className={`left-tab${tab === 'tags' ? ' active' : ''}`} onClick={() => setTab('tags')} title="Tags">Tags</div>
        <div className={`left-tab${tab === 'companies' ? ' active' : ''}`} onClick={() => setTab('companies')} title="Companies">Companies</div>
        <div className={`left-tab${tab === 'mylist' ? ' active' : ''}`} onClick={() => setTab('mylist')} title="MyList">MyList</div>
        <div className={`left-tab${tab === 'point2rem' ? ' active' : ''}`} onClick={() => setTab('point2rem')} title="Points to remember — notes grouped by tag">Point2Rem</div>
        {tab === 'point2rem' && (
          <div className="view-mode-toggle">
            <button
              className={`vm-btn${p2rMode === 'tree' ? ' active' : ''}`}
              title="Hierarchical tree"
              onClick={() => setP2rMode('tree')}
            >⊞</button>
            <button
              className={`vm-btn${p2rMode === 'flat' ? ' active' : ''}`}
              title="Flat groups"
              onClick={() => setP2rMode('flat')}
            >≡</button>
          </div>
        )}
        <button className="panel-toggle-btn" onClick={onCollapse} title="Collapse">◂</button>
      </div>

      {/* Search (all tabs) + New-list button on MyList / reload on Point2Rem */}
      <div style={{ padding: '8px 8px 0', display: 'flex', gap: 6 }}>
        <input
          className="col-search"
          style={{ flex: 1 }}
          placeholder={
            tab === 'tags' ? 'Search tags…' :
            tab === 'companies' ? 'Search companies…' :
            tab === 'mylist' ? 'Search lists…' : 'Search points, tags, #id…'
          }
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {tab === 'mylist' && (
          <button className="rf-btn-save" style={{ whiteSpace: 'nowrap' }} onClick={onCreateList} title="Create a new list">＋ New</button>
        )}
        {tab === 'point2rem' && (
          <>
            <button className="rf-btn-save" style={{ whiteSpace: 'nowrap' }} onClick={onCreateP2R} title="Write a new point">＋ New</button>
            <button className="rf-btn-cancel" onClick={onRefreshP2R} disabled={p2rLoading} title="Reload from the sheet">
              {p2rLoading ? '…' : '↻'}
            </button>
          </>
        )}
      </div>

      {/* ── Tags ─────────────────────────────────────────────── */}
      {tab === 'tags' && (
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
          {Object.keys(trie.children).length === 0 && <div className="col-empty">No tags yet</div>}
        </div>
      )}

      {/* ── Companies ────────────────────────────────────────── */}
      {tab === 'companies' && (
        <div className="tag-flat-list">
          {filteredCompanies.length === 0 && <div className="col-empty">No companies found</div>}
          {filteredCompanies.map(([c, count]) => {
            const active = selectedCompanies.includes(c)
            return (
              <button
                key={c}
                className={`flat-tag-row${active ? ' active' : ''}`}
                onClick={() => onToggleCompany(c)}
                title={c}
              >
                <span className="flat-tag-path"><span className="flat-tag-leaf">{c}</span></span>
                <span className="flat-tag-right"><span className="tree-cnt">{count}</span></span>
              </button>
            )
          })}
        </div>
      )}

      {/* ── MyList ───────────────────────────────────────────── */}
      {tab === 'mylist' && (() => {
        const shown = searchLower ? lists.filter(l => l.name.toLowerCase().includes(searchLower)) : lists
        return (
          <div className="tag-flat-list">
            {lists.length === 0 && (
              <div className="col-empty" style={{ lineHeight: 1.5 }}>
                No lists yet.<br />Use <b>＋ New</b> above, or a problem's <b>★</b>.
              </div>
            )}
            {lists.length > 0 && shown.length === 0 && <div className="col-empty">No lists match</div>}
            {shown.map(l => {
              const active = selectedList === l.name
              return (
                <div key={l.name} className={`adshub-list-row${active ? ' active' : ''}`}>
                  <button
                    className="adshub-list-main"
                    onClick={() => onSelectList(active ? null : l.name)}
                    title={`Filter to ${l.name} (${l.slugs.length})`}
                  >
                    <span className="adshub-list-name">★ {l.name}</span>
                    <span className="tree-cnt">{l.slugs.length}</span>
                  </button>
                  <button className="adshub-list-del" title="Manage list" onClick={() => onManageList(l.name)}>✎</button>
                  <button className="adshub-list-del" title="Delete list" onClick={() => onDeleteList(l.name)}>×</button>
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* ── Point2Rem ────────────────────────────────────────── */}
      {tab === 'point2rem' && (
        <Point2RemTree
          items={p2rItems}
          selectedId={p2rSelectedId}
          onSelect={onSelectP2R}
          searchLower={searchLower}
          mode={p2rMode}
          loading={p2rLoading}
          error={p2rError}
        />
      )}
    </>
  )
}
