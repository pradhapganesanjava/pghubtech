import { useEffect, useMemo, useState } from 'react'
import { buildTrie, TreeNode } from './DocTagTree'
import Point2RemTree from './Point2RemTree'
import type { LCProblem, LCList } from '../adapters/adsRepo'
import type { P2RItem } from '../adapters/point2remRepo'
import { loadFilters, saveFilters } from '../lib/persistedFilters'

type SideTab = 'tags' | 'companies' | 'mylist' | 'point2rem'

// The sidebar shows only the panels you've opened, not all four: four tabs in
// a 210px bar truncate every label. Pick from the ⋮ menu, close with ✕.
const TAB_META: { id: SideTab; label: string; title: string }[] = [
  { id: 'tags',      label: 'Tags',      title: 'Tags — the :: lineage tree' },
  { id: 'companies', label: 'Companies', title: 'Companies' },
  { id: 'mylist',    label: 'MyList',    title: 'MyList — your saved lists' },
  { id: 'point2rem', label: 'Point2Rem', title: 'Points to remember — notes grouped by tag' },
]
const TAB_IDS = TAB_META.map(t => t.id)
const tabLabel = (id: SideTab) => TAB_META.find(t => t.id === id)?.label ?? id
const tabTitle = (id: SideTab) => TAB_META.find(t => t.id === id)?.title ?? id

interface TabState { open: SideTab[]; active: SideTab }

// MyList alone on first visit — it's the one you open by reflex, and the other
// three are a click away in the menu.
const TABS_KEY = 'adshub.sidebarTabs'
const TABS_DEFAULT: TabState = { open: ['mylist'], active: 'mylist' }

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
  p2rSelectedTag:    string
  onSelectP2R:       (item: P2RItem) => void
  onPickP2RTag:      (path: string) => void
  onCreateP2R:       () => void
  onRefreshP2R:      () => void
  // Quiz/Recall — random Q/A over the Point2Rem notes in this tree. Writing a
  // new card is the deck's own ＋, not the sidebar's.
  recallCount:       number
  recallActive:      boolean
  onOpenRecall:      () => void
  // Panel chrome
  collapsed:         boolean
  onCollapse:        () => void
}

// ── MyList hierarchy ────────────────────────────────────────────────────────
// LCLists has no parent column; nesting is carried in the name, split on `::`
// exactly as tags are. "C3AI::P0" therefore hangs under "C3AI" whether or not
// a row literally named "C3AI" exists — hence `self` being nullable.
interface ListNode {
  path:     string          // full `::` path, i.e. what selecting it filters by
  label:    string          // last segment only
  self:     LCList | null   // the list at this exact path, if one exists
  children: ListNode[]
}

// Count = distinct slugs across this node and everything under it, matching
// what AdsHubView's listSlugs union will actually show when the row is clicked.
// A slug in both the parent and a child must not be counted twice.
function nodeCount(n: ListNode): number {
  const seen = new Set<string>()
  const walk = (x: ListNode) => {
    for (const s of x.self?.slugs ?? []) seen.add(s)
    x.children.forEach(walk)
  }
  walk(n)
  return seen.size
}

export function buildListTree(lists: LCList[]): ListNode[] {
  const roots: ListNode[] = []
  const byPath = new Map<string, ListNode>()
  const ensure = (path: string): ListNode => {
    const hit = byPath.get(path)
    if (hit) return hit
    const segs = path.split('::')
    const node: ListNode = { path, label: segs[segs.length - 1], self: null, children: [] }
    byPath.set(path, node)
    if (segs.length === 1) roots.push(node)
    else ensure(segs.slice(0, -1).join('::')).children.push(node)
    return node
  }
  // Shortest paths first so a parent node exists before its children attach.
  for (const l of [...lists].sort((a, b) => a.name.split('::').length - b.name.split('::').length)) {
    ensure(l.name).self = l
  }
  const sortRec = (ns: ListNode[]) => {
    ns.sort((a, b) => a.label.localeCompare(b.label))
    ns.forEach(n => sortRec(n.children))
  }
  sortRec(roots)
  return roots
}

function ListNodeRow({
  node, depth, selectedList, expanded, onToggleExpand, onSelectList, onDeleteList, onManageList,
}: {
  node: ListNode; depth: number; selectedList: string | null
  expanded: Record<string, boolean>
  onToggleExpand: (path: string) => void
  onSelectList: (name: string | null) => void
  onDeleteList: (name: string) => void
  onManageList: (name: string) => void
}) {
  const active   = selectedList === node.path
  const hasKids  = node.children.length > 0
  const isOpen   = expanded[node.path] ?? true
  const count    = nodeCount(node)
  return (
    <>
      <div className={`adshub-list-row${active ? ' active' : ''}`} style={{ paddingLeft: depth * 12 }}>
        {hasKids ? (
          <button
            className="adshub-list-caret"
            onClick={() => onToggleExpand(node.path)}
            title={isOpen ? 'Collapse' : 'Expand'}
          >{isOpen ? '▾' : '▸'}</button>
        ) : <span className="adshub-list-caret adshub-list-caret--leaf" />}
        <button
          className="adshub-list-main"
          onClick={() => onSelectList(active ? null : node.path)}
          title={hasKids
            ? `Filter to ${node.path} and everything under it (${count})`
            : `Filter to ${node.path} (${count})`}
        >
          <span className="adshub-list-name">{hasKids ? '📂' : '★'} {node.label}</span>
          <span className="tree-cnt">{count}</span>
        </button>
        {/* Manage / delete act on a real list only — a virtual parent has none. */}
        {node.self && <>
          <button className="adshub-list-del" title="Manage list" onClick={() => onManageList(node.path)}>✎</button>
          <button className="adshub-list-del" title="Delete list" onClick={() => onDeleteList(node.path)}>×</button>
        </>}
      </div>
      {hasKids && isOpen && node.children.map(c => (
        <ListNodeRow
          key={c.path}
          node={c}
          depth={depth + 1}
          selectedList={selectedList}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          onSelectList={onSelectList}
          onDeleteList={onDeleteList}
          onManageList={onManageList}
        />
      ))}
    </>
  )
}

export default function AdsHubSidebar({
  problems, selectedTags, onToggleTag, selectedCompanies, onToggleCompany,
  lists, selectedList, onSelectList, onDeleteList, onCreateList, onManageList,
  p2rItems, p2rLoading, p2rError, p2rSelectedId, p2rSelectedTag, onSelectP2R, onPickP2RTag, onCreateP2R, onRefreshP2R,
  recallCount, recallActive, onOpenRecall,
  collapsed, onCollapse,
}: Props) {
  const [tabs, setTabs]     = useState<TabState>(() => {
    const saved = loadFilters<TabState>(TABS_KEY, TABS_DEFAULT)
    // Stored ids can be stale (a panel renamed or dropped) — keep known ones.
    const open = (Array.isArray(saved.open) ? saved.open : []).filter(t => TAB_IDS.includes(t))
    const active = TAB_IDS.includes(saved.active) ? saved.active : open[0] ?? TABS_DEFAULT.active
    return { open, active }
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  // Point2Rem grouping shape — hierarchical :: tree, or flat per-tag groups.
  const [p2rMode, setP2rMode] = useState<'tree' | 'flat'>('tree')
  // Last expand/collapse-all instruction sent to the tag tree. `mode` is what
  // the button most recently DID, so the icon offers the opposite next.
  const [fold, setFold] = useState<{ mode: 'expand' | 'collapse'; n: number }>({ mode: 'collapse', n: 0 })
  // Expanded state per list-tree path; absent ⇒ open, so a freshly-created
  // sub-list is visible without hunting for a caret.
  const [listOpen, setListOpen] = useState<Record<string, boolean>>({})
  const searchLower = search.toLowerCase()

  useEffect(() => { saveFilters(TABS_KEY, tabs) }, [tabs])

  // The active panel counts only while it's still open; with nothing open the
  // body shows the picker prompt rather than a stale panel.
  const tab: SideTab | null = tabs.open.includes(tabs.active) ? tabs.active : null

  // Opened tabs hold the canonical order however you opened them, so the bar
  // never reshuffles under the cursor.
  const openTab = (id: SideTab) => setTabs(s => ({
    open: TAB_IDS.filter(t => t === id || s.open.includes(t)),
    active: id,
  }))
  const closeTab = (id: SideTab) => setTabs(s => {
    const open = s.open.filter(t => t !== id)
    if (s.active !== id) return { open, active: s.active }
    // Closing the active tab hands focus to whatever slid into its slot (or
    // the new last tab) — an editor tab strip's behaviour.
    const at = Math.min(s.open.indexOf(id), open.length - 1)
    return { open, active: at >= 0 ? open[at] : s.active }
  })

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
        {/* Panel picker. Checkbox = open/closed, label = open-and-focus. The
            scrim closes the menu on any outside click without a document
            listener. */}
        <div className="left-tab-picker">
          <button
            className={`left-tab-menu-btn${menuOpen ? ' active' : ''}`}
            onClick={() => setMenuOpen(o => !o)}
            title="Choose which panels are open"
          >⋮</button>
          {menuOpen && (
            <>
              <div className="left-tab-scrim" onClick={() => setMenuOpen(false)} />
              <div className="left-tab-menu">
                {TAB_META.map(m => {
                  const isOpen = tabs.open.includes(m.id)
                  return (
                    <div key={m.id} className={`left-tab-menu-row${tab === m.id ? ' active' : ''}`} title={m.title}>
                      <input
                        type="checkbox"
                        className="left-tab-menu-cb"
                        checked={isOpen}
                        onChange={() => isOpen ? closeTab(m.id) : openTab(m.id)}
                        title={isOpen ? 'Close this panel' : 'Open this panel'}
                      />
                      <button
                        className="left-tab-menu-lbl"
                        onClick={() => { openTab(m.id); setMenuOpen(false) }}
                      >{m.label}</button>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
        {tabs.open.map(id => (
          <div
            key={id}
            className={`left-tab${tab === id ? ' active' : ''}`}
            onClick={() => openTab(id)}
            title={tabTitle(id)}
          >
            <span className="left-tab-lbl">{tabLabel(id)}</span>
            <button
              className="left-tab-close"
              onClick={e => { e.stopPropagation(); closeTab(id) }}
              title={`Close ${tabLabel(id)}`}
            >✕</button>
          </div>
        ))}
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

      {!tab && (
        <div className="col-empty" style={{ lineHeight: 1.6, padding: '14px 10px' }}>
          No panel open.<br />Pick one from <b>⋮</b> above.
        </div>
      )}

      {/* Search (open panel) + New-list button on MyList. Point2Rem puts its
          whole toolbar here — quiz, new note, reload, fold — as icons, so the
          panel is one row of chrome instead of three stacked strips. */}
      {tab && (
      <div className="side-tool-row">
        <input
          className="col-search"
          placeholder={
            tab === 'tags' ? 'Search tags…' :
            tab === 'companies' ? 'Search companies…' :
            // Short on purpose: Point2Rem shares this row with four icons, so
            // anything longer renders mid-word-truncated at 210px.
            tab === 'mylist' ? 'Search lists…' : 'Search…'
          }
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {tab === 'mylist' && (
          <button className="rf-btn-save" style={{ whiteSpace: 'nowrap' }} onClick={onCreateList} title="Create a new list">＋ New</button>
        )}
        {tab === 'point2rem' && (
          <>
            <button
              className={`p2r-tool p2r-tool-quiz${recallActive ? ' active' : ''}`}
              onClick={onOpenRecall}
              title={`Quiz / Recall — shuffle all ${recallCount} notes as Q/A. Click a tag below to drill one branch.`}
            >🎯<span className="p2r-tool-cnt">{recallCount}</span></button>
            <button className="p2r-tool" onClick={onCreateP2R} title="Write a new point">＋</button>
            <button className="p2r-tool" onClick={onRefreshP2R} disabled={p2rLoading} title="Reload from the sheet">
              {p2rLoading ? '…' : '↻'}
            </button>
            {p2rMode === 'tree' && (
              <button
                className="p2r-tool"
                onClick={() => setFold(f => ({ mode: f.mode === 'expand' ? 'collapse' : 'expand', n: f.n + 1 }))}
                title={fold.mode === 'expand' ? 'Collapse all — show only top-level tags' : 'Expand all tag branches'}
              >{fold.mode === 'expand' ? '▸' : '▾'}</button>
            )}
          </>
        )}
      </div>
      )}

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
        // Lists nest on `::`, like tags: "C3AI::P0" hangs under "C3AI". A
        // parent row may be virtual — a list can have children without itself
        // existing as a row in LCLists — so nodes are built from the name
        // segments rather than from the list array directly.
        const roots = buildListTree(shown)
        return (
          <div className="tag-flat-list">
            {lists.length === 0 && (
              <div className="col-empty" style={{ lineHeight: 1.5 }}>
                No lists yet.<br />Use <b>＋ New</b> above, or a problem's <b>★</b>.
              </div>
            )}
            {lists.length > 0 && shown.length === 0 && <div className="col-empty">No lists match</div>}
            {roots.map(n => (
              <ListNodeRow
                key={n.path}
                node={n}
                depth={0}
                selectedList={selectedList}
                expanded={listOpen}
                onToggleExpand={p => setListOpen(s => ({ ...s, [p]: !(s[p] ?? true) }))}
                onSelectList={onSelectList}
                onDeleteList={onDeleteList}
                onManageList={onManageList}
              />
            ))}
          </div>
        )
      })()}

      {/* ── Point2Rem ────────────────────────────────────────── */}
      {tab === 'point2rem' && (
        <Point2RemTree
          items={p2rItems}
          selectedId={p2rSelectedId}
          selectedTag={p2rSelectedTag}
          onSelect={onSelectP2R}
          onPickTag={onPickP2RTag}
          searchLower={searchLower}
          mode={p2rMode}
          loading={p2rLoading}
          error={p2rError}
          foldCmd={fold}
        />
      )}
    </>
  )
}
