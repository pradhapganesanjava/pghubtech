// Lineage graph generation — a TypeScript port of _ADS/lineage/import_lc.js.
// Turns the LCProblems rows (LeetCode `topics` + custom `::` `tags`) into the
// entity/relation graph that the bundled knowledge_graph.html consumes:
//   • TOPIC entities      — taxonomy nodes from `::` paths
//   • ALGORITHM entities  — one per problem
//   • SUBSET_OF relations — topic child → parent (the `::` hierarchy)
//   • ASSOCIATES relations— problem → topic leaf (primary + additional)
// Both taxonomies feed in: LeetCode topics (mapped via TOPIC_MAP) AND the
// user's custom `::` tags (used as the primary path when present).

import type { LCProblem } from '../adapters/adsRepo'

export interface Entity {
  id: string; name: string; description: string; concept_type: 'TOPIC' | 'ALGORITHM'
  tags: string; tag_path: string; difficulty: string; source: string; created_at: string
}
export interface Relation {
  id: string; from_id: string; to_id: string
  rel_type: 'SUBSET_OF' | 'ASSOCIATES'; label: string; multiplicity: string; created_at: string
}
export interface LineageGraph { entities: Entity[]; relations: Relation[] }

// LeetCode topic → `::` path. Copied verbatim from import_lc.js so the
// generated taxonomy matches the _ADS knowledge graph exactly.
const TOPIC_MAP: Record<string, string> = {
  'Array':                      'data_structure::array',
  'Matrix':                     'data_structure::array::matrix',
  'Prefix Sum':                 'data_structure::array::prefix_sum',
  'Hash Table':                 'data_structure::array::hash_table',
  'Binary Indexed Tree':        'data_structure::array::binary_indexed_tree',
  'Ordered Set':                'data_structure::array::ordered_set',
  'Linked List':                'data_structure::linked_list',
  'Doubly-Linked List':         'data_structure::linked_list::doubly_linked_list',
  'String':                     'data_structure::string',
  'String Matching':            'data_structure::string::string_matching',
  'Rolling Hash':               'data_structure::string::rolling_hash',
  'Suffix Array':               'data_structure::string::suffix_array',
  'Stack':                      'data_structure::stack',
  'Monotonic Stack':            'data_structure::stack::monotonic_stack',
  'Queue':                      'data_structure::queue',
  'Monotonic Queue':            'data_structure::queue::monotonic_queue',
  'Heap (Priority Queue)':      'data_structure::queue::heap_priority_queue',
  'Tree':                       'data_structure::tree',
  'Binary Tree':                'data_structure::tree::binary_tree',
  'Binary Search Tree':         'data_structure::tree::binary_search_tree',
  'Trie':                       'data_structure::tree::trie',
  'Segment Tree':               'data_structure::tree::segment_tree',
  'Graph Theory':               'data_structure::graph',
  'Topological Sort':           'data_structure::graph::topological_sort',
  'Union-Find':                 'data_structure::graph::union_find',
  'Shortest Path':              'data_structure::graph::shortest_path',
  'Minimum Spanning Tree':      'data_structure::graph::minimum_spanning_tree',
  'Strongly Connected Component': 'data_structure::graph::strongly_connected_component',
  'Biconnected Component':      'data_structure::graph::biconnected_component',
  'Eulerian Circuit':           'data_structure::graph::eulerian_circuit',
  'Dynamic Programming':        'algorithm::dynamic_programming',
  'Memoization':                'algorithm::dynamic_programming::memoization',
  'Backtracking':               'algorithm::backtracking',
  'Binary Search':              'algorithm::binary_search',
  'Greedy':                     'algorithm::greedy',
  'Divide and Conquer':         'algorithm::divide_and_conquer',
  'Recursion':                  'algorithm::recursion',
  'Enumeration':                'algorithm::enumeration',
  'Counting':                   'algorithm::counting',
  'Simulation':                 'algorithm::simulation',
  'Depth-First Search':         'algorithm::graph_traversal::depth_first_search',
  'Breadth-First Search':       'algorithm::graph_traversal::breadth_first_search',
  'Two Pointers':               'algorithm::two_pointers',
  'Sliding Window':             'algorithm::two_pointers::sliding_window',
  'Bit Manipulation':           'algorithm::bit_manipulation',
  'Bitmask':                    'algorithm::bit_manipulation::bitmask',
  'Sorting':                    'algorithm::sorting',
  'Sort':                       'algorithm::sorting',
  'Merge Sort':                 'algorithm::sorting::merge_sort',
  'Bucket Sort':                'algorithm::sorting::bucket_sort',
  'Counting Sort':              'algorithm::sorting::counting_sort',
  'Radix Sort':                 'algorithm::sorting::radix_sort',
  'Quickselect':                'algorithm::sorting::quickselect',
  'Sweep Line':                 'algorithm::sweep_line',
  'Randomized':                 'algorithm::randomized',
  'Rejection Sampling':         'algorithm::randomized::rejection_sampling',
  'Reservoir Sampling':         'algorithm::randomized::reservoir_sampling',
  'Math':                       'math',
  'Number Theory':              'math::number_theory',
  'Combinatorics':              'math::combinatorics',
  'Geometry':                   'math::geometry',
  'Probability and Statistics': 'math::probability_and_statistics',
  'Game Theory':                'math::game_theory',
  'Hash Function':              'math::hash_function',
  'Design':                     'design',
  'Data Stream':                'design::data_stream',
  'Iterator':                   'design::iterator',
  'Concurrency':                'design::concurrency',
  'Shell':                      'other::shell',
  'Database':                   'other::database',
  'Brainteaser':                'other::brainteaser',
  'Interactive':                'other::interactive',
}

const ACRONYMS: Record<string, string> = { Bfs: 'BFS', Dfs: 'DFS', Dp: 'DP', Ds: 'DS', Bst: 'BST' }
function segmentToName(seg: string): string {
  const prefix = seg.startsWith('_') ? '_' : ''
  const body   = seg.replace(/^_+/, '')
  if (!body) return prefix
  const pretty = body.split('_')
    .map(w => { const c = w.charAt(0).toUpperCase() + w.slice(1); return ACRONYMS[c] || c })
    .join(' ')
  return prefix + pretty
}

export function buildLineage(problems: LCProblem[]): LineageGraph {
  const entities  = new Map<string, Entity>()
  const relations = new Map<string, Relation>()
  const ts = new Date().toISOString()

  // Create (idempotently) the TOPIC chain for a `::` path; returns the leaf id.
  function ensureChain(tagPath: string): string {
    const parts = tagPath.split('::')
    const chain: string[] = []
    parts.forEach((seg, i) => {
      const id = 'tp_' + parts.slice(0, i + 1).join('__')
      if (!entities.has(id)) {
        entities.set(id, {
          id, name: segmentToName(seg), concept_type: 'TOPIC', description: '',
          tags: 'taxonomy', tag_path: parts.slice(0, i + 1).join('::'),
          difficulty: '', source: '', created_at: ts,
        })
      }
      chain.push(id)
      if (i > 0) {
        const relId = `tr_${id}__${chain[i - 1]}`
        if (!relations.has(relId)) {
          relations.set(relId, {
            id: relId, from_id: id, to_id: chain[i - 1],
            rel_type: 'SUBSET_OF', label: 'has subsets', multiplicity: '0..*', created_at: ts,
          })
        }
      }
    })
    return chain[chain.length - 1]
  }

  // Pre-create every taxonomy chain so empty branches still appear.
  ;[...new Set(Object.values(TOPIC_MAP))].forEach(p => ensureChain(p))

  for (const p of problems) {
    const num = (p.frontendId || '').padStart(4, '0')
    if (!num.trim()) continue
    const id   = `algo_lc_${num}`
    const tags = p.topics.map(t => t.toLowerCase().replace(/[^a-z0-9]+/g, '_')).join(',')

    const lcPaths: string[] = []
    p.topics.forEach(t => { if (TOPIC_MAP[t]) lcPaths.push(TOPIC_MAP[t]) })
    const userPaths = p.tags.slice()                       // custom :: paths
    const mapped = [...new Set([...userPaths, ...lcPaths])] // user first → primary
    const primaryPath = mapped[0] || 'other'

    entities.set(id, {
      id, name: p.title, concept_type: 'ALGORITHM',
      description: `LC #${p.frontendId} · ${p.difficulty}`,
      tags, tag_path: primaryPath, difficulty: p.difficulty,
      source: p.frontendId, created_at: ts,
    })

    mapped.forEach((tp, i) => {
      const leafId = ensureChain(tp)
      const relId  = `ar_${id}_${leafId}`
      if (!relations.has(relId)) {
        relations.set(relId, {
          id: relId, from_id: id, to_id: leafId, rel_type: 'ASSOCIATES',
          label: i === 0 ? 'primary topic' : 'also tagged', multiplicity: '', created_at: ts,
        })
      }
    })
  }

  return { entities: [...entities.values()], relations: [...relations.values()] }
}
