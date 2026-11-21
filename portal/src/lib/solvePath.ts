// Solve Path — the suggestion logic behind the Solve Path page. Pure functions
// over the LCProblems rows (their pat_* tags) and the user's Comfort levels.
//
// The idea: a hard problem is a familiar one plus one new idea. A problem's
// "ideas" are the micro-patterns its pat_* tags land on (the last segment of
// pat_ds / pat_topic / pat_story tags with a micro leaf). Then:
//
//   • nextToTry  (forward)  — problems that share an idea with something you
//     are comfortable with and add EXACTLY ONE idea you don't have yet. One
//     card per new idea, so the list widens what you know instead of drilling
//     the same idea six times.
//   • prepareFor (backward) — for a problem you are struggling with, each idea
//     it needs: known (a comfortable problem already uses it), known only at
//     the base (a comfortable problem uses an idea from the same topic), or a
//     gap with the easiest problems that teach it. The path is the gaps,
//     easiest first, then the problem itself.
//
// "Same topic" (from pat_topic / pat_ds::<ds>::<topic> tags) stands in for a
// real builds-on link between micros until such links exist.

import type { LCProblem } from '../adapters/adsRepo'
import { isAnchorLevel, type ComfortEntry } from '../adapters/comfortRepo'

const DIFF_RANK: Record<string, number> = { Easy: 0, Medium: 1, Hard: 2 }
export const diffRank = (d: string) => DIFF_RANK[d] ?? 1

export interface ProblemIndex {
  byId:    Map<string, LCProblem>
  ideas:   Map<string, Set<string>>    // problem id → micro ids
  topicOf: Map<string, string>         // micro id → topic id
  byIdea:  Map<string, string[]>       // micro id → problem ids
}

// Micro ids a single tag lands on (none for family-level or 2-segment tags).
function ideaOf(tag: string): string | null {
  const s = tag.split('::')
  if (s[0] === 'pat_topic' && s.length === 3) return s[2]
  if (s[0] === 'pat_ds'    && s.length === 4) return s[3]
  if (s[0] === 'pat_story' && s.length === 3) return s[2]
  return null
}

export function buildIndex(problems: LCProblem[]): ProblemIndex {
  const byId = new Map<string, LCProblem>()
  const ideas = new Map<string, Set<string>>()
  const topicOf = new Map<string, string>()
  const byIdea = new Map<string, string[]>()
  for (const p of problems) {
    byId.set(p.frontendId, p)
    const set = new Set<string>()
    for (const t of p.tags) {
      const m = ideaOf(t)
      if (!m) continue
      set.add(m)
      const s = t.split('::')
      if (s[0] === 'pat_topic') topicOf.set(m, s[1])
      else if (s[0] === 'pat_ds' && s[2] !== 'core') topicOf.set(m, s[2])
      else if (s[0] === 'pat_ds' && !topicOf.has(m)) topicOf.set(m, s[1])   // DS-core micro: its DS is its home
    }
    if (!set.size) continue
    ideas.set(p.frontendId, set)
    for (const m of set) {
      const list = byIdea.get(m)
      if (list) list.push(p.frontendId); else byIdea.set(m, [p.frontendId])
    }
  }
  return { byId, ideas, topicOf, byIdea }
}

const numId = (id: string) => parseInt(id, 10) || 0

// Easier, purer examples first: difficulty, then fewest ideas, then lowest #.
function teachingOrder(ix: ProblemIndex) {
  return (a: string, b: string) => {
    const pa = ix.byId.get(a)!, pb = ix.byId.get(b)!
    return diffRank(pa.difficulty) - diffRank(pb.difficulty)
      || (ix.ideas.get(a)?.size ?? 0) - (ix.ideas.get(b)?.size ?? 0)
      || numId(a) - numId(b)
  }
}

function anchorsOf(comfort: Map<string, ComfortEntry>, ix: ProblemIndex): string[] {
  return [...comfort.values()]
    .filter(e => isAnchorLevel(e.level) && ix.byId.has(e.id))
    .map(e => e.id)
}

export interface NextCard {
  newIdea:      string
  sameTopic:    boolean       // the new idea sits in a topic you already know
  problem:      LCProblem
  anchor:       LCProblem     // the comfortable problem it builds on
  alternatives: LCProblem[]   // other problems teaching the same step
}

export function nextToTry(ix: ProblemIndex, comfort: Map<string, ComfortEntry>, limit = 12): NextCard[] {
  const anchors = anchorsOf(comfort, ix)
  if (!anchors.length) return []
  const known = new Set<string>()
  anchors.forEach(a => ix.ideas.get(a)?.forEach(m => known.add(m)))
  const knownTopics = new Set([...known].map(m => ix.topicOf.get(m)).filter(Boolean) as string[])

  // new idea → candidate problem ids (each adds exactly that one idea)
  const groups = new Map<string, string[]>()
  for (const [id, ms] of ix.ideas) {
    const e = comfort.get(id)
    if (e && isAnchorLevel(e.level)) continue
    let shared = 0
    const fresh: string[] = []
    for (const m of ms) (known.has(m) ? shared++ : fresh.push(m))
    if (!shared || fresh.length !== 1) continue
    const g = groups.get(fresh[0])
    if (g) g.push(id); else groups.set(fresh[0], [id])
  }

  const order = teachingOrder(ix)
  const cards: NextCard[] = []
  for (const [idea, ids] of groups) {
    ids.sort(order)
    const best = ids[0]
    const ms = ix.ideas.get(best)!
    const topic = ix.topicOf.get(idea)
    // Prefer an anchor that shares an idea from the new idea's own topic:
    // that is the bridge the step actually crosses.
    const sharing = anchors.filter(a => [...ms].some(m => ix.ideas.get(a)?.has(m)))
    const anchor = sharing.find(a => [...(ix.ideas.get(a) ?? [])].some(m => ix.topicOf.get(m) === topic)) ?? sharing[0]
    cards.push({
      newIdea: idea,
      sameTopic: !!topic && knownTopics.has(topic),
      problem: ix.byId.get(best)!,
      anchor: ix.byId.get(anchor)!,
      alternatives: ids.slice(1, 3).map(i => ix.byId.get(i)!),
    })
  }
  // Closest steps first (same topic), then easiest, then the ideas with the
  // most problems behind them (more practice available).
  cards.sort((a, b) =>
    Number(b.sameTopic) - Number(a.sameTopic)
    || diffRank(a.problem.difficulty) - diffRank(b.problem.difficulty)
    || (groups.get(b.newIdea)!.length - groups.get(a.newIdea)!.length)
    || a.newIdea.localeCompare(b.newIdea))
  return cards.slice(0, limit)
}

export interface IdeaStep {
  idea:     string
  topic:    string | null
  knownVia: LCProblem[]     // comfortable problems that already use this idea
  baseVia:  LCProblem[]     // comfortable problems in the same topic (when not known)
  tryFirst: LCProblem[]     // easiest problems that teach it (when not known)
}
export interface PrepPlan {
  target:  LCProblem
  steps:   IdeaStep[]       // gaps first, then known
  path:    LCProblem[]      // one problem per gap, easiest first, then the target
}

export function prepareFor(ix: ProblemIndex, comfort: Map<string, ComfortEntry>, targetId: string): PrepPlan | null {
  const target = ix.byId.get(targetId)
  if (!target) return null
  const ms = ix.ideas.get(targetId) ?? new Set<string>()
  const anchors = anchorsOf(comfort, ix).filter(a => a !== targetId)
  const order = teachingOrder(ix)
  const steps: IdeaStep[] = [...ms].map(idea => {
    const topic = ix.topicOf.get(idea) ?? null
    const knownVia = anchors.filter(a => ix.ideas.get(a)?.has(idea))
    const baseVia = knownVia.length || !topic ? [] :
      anchors.filter(a => [...(ix.ideas.get(a) ?? [])].some(m => ix.topicOf.get(m) === topic))
    // Warm-ups must be easier than the target: strictly easier when any
    // exist, otherwise same difficulty. Never harder (#42 → #407 is no prep).
    const pool = knownVia.length ? [] :
      (ix.byIdea.get(idea) ?? [])
        .filter(id => id !== targetId && !anchors.includes(id))
        .filter(id => diffRank(ix.byId.get(id)!.difficulty) <= diffRank(target.difficulty))
        .sort(order)
    const easier = pool.filter(id => diffRank(ix.byId.get(id)!.difficulty) < diffRank(target.difficulty))
    const tryFirst = (easier.length ? easier : pool).slice(0, 2)
    const p = (ids: string[]) => ids.slice(0, 3).map(i => ix.byId.get(i)!)
    return { idea, topic, knownVia: p(knownVia), baseVia: p(baseVia), tryFirst: tryFirst.map(i => ix.byId.get(i)!) }
  })
  steps.sort((a, b) => Number(a.knownVia.length > 0) - Number(b.knownVia.length > 0) || a.idea.localeCompare(b.idea))

  const seen = new Set<string>()
  const path = steps
    .filter(s => !s.knownVia.length && s.tryFirst.length)
    .map(s => s.tryFirst[0])
    .filter(p => !seen.has(p.frontendId) && seen.add(p.frontendId))
    .sort((a, b) => diffRank(a.difficulty) - diffRank(b.difficulty) || numId(a.frontendId) - numId(b.frontendId))
  return { target, steps, path: [...path, target] }
}
