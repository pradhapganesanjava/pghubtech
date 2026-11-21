// Solve Map — the data behind Solve Path's 🗺 Map: a problem's aspects, the
// zoomable hierarchy for each map layer, problem-to-problem match scores, and
// routes between problems. Pure functions over LCProblems' pat_* tags and the
// user's Comfort levels.
//
// Aspects (what two problems can have in common):
//   📦 ds      — the input data structure        pat_ds::<ds>::…
//   🧰 tech    — the technique: topic + micro     pat_topic::<topic>::<micro>,
//                                                 pat_ds::<ds>::<topic|core>::<micro>
//   🗂 family  — the problem family (+ engine)   pat_group::<group>[::<engine>]
//   📖 story   — the story cue                    pat_story::<cue>[::<micro>]
//
// Match score: cosine similarity over weighted features. A feature's weight is
// its base weight × the aspect's on/off switch × its rarity (IDF), so sharing
// "Multi-Source BFS" counts for far more than sharing "Array".

import type { LCProblem } from '../adapters/adsRepo'
import type { ComfortEntry } from '../adapters/comfortRepo'

export type Aspect = 'ds' | 'tech' | 'family' | 'story'
export const ASPECTS: { id: Aspect; label: string; icon: string }[] = [
  { id: 'ds',     label: 'Data structure', icon: '📦' },
  { id: 'tech',   label: 'Technique',      icon: '🧰' },
  { id: 'family', label: 'Problem family', icon: '🗂' },
  { id: 'story',  label: 'Story',          icon: '📖' },
]
export type AspectOn = Record<Aspect, boolean>

// Feature keys: "<kind>:<id>". Kind → aspect and base weight.
const KIND: Record<string, { aspect: Aspect; base: number }> = {
  ds:    { aspect: 'ds',     base: 1 },
  topic: { aspect: 'tech',   base: 0.6 },
  micro: { aspect: 'tech',   base: 1 },
  fam:   { aspect: 'family', base: 1 },
  eng:   { aspect: 'family', base: 0.6 },
  cue:   { aspect: 'story',  base: 1 },
}
export const aspectOfKey = (k: string): Aspect => KIND[k.slice(0, k.indexOf(':'))]?.aspect ?? 'tech'

export interface Names { micro: Map<string, string>; topic: Map<string, string> }
const ACRONYM: Record<string, string> = {
  bfs: 'BFS', dfs: 'DFS', dp: 'DP', bst: 'BST', lca: 'LCA', lis: 'LIS', lcs: 'LCS',
  kmp: 'KMP', uf: 'Union-Find', lru: 'LRU', dag: 'DAG', mst: 'MST', ii: 'II', iii: 'III',
}
const pretty = (id: string) =>
  id.split(/[-_]/).map(w => ACRONYM[w] ?? w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

// Human label for a feature key, e.g. "micro:bfs-multi-source" → "Multi-Source BFS".
export function featureLabel(k: string, names: Names | null): string {
  const i = k.indexOf(':'), kind = k.slice(0, i), id = k.slice(i + 1)
  if (kind === 'micro') return names?.micro.get(id) ?? pretty(id)
  if (kind === 'ds' || kind === 'topic') return names?.topic.get(id) ?? pretty(id)
  if (kind === 'eng') return pretty(id.split('/')[1] ?? id)
  return pretty(id)
}

function featuresOf(p: LCProblem): Set<string> {
  const f = new Set<string>()
  for (const t of p.tags) {
    const s = t.split('::')
    if (s[0] === 'pat_ds' && s.length === 4) {
      f.add('ds:' + s[1]); f.add('micro:' + s[3])
      if (s[2] !== 'core') f.add('topic:' + s[2])
    } else if (s[0] === 'pat_topic' && s.length === 3) {
      f.add('topic:' + s[1]); f.add('micro:' + s[2])
    } else if (s[0] === 'pat_group' && s.length >= 2) {
      f.add('fam:' + s[1]); if (s.length === 3) f.add(`eng:${s[1]}/${s[2]}`)
    } else if (s[0] === 'pat_story' && s.length >= 2) {
      f.add('cue:' + s[1]); if (s.length === 3) f.add('micro:' + s[2])
    }
  }
  return f
}

export interface MapIndex {
  byId:  Map<string, LCProblem>
  feats: Map<string, Set<string>>   // problem id → feature keys (tagged problems only)
  inv:   Map<string, string[]>      // feature key → problem ids
  idf:   Map<string, number>
}

export function buildMapIndex(problems: LCProblem[]): MapIndex {
  const byId = new Map<string, LCProblem>(), feats = new Map<string, Set<string>>(), inv = new Map<string, string[]>()
  for (const p of problems) {
    byId.set(p.frontendId, p)
    const f = featuresOf(p)
    if (!f.size) continue
    feats.set(p.frontendId, f)
    for (const k of f) { const l = inv.get(k); if (l) l.push(p.frontendId); else inv.set(k, [p.frontendId]) }
  }
  const n = Math.max(feats.size, 1), idf = new Map<string, number>()
  for (const [k, ids] of inv) idf.set(k, Math.log(1 + n / ids.length))
  return { byId, feats, inv, idf }
}

const weight = (ix: MapIndex, k: string, on: AspectOn) => {
  const kd = KIND[k.slice(0, k.indexOf(':'))]
  return kd && on[kd.aspect] ? kd.base * (ix.idf.get(k) ?? 1) : 0
}
function norm(ix: MapIndex, id: string, on: AspectOn): number {
  let s = 0
  for (const k of ix.feats.get(id) ?? []) { const w = weight(ix, k, on); s += w * w }
  return Math.sqrt(s)
}

export interface Link { id: string; sim: number; shared: string[] }

// Score between two specific problems (0..1) and what they share.
export function similarity(ix: MapIndex, a: string, b: string, on: AspectOn): Link {
  const fa = ix.feats.get(a), fb = ix.feats.get(b)
  if (!fa || !fb || a === b) return { id: b, sim: 0, shared: [] }
  let dot = 0; const shared: string[] = []
  for (const k of fa) if (fb.has(k)) { const w = weight(ix, k, on); if (w > 0) { dot += w * w; shared.push(k) } }
  const d = norm(ix, a, on) * norm(ix, b, on)
  return { id: b, sim: d ? dot / d : 0, shared }
}

// Level-1 connections: the k best matches for `id`, best first.
export function neighbors(ix: MapIndex, id: string, on: AspectOn, k = 10, keep?: (pid: string) => boolean): Link[] {
  const fa = ix.feats.get(id)
  if (!fa) return []
  const acc = new Map<string, number>(), sharedBy = new Map<string, string[]>()
  for (const key of fa) {
    const w = weight(ix, key, on)
    if (!w) continue
    for (const b of ix.inv.get(key) ?? []) {
      if (b === id || (keep && !keep(b))) continue
      acc.set(b, (acc.get(b) ?? 0) + w * w)
      const s = sharedBy.get(b); if (s) s.push(key); else sharedBy.set(b, [key])
    }
  }
  const na = norm(ix, id, on)
  const out: Link[] = []
  for (const [b, dot] of acc) {
    const d = na * norm(ix, b, on)
    if (d) out.push({ id: b, sim: dot / d, shared: sharedBy.get(b)! })
  }
  out.sort((x, y) => y.sim - x.sim || (parseInt(x.id, 10) || 0) - (parseInt(y.id, 10) || 0))
  return out.slice(0, k)
}

// The aspect that contributes most to a link (colours its line).
export function dominantAspect(ix: MapIndex, shared: string[], on: AspectOn): Aspect {
  const by: Record<Aspect, number> = { ds: 0, tech: 0, family: 0, story: 0 }
  for (const k of shared) { const w = weight(ix, k, on); by[aspectOfKey(k)] += w * w }
  return (Object.keys(by) as Aspect[]).reduce((a, b) => by[b] > by[a] ? b : a, 'tech')
}

// ── Routes ─────────────────────────────────────────────────────────────────
// Cheapest chain of strong matches from `from` to `to`. A hop costs
// (1 − match), plus a toll for stepping on a problem you aren't comfortable
// with when preferFamiliar is on, so routes run through familiar ground.
const TOLL: Record<string, number> = { fluent: 0, comfortable: 0, tried: 0.15, new: 0.3 }
export function route(
  ix: MapIndex, from: string, to: string, on: AspectOn,
  comfort: Map<string, ComfortEntry>, preferFamiliar: boolean,
): string[] | null {
  if (!ix.feats.has(from) || !ix.feats.has(to)) return null
  if (from === to) return [from]
  const toll = (id: string) => !preferFamiliar || id === to ? 0 : (TOLL[comfort.get(id)?.level ?? ''] ?? 0.4)
  const dist = new Map<string, number>([[from, 0]]), prev = new Map<string, string>()
  const done = new Set<string>()
  const open: string[] = [from]
  for (let guard = 0; open.length && guard < 1500; guard++) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (dist.get(open[i])! < dist.get(open[bi])!) bi = i
    const u = open.splice(bi, 1)[0]
    if (u === to) break
    if (done.has(u)) continue
    done.add(u)
    const edges = neighbors(ix, u, on, 12)
    const direct = similarity(ix, u, to, on)          // always consider stepping straight to the goal
    if (direct.sim > 0 && !edges.some(e => e.id === to)) edges.push(direct)
    for (const e of edges) {
      if (e.sim <= 0.05 || done.has(e.id)) continue
      const nd = dist.get(u)! + (1 - e.sim) + toll(e.id)
      if (nd < (dist.get(e.id) ?? Infinity)) { dist.set(e.id, nd); prev.set(e.id, u); if (!open.includes(e.id)) open.push(e.id) }
    }
  }
  if (!prev.has(to)) return null
  const path = [to]
  while (path[0] !== from) path.unshift(prev.get(path[0])!)
  return path
}

// ── Map layers (zoom hierarchy) ────────────────────────────────────────────
export type Lens = 'ds' | 'tech' | 'family' | 'story'
export interface MapNode {
  key:       string            // unique path key
  name:      string
  level:     'world' | 'area' | 'sub' | 'micro' | 'problem'
  pid?:      string            // problems only
  children?: MapNode[]
}

export function buildLens(ix: MapIndex, lens: Lens, names: Names | null, keep: (pid: string) => boolean): MapNode {
  // area → sub → micro → Set<pid>; sub/micro may be '' to skip that level.
  const tree = new Map<string, Map<string, Map<string, Set<string>>>>()
  const put = (a: string, s: string, m: string, pid: string) => {
    let A = tree.get(a); if (!A) tree.set(a, A = new Map())
    let S = A.get(s); if (!S) A.set(s, S = new Map())
    let M = S.get(m); if (!M) S.set(m, M = new Set())
    M.add(pid)
  }
  for (const [pid, p] of ix.byId) {
    if (!ix.feats.has(pid) || !keep(pid)) continue
    const engines = new Set<string>()
    for (const t of p.tags) { const s = t.split('::'); if (s[0] === 'pat_group' && s.length === 3) engines.add(s[1]) }
    for (const t of p.tags) {
      const s = t.split('::')
      if (lens === 'ds' && s[0] === 'pat_ds' && s.length === 4) put('ds:' + s[1], s[2] === 'core' ? 'core' : 'topic:' + s[2], 'micro:' + s[3], pid)
      if (lens === 'tech' && s[0] === 'pat_topic' && s.length === 3) put('topic:' + s[1], '', 'micro:' + s[2], pid)
      if (lens === 'tech' && s[0] === 'pat_ds' && s.length === 4) put(s[2] === 'core' ? 'ds:' + s[1] : 'topic:' + s[2], '', 'micro:' + s[3], pid)
      if (lens === 'family' && s[0] === 'pat_group' && s.length === 3) put('fam:' + s[1], '', `eng:${s[1]}/${s[2]}`, pid)
      if (lens === 'family' && s[0] === 'pat_group' && s.length === 2 && !engines.has(s[1])) put('fam:' + s[1], '', 'general', pid)
      if (lens === 'story' && s[0] === 'pat_story') put('cue:' + s[1], '', s.length === 3 ? 'micro:' + s[2] : 'general', pid)
    }
  }
  const label = (k: string, areaKey?: string) =>
    k === 'core' ? `${featureLabel(areaKey!, names)} essentials`
    : k === 'general' ? 'General'
    : featureLabel(k, names)
  const leaves = (base: string, ids: Set<string>): MapNode[] =>
    [...ids].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0))
      .map(pid => ({ key: `${base}/${pid}`, name: ix.byId.get(pid)!.title, level: 'problem' as const, pid }))
  const areas: MapNode[] = []
  for (const [a, subs] of tree) {
    const aKey = `w/${a}`
    const subNodes: MapNode[] = []
    for (const [s, micros] of subs) {
      const microNodes: MapNode[] = [...micros].map(([m, ids]) => ({
        key: `${aKey}/${s || '_'}/${m}`, name: label(m), level: 'micro' as const,
        children: leaves(`${aKey}/${s || '_'}/${m}`, ids),
      }))
      if (s) subNodes.push({ key: `${aKey}/${s}`, name: label(s, a), level: 'sub', children: microNodes })
      else subNodes.push(...microNodes)
    }
    areas.push({ key: aKey, name: label(a), level: 'area', children: subNodes })
  }
  return { key: 'w', name: ASPECTS.find(x => x.id === lens)!.label + ' map', level: 'world', children: areas }
}
