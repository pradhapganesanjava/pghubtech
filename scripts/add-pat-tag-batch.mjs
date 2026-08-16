#!/usr/bin/env node
/**
 * scripts/add-pat-tag-batch.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Apply a hand-curated batch of (LC id → pat tags) to the LCProblems sheet.
 * Idempotent: only appends tags not already on the row. Use for incrementally
 * classifying problems Claude has hand-picked the DS / topic / micro for.
 *
 *   node scripts/add-pat-tag-batch.mjs            # dry-run
 *   node scripts/add-pat-tag-batch.mjs --write    # actually patches
 *
 * Edit the BATCH constant below to add more problems. After --write, follow
 * with build-patterns-csv to refresh the CSV and propagate to the UI.
 *
 * Tag format reminder:
 *   pat_ds::<ds>::core::<microId>            (DS-core micro)
 *   pat_ds::<ds>::<topicId>::<microId>       (Topic embedded under DS)
 *   pat_topic::<topicId>::<microId>          (short form — DS not yet inferred)
 */

import { google }              from 'googleapis'
import { readFile, writeFile } from 'fs/promises'
import { createServer }        from 'http'
import { exec }                from 'child_process'
import { dirname, join }       from 'path'
import { fileURLToPath }       from 'url'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, 'credentials.json')
const TOKEN_PATH = join(__dir, '.token.json')
const DO_WRITE   = process.argv.includes('--write')
// --only 3,340  → restrict the batch to these LC ids. IMPORTANT: several older
// BATCH entries below are STALE — migrate-topics-to-groups.mjs has since moved
// shortest-path/longest-path/interactive/design/simulation out of pat_topic::
// and pat_ds::<ds>::<topic>:: into the pat_group:: axis. Re-running the whole
// batch unscoped would re-add those dropped tags and silently revert that
// migration on ~35 rows. Always dry-run first, and prefer --only for new work.
const ONLY = (() => {
  const i = process.argv.indexOf('--only')
  return i > -1 ? new Set(process.argv[i + 1].split(',').map(s => s.trim())) : null
})()
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
const TAB    = 'LCProblems'
const COL_ID   = 1   // B
const COL_TAGS = 7   // H

// ─── Batch — edit this to queue new classifications ──────────────────────
// Each entry: LC frontend_id → array of pat tags (most-specific form
// preferred; the short pat_topic::T::M form is also accepted).
//
// First batch (Phase 3 starter): high-traffic Top-100-Liked problems that
// weren't previously anchored. Each tag uses the 4-segment form so the
// derived maps in patterns.html pick them up directly.
const BATCH = {
  // ── Batch 1 (already applied, kept idempotent) ───────────────────────
  17:  ['pat_ds::string::backtrack::permutation'],                  // Letter Combinations Phone
  22:  ['pat_ds::string::backtrack::partition-on-string'],          // Generate Parentheses
  55:  ['pat_ds::array::greedy::running-extreme'],                   // Jump Game
  101: ['pat_ds::tree::dfs::dfs-template'],                          // Symmetric Tree
  114: ['pat_ds::tree::dfs::dfs-tree-orders'],                       // Flatten BT to LL
  128: ['pat_ds::array::hash::seen-set'],                            // Longest Consecutive
  138: ['pat_ds::linked-list::hash::seen-set'],                      // Copy List Random Ptr
  148: ['pat_ds::linked-list::sorting::merge-sort-counting',
        'pat_topic::divide-conquer::dc-k-way-merge', 'pat_ds::linked-list::divide-conquer::dc-k-way-merge'],        // Sort List
  238: ['pat_ds::array::prefix-sum::ps-1d'],                         // Product Except Self
  581: ['pat_ds::array::stack-topic::monotonic-stack'],              // Shortest Unsorted Subarr
  617: ['pat_ds::tree::dfs::dfs-template'],                          // Merge Two BTs
  763: ['pat_ds::string::greedy::sort-and-sweep'],                   // Partition Labels
  994: ['pat_ds::matrices::bfs::bfs-multi-source',
        'pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'], // Rotting Oranges (BFS shortest path)
  200: ['pat_ds::matrices::dfs::dfs-grid-flood'],                    // Number of Islands +grid
  1143:['pat_ds::string::dp::dp-2-strings'],                          // LCS
  309: ['pat_ds::array::dp::state-machine-dp'],                      // Stock Cooldown
  416: ['pat_ds::array::dp::knapsack-01'],                            // Partition Equal Subset
  287: ['pat_ds::array::two-pointers::tp-fast-slow'],                // Find Duplicate
  // 11 was keyed twice in this literal (here and in batch 4); the later key
  // silently won, so this tp-converging entry never applied. Consolidated onto
  // the batch-4 entry — tp-area-greedy is the more specific micro anyway.

  // ── Batch 2 (this turn — Top 100 Liked, ~50 new anchors) ─────────────
  // Linked-list family
  24:  ['pat_ds::linked-list::core::iterative-reverse'],             // Swap Nodes in Pairs
  61:  ['pat_ds::linked-list::two-pointers::tp-fast-slow'],          // Rotate List
  86:  ['pat_ds::linked-list::two-pointers::tp-fast-slow'],          // Partition List
  143: ['pat_ds::linked-list::core::slow-fast-middle'],              // Reorder List
  203: ['pat_ds::linked-list::core::dummy-head-merge'],              // Remove LL Elements
  328: ['pat_ds::linked-list::two-pointers::tp-fast-slow'],          // Odd Even LL

  // Binary tree DFS / BFS
  100: ['pat_ds::tree::dfs::dfs-template'],                          // Same Tree
  111: ['pat_ds::tree::bfs::bfs-level-order'],                       // Min Depth of BT
  116: ['pat_ds::tree::bfs::bfs-level-order'],                       // Populating Next Right Ptr
  117: ['pat_ds::tree::bfs::bfs-level-order'],                       // Populating Next Right Ptr II
  144: ['pat_ds::tree::dfs::dfs-tree-orders'],                       // BT Preorder
  145: ['pat_ds::tree::dfs::dfs-tree-orders'],                       // BT Postorder
  226: ['pat_ds::tree::dfs::dfs-template'],                          // Invert BT
  404: ['pat_ds::tree::dfs::dfs-template'],                          // Sum of Left Leaves
  662: ['pat_ds::tree::bfs::bfs-level-order'],                       // Max Width of BT
  958: ['pat_ds::tree::bfs::bfs-level-order'],                       // Check Completeness BT
  988: ['pat_ds::tree::dfs::dfs-tree-orders'],                       // Smallest String From Leaf
  1110:['pat_ds::tree::dfs::dfs-template'],                          // Delete Nodes Return Forest

  // BST
  99:  ['pat_ds::bst::core::inorder-bst'],                            // Recover BST
  669: ['pat_ds::bst::core::bst-insert-delete'],                      // Trim BST

  // Array search / partition
  4:   ['pat_ds::array::binary-search::bs-on-answer'],                // Median 2 Sorted Arrays
  45:  ['pat_ds::array::greedy::running-extreme'],                   // Jump Game II
  134: ['pat_ds::array::greedy::running-extreme'],                   // Gas Station
  228: ['pat_ds::array::core::in-place-read-write'],                  // Summary Ranges
  229: ['pat_ds::array::hash::freq-counter'],                         // Majority Element II
  349: ['pat_ds::array::hash::seen-set'],                             // Intersection 2 Arrays
  456: ['pat_ds::array::stack-topic::monotonic-stack'],              // 132 Pattern
  540: ['pat_ds::array::binary-search::bs-textbook'],                 // Single Element Sorted Array
  658: ['pat_ds::array::two-pointers::tp-converging'],               // K Closest Elements
  719: ['pat_ds::array::binary-search::bs-on-answer',
        'pat_topic::binary-search::bs-on-answer-compound', 'pat_ds::array::binary-search::bs-on-answer-compound'], // K-th Smallest Pair Distance (count via two-pointer sim)
  852: ['pat_ds::array::binary-search::bs-rotated'],                  // Peak Index Mountain
  948: ['pat_ds::array::greedy::sort-and-sweep'],                    // Bag of Tokens
  977: ['pat_ds::array::two-pointers::tp-converging'],               // Squares of Sorted Array

  // Array DP
  77:  ['pat_ds::array::backtrack::subset-combination'],             // Combinations
  118: ['pat_ds::array::dp::dp-1d-linear'],                           // Pascal's Triangle
  119: ['pat_ds::array::dp::dp-1d-linear'],                           // Pascal's Triangle II
  120: ['pat_ds::array::dp::dp-1d-linear'],                           // Triangle (bottom-up)

  // Matrices
  36:  ['pat_ds::matrices::hash::seen-set'],                          // Valid Sudoku
  74:  ['pat_ds::matrices::binary-search::bs-textbook'],              // Search 2D Matrix
  240: ['pat_ds::matrices::binary-search::bs-textbook',
        'pat_topic::divide-conquer::dc-split-combine', 'pat_ds::matrices::divide-conquer::dc-split-combine'],              // Search 2D Matrix II

  // String — sliding window / two-pointers / parsing
  301: ['pat_ds::string::backtrack::partition-on-string'],           // Remove Invalid Parens
  344: ['pat_ds::string::two-pointers::tp-converging'],              // Reverse String
  345: ['pat_ds::string::two-pointers::tp-converging'],              // Reverse Vowels
  424: ['pat_ds::string::sliding-window::sw-shrink-violation'],     // Longest Repeating Char Replacement
  844: ['pat_ds::string::stack-topic::parens-rewrite'],              // Backspace String Compare
  890: ['pat_ds::string::hash::freq-counter'],                       // Find and Replace Pattern
  1004:['pat_ds::array::sliding-window::sw-shrink-violation'],     // Max Consecutive Ones III

  // String — sorting / heap
  767: ['pat_ds::string::heap::top-k'],                               // Reorganize String

  // Graph
  815: ['pat_ds::graph::bfs::bfs-shortest-unweighted',
        'pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'], // Bus Routes (BFS shortest path)
  841: ['pat_ds::graph::dfs::dfs-template'],                          // Keys and Rooms
  947: ['pat_ds::graph::union-find::uf-with-size'],                   // Most Stones Removed
  721: ['pat_ds::graph::union-find::uf-with-size'],                   // Accounts Merge (UF on emails)

  // Greedy on arrays / intervals
  1024:['pat_ds::array::greedy::sort-and-sweep'],                    // Video Stitching

  // ── Batch 3 (this turn) ──────────────────────────────────────────────
  // First, the 5 problems that motivated NEW sub-micros in the schema.
  // ─────────────────────────────────────────────────────────────────────
  2:   ['pat_ds::linked-list::core::list-digit-arithmetic'],        // Add Two Numbers
  445: ['pat_ds::linked-list::core::list-digit-arithmetic'],        // Add Two Numbers II
  369: ['pat_ds::linked-list::core::list-digit-arithmetic'],        // Plus One Linked List
  28:  ['pat_ds::string::core::string-match-kmp'],                  // Implement strStr
  459: ['pat_ds::string::core::string-match-kmp'],                  // Repeated Substring Pattern
  214: ['pat_ds::string::core::string-match-kmp'],                  // Shortest Palindrome
  686: ['pat_ds::string::core::string-match-kmp'],                  // Repeated String Match
  1392:['pat_ds::string::core::string-match-kmp'],                  // Longest Happy Prefix
  1408:['pat_ds::string::core::string-match-kmp'],                  // String Matching in Array
  146: ['pat_ds::linked-list::core::dll-cache-design'],             // LRU Cache
  460: ['pat_ds::linked-list::core::dll-cache-design'],             // LFU Cache
  432: ['pat_ds::linked-list::core::dll-cache-design'],             // All O`one
  1756:['pat_ds::linked-list::core::dll-cache-design'],             // Design Most Recently Used Queue
  332: ['pat_ds::graph::core::euler-tour'],                          // Reconstruct Itinerary
  753: ['pat_ds::graph::core::euler-tour'],                          // Cracking the Safe
  2097:['pat_ds::graph::core::euler-tour'],                          // Valid Arrangement of Pairs
  4:   ['pat_ds::array::binary-search::bs-partition-2sorted'],      // Median 2 Sorted Arrays

  // ── Batch 3 continued — more Top 100 Liked anchors (existing micros) ─
  // Strings
  71:  ['pat_ds::string::stack-topic::parens-rewrite'],             // Simplify Path
  187: ['pat_ds::string::hash::seen-set'],                          // Repeated DNA Sequences
  241: ['pat_ds::string::backtrack::partition-on-string'],          // Different Ways to Add Parens
  282: ['pat_ds::string::backtrack::partition-on-string'],          // Expression Add Operators
  299: ['pat_ds::string::hash::freq-counter'],                      // Bulls and Cows
  336: ['pat_ds::string::trie-topic::trie-grid-dfs'],               // Palindrome Pairs (trie of reversed)
  392: ['pat_ds::string::two-pointers::tp-merge-walk'],             // Is Subsequence
  // 395 is dual-engine: the map-backed window AND the split-on-rare-char
  // recursion both solve it, so it sits in both subarray sub-groups.
  395: ['pat_ds::string::sliding-window::sw-at-most-k',
        'pat_group::subarray', 'pat_group::subarray::map',
        'pat_group::subarray::divide-conquer',
        'pat_ds::string::hash::freq-counter', 'pat_topic::hash::freq-counter',
        'pat_topic::divide-conquer::dc-split-combine', 'pat_ds::string::divide-conquer::dc-split-combine'], // Longest Substring K Repeating
  409: ['pat_ds::string::hash::freq-counter'],                      // Longest Palindrome
  415: ['pat_ds::string::two-pointers::tp-converging'],             // Add Strings (both-end carry walk)
  67:  ['pat_ds::string::two-pointers::tp-converging'],             // Add Binary

  // Arrays — search / sort / dp / greedy
  220: ['pat_ds::array::sliding-window::sw-fixed'],                 // Contains Duplicate III
  264: ['pat_ds::array::dp::dp-1d-linear'],                          // Ugly Number II (3-pointer DP)
  274: ['pat_ds::array::sorting::bucket-sort-freq'],                 // H-Index
  275: ['pat_ds::array::binary-search::bs-textbook'],                // H-Index II
  324: ['pat_ds::array::sorting::sort-then-twoptr',
        'pat_topic::divide-conquer::dc-quickselect', 'pat_ds::array::divide-conquer::dc-quickselect'],                 // Wiggle Sort II
  334: ['pat_ds::array::greedy::running-extreme'],                  // Increasing Triplet
  350: ['pat_ds::array::hash::freq-counter'],                       // Intersection 2 Arrays II
  354: ['pat_ds::array::dp::dp-1d-linear'],                          // Russian Doll Envelopes
  374: ['pat_ds::array::binary-search::bs-textbook'],                // Guess Number Higher Lower
  413: ['pat_ds::array::dp::dp-1d-linear'],                          // Arithmetic Slices
  436: ['pat_ds::array::binary-search::bs-textbook'],                // Find Right Interval

  // Trees
  222: ['pat_ds::tree::core::post-order-depth'],                    // Count Complete Tree Nodes

  // Graphs
  310: ['pat_ds::graph::core::topo-sort'],                          // Minimum Height Trees

  // Matrices
  174: ['pat_ds::matrices::dp::dp-2d-grid'],                         // Dungeon Game

  // Math/DP
  343: ['pat_ds::array::dp::dp-1d-linear'],                          // Integer Break
  403: ['pat_ds::array::dp::dp-1d-linear'],                          // Frog Jump

  // ── Batch 4 (this turn) ──────────────────────────────────────────────
  // Splits of existing coarse micros into more specific sub-micros.
  // Each LC id below gets the NEW more-specific tag added; the old
  // coarse tag stays for now (problem appears under both micros until a
  // future cleanup script removes the redundant coarse tag).
  // ─────────────────────────────────────────────────────────────────────
  // dp-lis (NEW sub-micro — LIS family, O(n²) inner)
  300: ['pat_ds::array::dp::dp-lis'],                                // LIS
  354: ['pat_ds::array::dp::dp-lis'],                                // Russian Doll Envelopes
  673: ['pat_ds::array::dp::dp-lis'],                                // Number of LIS
  1048:['pat_ds::array::dp::dp-lis'],                                // Longest String Chain
  491: ['pat_ds::array::dp::dp-lis'],                                // Increasing Subsequences
  1671:['pat_ds::array::dp::dp-lis'],                                // Min Removals to Make Mountain
  376: ['pat_ds::array::dp::dp-lis'],                                // Wiggle Subsequence

  // dp-row-build (NEW sub-micro — Pascal-style row build)
  118: ['pat_ds::array::dp::dp-row-build'],                          // Pascal's Triangle
  119: ['pat_ds::array::dp::dp-row-build'],                          // Pascal's Triangle II
  120: ['pat_ds::array::dp::dp-row-build'],                          // Triangle (bottom-up)

  // tp-k-sum (NEW sub-micro — sorted k-sum convergence)
  15:  ['pat_ds::array::two-pointers::tp-k-sum'],                    // 3Sum
  16:  ['pat_ds::array::two-pointers::tp-k-sum'],                    // 3Sum Closest
  18:  ['pat_ds::array::two-pointers::tp-k-sum'],                    // 4Sum
  167: ['pat_ds::array::two-pointers::tp-k-sum'],                    // Two Sum II Sorted
  259: ['pat_ds::array::two-pointers::tp-k-sum'],                    // 3Sum Smaller
  658: ['pat_ds::array::two-pointers::tp-k-sum'],                    // K Closest Elements (refine over earlier batch-2 tag)
  923: ['pat_ds::array::two-pointers::tp-k-sum'],                    // 3Sum With Multiplicity
  1099:['pat_ds::array::two-pointers::tp-k-sum'],                    // Two Sum Less Than K

  // tp-area-greedy (NEW sub-micro — max-area / trap, advance-shorter-side)
  11:  ['pat_ds::array::two-pointers::tp-area-greedy',
        'pat_group::subarray', 'pat_group::subarray::two-pointer'],  // Container With Most Water
  42:  ['pat_ds::array::two-pointers::tp-area-greedy'],              // Trapping Rain Water
  407: ['pat_ds::matrices::two-pointers::tp-area-greedy'],           // Trapping Rain Water II (3D)

  // greedy-end-sorted (NEW sub-micro — sort by END for max non-overlap)
  435: ['pat_ds::array::greedy::greedy-end-sorted',
        'pat_ds::array::interval::interval-sort-end-greedy', 'pat_topic::interval::interval-sort-end-greedy'], // Non-overlapping Intervals (greedy + interval)
  452: ['pat_ds::array::greedy::greedy-end-sorted'],                 // Min Arrows Burst Balloons
  646: ['pat_ds::array::greedy::greedy-end-sorted'],                 // Maximum Length of Pair Chain
  1235:['pat_ds::array::greedy::greedy-end-sorted'],                 // Maximum Profit in Job Scheduling

  // ── Batch 5 (this turn) ──────────────────────────────────────────────
  // 7 new sub-micro splits — each anchor entry below adds the more-
  // specific tag. The old coarse tag remains until the prune script
  // runs (dual presence intentional, see batch 4 commit).
  // ─────────────────────────────────────────────────────────────────────

  // dfs-parallel-trees (NEW) — Same Tree / Symmetric / Subtree / Merge
  100: ['pat_ds::tree::dfs::dfs-parallel-trees'],                    // Same Tree
  101: ['pat_ds::tree::dfs::dfs-parallel-trees'],                    // Symmetric Tree
  572: ['pat_ds::tree::dfs::dfs-parallel-trees'],                    // Subtree of Another Tree
  617: ['pat_ds::tree::dfs::dfs-parallel-trees'],                    // Merge Two Binary Trees
  951: ['pat_ds::tree::dfs::dfs-parallel-trees'],                    // Flip Equivalent Binary Trees

  // dfs-tree-mutate (NEW) — Invert / Trim / Detach / Delete-and-Return
  226: ['pat_ds::tree::dfs::dfs-tree-mutate'],                       // Invert Binary Tree
  1110:['pat_ds::tree::dfs::dfs-tree-mutate'],                       // Delete Nodes Return Forest
  814: ['pat_ds::tree::dfs::dfs-tree-mutate'],                       // Binary Tree Pruning
  669: ['pat_ds::bst::dfs::dfs-tree-mutate'],                        // Trim a BST
  450: ['pat_ds::bst::dfs::dfs-tree-mutate'],                        // Delete Node in a BST

  // bfs-position-tracked (NEW) — width / completeness / column
  662: ['pat_ds::tree::bfs::bfs-position-tracked'],                  // Maximum Width of BT
  958: ['pat_ds::tree::bfs::bfs-position-tracked'],                  // Check Completeness of BT
  314: ['pat_ds::tree::bfs::bfs-position-tracked'],                  // Vertical Order Traversal
  987: ['pat_ds::tree::bfs::bfs-position-tracked'],                  // Vertical Order Traversal II
  919: ['pat_ds::tree::bfs::bfs-position-tracked'],                  // Complete BT Inserter

  // bfs-level-connect (NEW) — populating next right pointers
  116: ['pat_ds::tree::bfs::bfs-level-connect'],                     // Populating Next Right Pointers
  117: ['pat_ds::tree::bfs::bfs-level-connect'],                     // Populating Next Right Pointers II

  // hash-chain-build (NEW) — longest consecutive / arithmetic chain
  128: ['pat_ds::array::hash::hash-chain-build'],                    // Longest Consecutive Sequence
  298: ['pat_ds::tree::hash::hash-chain-build'],                     // Binary Tree Longest Consecutive Sequence
  1218:['pat_ds::array::hash::hash-chain-build'],                    // Longest Arithmetic Subseq w/ Diff

  // next-permutation-algo (NEW) — in-place pivot+reverse algorithm
  31:  ['pat_ds::array::backtrack::next-permutation-algo'],          // Next Permutation
  556: ['pat_ds::array::backtrack::next-permutation-algo'],          // Next Greater Element III
  670: ['pat_ds::array::backtrack::next-permutation-algo'],          // Maximum Swap (related shape)

  // combinatorial-product (NEW) — Cartesian product per-slot
  17:  ['pat_ds::string::backtrack::combinatorial-product'],         // Letter Combinations Phone
  22:  ['pat_ds::string::backtrack::combinatorial-product'],         // Generate Parentheses (constrained product)
  1087:['pat_ds::string::backtrack::combinatorial-product'],         // Brace Expansion
  2266:['pat_ds::string::backtrack::combinatorial-product'],         // Count Number of Texts

  // ── Batch 6 (this turn) ──────────────────────────────────────────────
  // 3 new sub-micro splits + their anchors. Run prune-coarse-pat-tags
  // AFTER applying these to drop the redundant coarse parents.
  // ─────────────────────────────────────────────────────────────────────

  // monotonic-stack-spans (NEW) — histogram-rectangle / span-at-pop
  84:  ['pat_ds::array::stack-topic::monotonic-stack-spans'],        // Largest Rectangle Histogram
  85:  ['pat_ds::matrices::stack-topic::monotonic-stack-spans'],     // Maximal Rectangle
  1856:['pat_ds::array::stack-topic::monotonic-stack-spans'],        // Maximum Subarray Min-Product
  907: ['pat_ds::array::stack-topic::monotonic-stack-spans'],        // Sum of Subarray Minimums
  2334:['pat_ds::array::stack-topic::monotonic-stack-spans'],        // Subarray With Elements Greater Than Varying Threshold
  2104:['pat_ds::array::stack-topic::monotonic-stack-spans'],        // Sum of Subarray Ranges

  // dp-2d-square (NEW) — min-of-3-neighbours + 1 for square submatrices
  221: ['pat_ds::matrices::dp::dp-2d-square'],                       // Maximal Square
  1277:['pat_ds::matrices::dp::dp-2d-square'],                       // Count Square Submatrices with All Ones
  1139:['pat_ds::matrices::dp::dp-2d-square'],                       // Largest 1-Bordered Square
  1727:['pat_ds::matrices::dp::dp-2d-square'],                       // Largest Submatrix With Rearrangements (related shape)

  // sw-distinct-count (NEW) — freq-map + distinct-counter family
  // NOTE: the map-backed-window family (3, 159, 340, 395, 904, 992, 1100,
  // 2062) carries THREE things, all merged into these existing entries because
  // duplicate object keys would silently overwrite each other in this literal:
  //   1. its sliding-window micro (the technique)
  //   2. pat_group::subarray + pat_group::subarray::map (the family)
  //   3. hash::freq-counter (the map is the TOOL — this is what makes them
  //      show up on the Map topic page and in the subarray×Map combo panel,
  //      the same way 560/974 carry hash::complement-lookup next to prefix-sum)
  3:   ['pat_ds::string::sliding-window::sw-distinct-count',
        'pat_group::subarray', 'pat_group::subarray::map',
        'pat_ds::string::hash::freq-counter', 'pat_topic::hash::freq-counter'], // Longest Substring Without Repeating
  159: ['pat_ds::string::sliding-window::sw-distinct-count',
        'pat_group::subarray', 'pat_group::subarray::map',
        'pat_ds::string::hash::freq-counter', 'pat_topic::hash::freq-counter'], // Longest Substring With At Most 2 Distinct
  340: ['pat_ds::string::sliding-window::sw-distinct-count',
        'pat_group::subarray', 'pat_group::subarray::map',
        'pat_ds::string::hash::freq-counter', 'pat_topic::hash::freq-counter'], // Longest Substring With At Most K Distinct
  904: ['pat_ds::array::sliding-window::sw-distinct-count',
        'pat_group::subarray', 'pat_group::subarray::map',
        'pat_ds::array::hash::freq-counter', 'pat_topic::hash::freq-counter'], // Fruit Into Baskets (≤ 2 distinct)
  // 1004 was tagged earlier as sw-shrink-violation; the K-distinct framing
  // also applies (max consecutive ones III is essentially "at most K zeros").
  // Skip retag — already in BATCH at line above; prune will handle dual.

  // ── Batch 7 (this turn) — Cross-list pick: Snowflake / HelloIntCode / Premium Algo ─
  // ~40 problems, all using existing micros. No schema additions.
  // ────────────────────────────────────────────────────────────────────

  // Strings
  727: ['pat_ds::string::dp::dp-2-strings'],                          // Min Window Subseq
  758: ['pat_ds::string::greedy::sort-and-sweep'],                   // Bold Words in String
  819: ['pat_ds::string::hash::freq-counter'],                       // Most Common Word
  1153:['pat_ds::string::hash::freq-counter'],                       // String Transforms Into Another
  1657:['pat_ds::string::hash::freq-counter'],                       // Determine if Two Strings Are Close
  161: ['pat_ds::string::two-pointers::tp-converging'],              // One Edit Distance
  266: ['pat_ds::string::hash::freq-counter'],                       // Palindrome Permutation
  408: ['pat_ds::string::two-pointers::tp-merge-walk'],              // Valid Word Abbreviation

  // Arrays — DP / greedy / sorting / hash / two-ptr / bs
  837: ['pat_ds::array::dp::dp-1d-linear'],                           // New 21 Game (sliding-sum DP)
  879: ['pat_ds::array::dp::knapsack-01'],                            // Profitable Schemes
  1356:['pat_ds::array::sorting::sort-then-twoptr'],                  // Sort Integers by Bit Count
  1366:['pat_ds::array::sorting::sort-then-twoptr'],                  // Rank Teams by Votes (custom comparator)
  1488:['pat_ds::array::hash::seen-set'],                             // Avoid Flood in The City
  1610:['pat_ds::array::sliding-window::sw-shrink-violation'],       // Max Number of Visible Points
  1648:['pat_ds::array::binary-search::bs-on-answer'],                // Sell Diminishing-Valued Colored Balls
  1452:['pat_ds::array::hash::seen-set'],                             // People Whose List Contains All Companies
  1481:['pat_ds::array::hash::freq-counter'],                         // Least Unique Ints After K Removals
  243: ['pat_ds::array::two-pointers::tp-converging'],               // Shortest Word Distance
  244: ['pat_ds::array::two-pointers::tp-merge-walk'],               // Shortest Word Distance II (design + merge)
  245: ['pat_ds::array::two-pointers::tp-merge-walk'],               // Shortest Word Distance III
  277: ['pat_ds::array::greedy::running-extreme'],                   // Find the Celebrity (elim pass)
  360: ['pat_ds::array::two-pointers::tp-converging'],               // Sort Transformed Array
  734: ['pat_ds::array::hash::freq-counter'],                        // Sentence Similarity

  // Trees
  1376:['pat_ds::tree::dfs::dfs-template'],                          // Time Needed to Inform All Employees
  1457:['pat_ds::tree::dfs::dfs-tree-orders'],                       // Pseudo-Palindromic Paths (DFS bitmask)
  1530:['pat_ds::tree::dfs::dfs-template'],                          // Number of Good Leaf Pairs

  // Graph
  489: ['pat_ds::graph::dfs::dfs-template'],                          // Robot Room Cleaner (DFS + backtrack motion)
  1192:['pat_ds::graph::dfs::dfs-template'],                          // Critical Connections (Tarjan)
  1197:['pat_ds::graph::bfs::bfs-shortest-unweighted'],               // Minimum Knight Moves
  444: ['pat_ds::graph::core::topo-sort'],                            // Sequence Reconstruction
  582: ['pat_ds::graph::dfs::dfs-template'],                          // Kill Process
  737: ['pat_ds::graph::union-find::uf-with-size'],                   // Sentence Similarity II (UF on word groups)

  // Matrices
  1219:['pat_ds::matrices::backtrack::word-search-dfs'],              // Path with Maximum Gold
  1284:['pat_ds::matrices::bfs::bfs-shortest-unweighted'],            // Min Flips Convert Binary Matrix
  1293:['pat_ds::matrices::bfs::bfs-shortest-unweighted'],            // Shortest Path with Obstacles Elimination
  1337:['pat_ds::matrices::heap::top-k'],                             // K Weakest Rows
  1351:['pat_ds::matrices::binary-search::bs-textbook'],              // Count Negatives in Sorted Matrix

  // Linked-list
  708: ['pat_ds::linked-list::core::dummy-head-merge'],               // Insert into Sorted Cyclic List

  // Trie (pure design — DS=trie)
  1166:['pat_ds::trie::core::trie-basic'],                            // Design File System
  588: ['pat_ds::trie::core::trie-basic'],                            // Design In-Memory File System

  // ── Batch 8 (this turn) — Snowflake remainder + HelloIntCode + Premium Algo ─
  // ~60 new high-confidence anchors using EXISTING micros across the schema.
  // ──────────────────────────────────────────────────────────────────────

  // ── Snowflake-typical algo problems ───────────────────────────────
  158: ['pat_ds::string::core::in-place-read-write'],                 // Read N Chars Given Read4 II (buffered)
  833: ['pat_ds::string::greedy::sort-and-sweep'],                    // Find And Replace in String
  843: ['pat_ds::string::backtrack::partition-on-string'],            // Guess the Word (interactive minimax)
  855: ['pat_ds::array::greedy::sort-and-sweep'],                     // Exam Room (sorted set greedy)
  362: ['pat_ds::array::core::in-place-read-write'],                  // Hit Counter (circular bucket)
  346: ['pat_ds::queue::core::moving-average-stream'],                // Moving Average (premium reanchor)
  1268:['pat_ds::string::trie-topic::trie-autocomplete'],             // Search Suggestions System (alt anchor)
  158: ['pat_ds::string::core::in-place-read-write'],                 // (dup-safe)
  346: ['pat_ds::queue::core::moving-average-stream'],                // (dup-safe)
  1188:['pat_ds::queue::core::queue-from-stacks'],                    // Design Bounded Blocking Queue
  1429:['pat_ds::linked-list::core::dll-cache-design'],               // First Unique Number (DLL + map)
  348: ['pat_ds::matrices::core::mat-set-zeros'],                     // Design Tic-Tac-Toe (row/col/diag counters)

  // ── HelloInterviewCode signature problems ─────────────────────────
  2018:['pat_ds::matrices::core::mat-grid-dfs-bfs'],                  // Check Word Can Be Placed in Crossword
  1396:['pat_ds::linked-list::core::dll-cache-design'],               // Design Underground System (hash + hash)
  2013:['pat_ds::linked-list::core::dll-cache-design'],               // Detect Squares (counter + geom)
  271: ['pat_ds::string::core::in-place-read-write'],                 // Encode and Decode Strings (length-prefix)
  379: ['pat_ds::queue::core::queue-from-stacks'],                    // Design Phone Directory (free-slot queue)
  1396:['pat_ds::linked-list::core::dll-cache-design'],               // (dup-safe)
  705: ['pat_ds::trie::core::trie-basic'],                            // Design HashSet (bucket / linked list)
  706: ['pat_ds::trie::core::trie-basic'],                            // Design HashMap (similar)
  1268:['pat_ds::string::trie-topic::trie-autocomplete'],             // (dup-safe)
  528: ['pat_ds::array::binary-search::bs-textbook'],                 // Random Pick with Weight (prefix + BS)
  528: ['pat_ds::array::math::sum-formulas'],                         // (also math/prefix shape)
  710: ['pat_ds::array::binary-search::bs-textbook'],                 // Random Pick Not in Blacklist

  // ── Premium Algo 100 — additional anchors not covered earlier ─────
  291: ['pat_ds::string::backtrack::partition-on-string'],            // Word Pattern II
  293: ['pat_ds::string::backtrack::partition-on-string'],            // Flip Game (gen states)
  294: ['pat_ds::string::backtrack::partition-on-string'],            // Flip Game II (game DP)
  311: ['pat_ds::matrices::core::mat-grid-dfs-bfs'],                  // Sparse Matrix Multiplication
  348: ['pat_ds::matrices::core::mat-set-zeros'],                     // (dup-safe — Tic-Tac-Toe)
  351: ['pat_ds::matrices::backtrack::word-search-dfs'],              // Android Unlock Patterns
  353: ['pat_ds::matrices::core::mat-grid-dfs-bfs'],                  // Design Snake Game
  356: ['pat_ds::matrices::hash::seen-set'],                          // Line Reflection
  359: ['pat_ds::array::hash::freq-counter'],                         // Logger Rate Limiter
  379: ['pat_ds::queue::core::queue-from-stacks'],                    // (dup-safe — Phone Directory)
  411: ['pat_ds::string::backtrack::partition-on-string'],            // Min Unique Word Abbrev
  418: ['pat_ds::array::greedy::running-extreme'],                    // Sentence Screen Fitting
  484: ['pat_ds::array::core::in-place-read-write'],                  // Find Permutation
  490: ['pat_ds::matrices::dfs::dfs-template'],                       // The Maze (BFS/DFS roll-to-wall)
  505: ['pat_ds::matrices::heap::dijkstra',
        'pat_topic::shortest-path::dijkstra', 'pat_ds::graph::shortest-path::dijkstra'], // The Maze II (Dijkstra on roll-distance)
  531: ['pat_ds::matrices::core::mat-grid-dfs-bfs'],                  // Lonely Pixel I
  624: ['pat_ds::array::core::in-place-read-write'],                  // Max Distance in Arrays (track 2 extremes)
  723: ['pat_ds::matrices::core::mat-set-zeros'],                     // Candy Crush
  727: ['pat_ds::string::dp::dp-2-strings'],                          // (dup-safe — Min Window Subseq)
  750: ['pat_ds::matrices::core::mat-grid-dfs-bfs'],                  // Number of Corner Rectangles
  759: ['pat_ds::array::greedy::sort-and-sweep',
        'pat_ds::array::interval::interval-sort-start-merge', 'pat_topic::interval::interval-sort-start-merge'], // Employee Free Time (greedy + interval)
  760: ['pat_ds::array::hash::freq-counter'],                         // Find Anagram Mappings
  766: ['pat_ds::matrices::core::mat-grid-dfs-bfs'],                  // Toeplitz Matrix
  772: ['pat_ds::string::stack-topic::expression-eval'],              // Basic Calc III
  784: ['pat_ds::string::backtrack::combinatorial-product'],          // Letter Case Permutation
  788: ['pat_ds::array::dp::dp-1d-linear'],                           // Rotated Digits
  792: ['pat_ds::string::two-pointers::tp-merge-walk'],               // Num Matching Subsequences
  796: ['pat_ds::string::core::string-match-kmp'],                    // Rotate String (concat + contains)
  809: ['pat_ds::string::two-pointers::tp-merge-walk'],               // Expressive Words
  825: ['pat_ds::array::sorting::bucket-sort-freq'],                  // Friends of Appropriate Ages
  833: ['pat_ds::string::greedy::sort-and-sweep'],                    // (dup-safe)
  836: ['pat_ds::matrices::core::mat-grid-dfs-bfs'],                  // Rectangle Overlap

  // ── Mixed picks from all three lists ──────────────────────────────
  828: ['pat_ds::string::core::in-place-read-write'],                 // Count Unique Chars Substrings (contribution sum)
  907: ['pat_ds::array::stack-topic::monotonic-stack-spans'],         // (dup-safe — Sum Subarray Mins)
  992: ['pat_ds::array::sliding-window::sw-at-most-k',
        'pat_group::subarray', 'pat_group::subarray::map',
        'pat_ds::array::hash::freq-counter', 'pat_topic::hash::freq-counter'], // (dup-safe — Subarrays K Distinct)
  1004:['pat_ds::array::sliding-window::sw-distinct-count'],          // (dup-safe — Max Consecutive Ones III)
  // 1004 / 930 / 1248 deliberately EXCLUDED from subarray::map: their windows
  // are tracked by a single scalar counter (zeros / ones / odds), not a
  // per-key map — the exact line the micro definition draws.

  // ── Batch 9 (this turn) — map-backed window, ids not already keyed above ──
  1100:['pat_ds::string::sliding-window::sw-distinct-count',
        'pat_group::subarray', 'pat_group::subarray::map',
        'pat_ds::string::hash::freq-counter', 'pat_topic::hash::freq-counter'], // K-Length Substrings No Repeats
  2062:['pat_ds::string::sliding-window::sw-distinct-count',
        'pat_group::subarray', 'pat_group::subarray::map',
        'pat_ds::string::hash::freq-counter', 'pat_topic::hash::freq-counter'], // Count Vowel Substrings

  // ── Batch 10 (this turn) — pat_group::subarray::divide-conquer ───────────
  // Scope rule: problems ALREADY in pat_group::subarray that also carry
  // LeetCode's own "Divide and Conquer" topic. 395 is tagged on its entry
  // above (dual-engine). Two shapes:
  //   (a) split-at-mid + combine across the boundary  — 53, 918
  //   (b) merge-sort / segment-tree counting of cross-boundary pairs
  //       over prefix sums                            — 2031, 3737, 3739, 3719, 3721
  53:  ['pat_group::subarray::divide-conquer',
        'pat_topic::divide-conquer::dc-split-combine', 'pat_ds::array::divide-conquer::dc-split-combine'],   // Maximum Subarray (canonical: max of left/right/crossing)
  918: ['pat_group::subarray::divide-conquer',
        'pat_topic::divide-conquer::dc-split-combine', 'pat_ds::array::divide-conquer::dc-split-combine'],   // Max Sum Circular Subarray (53's split, plus the wrap case)
  2031:['pat_group::subarray::divide-conquer',
        'pat_topic::divide-conquer::dc-merge-count', 'pat_ds::array::divide-conquer::dc-merge-count'],   // Count Subarrays With More Ones Than Zeros (merge-sort count)
  3737:['pat_group::subarray::divide-conquer',
        'pat_topic::divide-conquer::dc-merge-count', 'pat_ds::array::divide-conquer::dc-merge-count'],   // Count Subarrays With Majority Element I (merge-sort count)
  3739:['pat_group::subarray::divide-conquer',
        'pat_topic::divide-conquer::dc-merge-count', 'pat_ds::array::divide-conquer::dc-merge-count'],   // Count Subarrays With Majority Element II (merge-sort count)
  3719:['pat_group::subarray::divide-conquer',
        'pat_topic::divide-conquer::dc-split-combine', 'pat_ds::array::divide-conquer::dc-split-combine'],   // Longest Balanced Subarray I (solve halves + crossing)
  3721:['pat_group::subarray::divide-conquer',
        'pat_topic::divide-conquer::dc-split-combine', 'pat_ds::array::divide-conquer::dc-split-combine'],   // Longest Balanced Subarray II (same, harder combine)
  1167:['pat_ds::array::heap::top-k'],                                // Min Cost to Connect Sticks (min-heap repeated)
  1216:['pat_ds::string::dp::dp-2-strings'],                          // Valid Palindrome III (k-edit)
  1283:['pat_ds::array::binary-search::bs-on-answer'],                // Find Smallest Divisor Given Threshold
  1335:['pat_ds::array::dp::interval-dp'],                            // Min Difficulty Job Schedule
  1428:['pat_ds::matrices::binary-search::bs-textbook'],              // Leftmost Column With ≥ 1
  1463:['pat_ds::matrices::dp::dp-2d-grid'],                          // Cherry Pickup II (2-agent DP)
  1531:['pat_ds::string::dp::interval-dp'],                           // String Compression II
  1631:['pat_ds::matrices::heap::dijkstra',
        'pat_topic::shortest-path::dijkstra', 'pat_ds::graph::shortest-path::dijkstra'], // Path With Minimum Effort (Dijkstra)
  1696:['pat_ds::array::dp::dp-1d-linear'],                           // Jump Game VI (monotonic-deque DP)
  1937:['pat_ds::matrices::dp::dp-2d-grid'],                          // Max Points With Cost
  2007:['pat_ds::array::hash::freq-counter'],                         // Find Original Array From Doubled
  2008:['pat_ds::array::dp::dp-1d-linear'],                           // Max Earnings From Taxi (sort + DP)
  2076:['pat_ds::graph::union-find::uf-weighted'],                    // (dup-safe — Process Restricted Friend)
  2092:['pat_ds::graph::union-find::uf-reverse-time'],                // (dup-safe — Find All People Secret)
  2104:['pat_ds::array::stack-topic::monotonic-stack-spans'],         // (dup-safe — Sum Subarray Ranges)
  2127:['pat_ds::graph::core::dag-longest-path'],                     // Max Employees Invited (functional graph)
  2272:['pat_ds::array::dp::dp-1d-linear'],                           // Substring With Largest Variance (kadane variant)

  // ── Intervals topic (sort, then sweep) — both Topic + DS-nested forms.
  //    (759 + 435 carry the interval tags on their greedy entries above.) ──
  252: ['pat_ds::array::interval::interval-sort-start-overlap',
        'pat_topic::interval::interval-sort-start-overlap'],          // Can Attend Meetings (overlap detect)
  56:  ['pat_ds::array::interval::interval-sort-start-merge',
        'pat_topic::interval::interval-sort-start-merge'],            // Merge Intervals
  57:  ['pat_ds::array::interval::interval-sort-start-merge',
        'pat_topic::interval::interval-sort-start-merge'],            // Insert Interval

  // ── Shortest Path topic (algorithm by edge weights) — Topic + Graph-DS forms.
  //    (994/815 → bfs, 505/1631 → dijkstra carry these on their entries above.) ──
  // Dijkstra (non-negative weights)
  743: ['pat_topic::shortest-path::dijkstra', 'pat_ds::graph::shortest-path::dijkstra'],   // Network Delay Time
  778: ['pat_topic::shortest-path::dijkstra', 'pat_ds::graph::shortest-path::dijkstra'],   // Swim in Rising Water
  2812:['pat_topic::shortest-path::dijkstra', 'pat_ds::graph::shortest-path::dijkstra'],   // Find the Safest Path in a Grid
  2642:['pat_topic::shortest-path::dijkstra', 'pat_ds::graph::shortest-path::dijkstra'],   // Design Graph With Shortest Path Calc
  499: ['pat_topic::shortest-path::dijkstra', 'pat_ds::graph::shortest-path::dijkstra'],   // The Maze II / III (roll distance)
  // Bellman-Ford (negative weights / bounded hops). 787 is dual: Dijkstra-with-state.
  787: ['pat_topic::shortest-path::dijkstra', 'pat_ds::graph::shortest-path::dijkstra',
        'pat_topic::shortest-path::bellman-ford', 'pat_ds::graph::shortest-path::bellman-ford'], // Cheapest Flights Within K Stops
  // Floyd-Warshall (all pairs)
  1334:['pat_topic::shortest-path::floyd-warshall', 'pat_ds::graph::shortest-path::floyd-warshall'], // Find the City With Fewest Reachable
  // BFS (unweighted / unit edges + multi-source)
  127: ['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // Word Ladder
  752: ['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // Open the Lock
  1091:['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // Shortest Path in Binary Matrix
  433: ['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // Minimum Genetic Mutation
  1730:['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // Shortest Path to Get Food
  909: ['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // Snakes and Ladders
  542: ['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // 01 Matrix (multi-source)
  286: ['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // Walls and Gates
  317: ['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // Shortest Distance from All Buildings
  1162:['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // As Far from Land as Possible
  1765:['pat_topic::shortest-path::bfs', 'pat_ds::graph::shortest-path::bfs'],             // Map of Highest Peak
  // 0-1 BFS (0/1 weights)
  1368:['pat_topic::shortest-path::zero-one-bfs', 'pat_ds::graph::shortest-path::zero-one-bfs'], // Min Cost to Make at Least One Valid Path
  2290:['pat_topic::shortest-path::zero-one-bfs', 'pat_ds::graph::shortest-path::zero-one-bfs'], // Min Obstacle Removal to Reach Corner
  934: ['pat_topic::shortest-path::zero-one-bfs', 'pat_ds::graph::shortest-path::zero-one-bfs'], // Shortest Bridge

  // ── Prefix Sum ────────────────────────────────────────────────────────
  2559:['pat_topic::prefix-sum::ps-1d', 'pat_ds::array::prefix-sum::ps-1d'],   // Count Vowel Strings in Ranges

  // ── BS-on-answer COMPOUND sub-pattern (simulated feasibility, not Σceil).
  //    719 carries it on its bs-on-answer entry above. ──
  410: ['pat_topic::binary-search::bs-on-answer-compound', 'pat_ds::array::binary-search::bs-on-answer-compound'], // Split Array Largest Sum (greedy split sim)
  1011:['pat_topic::binary-search::bs-on-answer-compound', 'pat_ds::array::binary-search::bs-on-answer-compound'], // Capacity To Ship Packages Within D Days
  1231:['pat_topic::binary-search::bs-on-answer-compound', 'pat_ds::array::binary-search::bs-on-answer-compound'], // Divide Chocolate (greedy split sim)
  1482:['pat_topic::binary-search::bs-on-answer-compound', 'pat_ds::array::binary-search::bs-on-answer-compound'], // Min Days to Make m Bouquets (adjacency sim)
  1898:['pat_topic::binary-search::bs-on-answer-compound', 'pat_ds::array::binary-search::bs-on-answer-compound'], // Max Removable Characters (subsequence sim)
  2517:['pat_topic::binary-search::bs-on-answer-compound', 'pat_ds::array::binary-search::bs-on-answer-compound'], // Max Tastiness of Candy Basket (greedy gap sim)
  2616:['pat_topic::binary-search::bs-on-answer-compound', 'pat_ds::array::binary-search::bs-on-answer-compound'], // Minimize Max Diff of K Pairs (greedy pair sim)

  // ── Batch 11 (this turn) — NEW TOPIC: divide-conquer ─────────────────────
  // Scope rule: problems carrying LeetCode's own "Divide and Conquer" topic,
  // assigned to one of the 5 micros. Ids already keyed earlier in this literal
  // (53, 148, 240, 324, 395, 918, 2031, 3719, 3721, 3737, 3739) carry their
  // dc tags on those entries instead — duplicate keys would overwrite.
  // Deliberately NOT tagged: 4 (binary-search partition, not a D&C combine),
  // 190 / 191 (bit tricks LeetCode files under D&C), 372 (fast exponentiation),
  // 1756 (a design problem; the D&C tag is noise).
  169: ['pat_topic::divide-conquer::dc-split-combine',
        'pat_ds::array::divide-conquer::dc-split-combine'],            // Majority Element (D&C alt to Boyer-Moore)
  315: ['pat_topic::divide-conquer::dc-merge-count',
        'pat_ds::array::divide-conquer::dc-merge-count'],              // Count of Smaller Numbers After Self
  327: ['pat_topic::divide-conquer::dc-merge-count',
        'pat_ds::array::divide-conquer::dc-merge-count'],              // Count of Range Sum (merge on prefix sums)
  493: ['pat_topic::divide-conquer::dc-merge-count',
        'pat_ds::array::divide-conquer::dc-merge-count'],              // Reverse Pairs
  215: ['pat_topic::divide-conquer::dc-quickselect',
        'pat_ds::array::divide-conquer::dc-quickselect'],              // Kth Largest Element in an Array
  347: ['pat_topic::divide-conquer::dc-quickselect',
        'pat_ds::array::divide-conquer::dc-quickselect'],              // Top K Frequent Elements
  973: ['pat_topic::divide-conquer::dc-quickselect',
        'pat_ds::array::divide-conquer::dc-quickselect'],              // K Closest Points to Origin
  1985:['pat_topic::divide-conquer::dc-quickselect',
        'pat_ds::array::divide-conquer::dc-quickselect'],              // Kth Largest Integer in the Array
  105: ['pat_topic::divide-conquer::dc-tree-build',
        'pat_ds::tree::divide-conquer::dc-tree-build'],                // Construct BT from Preorder + Inorder
  106: ['pat_topic::divide-conquer::dc-tree-build',
        'pat_ds::tree::divide-conquer::dc-tree-build'],                // Construct BT from Inorder + Postorder
  889: ['pat_topic::divide-conquer::dc-tree-build',
        'pat_ds::tree::divide-conquer::dc-tree-build'],                // Construct BT from Preorder + Postorder
  427: ['pat_topic::divide-conquer::dc-tree-build',
        'pat_ds::tree::divide-conquer::dc-tree-build'],                // Construct Quad Tree
  108: ['pat_topic::divide-conquer::dc-tree-build',
        'pat_ds::bst::divide-conquer::dc-tree-build'],                 // Convert Sorted Array to BST
  23:  ['pat_topic::divide-conquer::dc-k-way-merge',
        'pat_ds::linked-list::divide-conquer::dc-k-way-merge'],        // Merge k Sorted Lists

  // ── Batch: connectivity-cut neighbours of 1568 ───────────────────────
  // 1568 (Min Days to Disconnect Island) sat on tarjan-bridges with only
  // 1192 for company; these two are its nearest neighbours and were
  // carrying no pat tags at all.
  2556:['pat_ds::graph::core::tarjan-bridges',                        // Disconnect Path in a Binary Matrix by
        'pat_ds::matrices::core::mat-grid-dfs-bfs',                   //   at Most One Flip — the "can ONE cell
        'pat_topic::dfs::dfs-grid-flood',                             //   disconnect it" cut-vertex question on
        'pat_ds::matrices::dfs::dfs-grid-flood'],                     //   a grid (2 disjoint paths ⇒ no)
  827: ['pat_ds::graph::core::cc-dfs-uf',                             // Making A Large Island — the INVERSE of
        'pat_ds::graph::union-find::uf-with-size',                    //   1568: flip one 0→1 to MERGE islands
        'pat_ds::matrices::core::mat-grid-dfs-bfs',                   //   rather than one 1→0 to split one.
        'pat_topic::dfs::dfs-grid-flood',                             //   Component labelling + sizes, same
        'pat_ds::matrices::dfs::dfs-grid-flood'],                     //   grid-flood substrate

  // ── Batch: ScaleAI list — the 5 members that carried no pat tags ──────
  // Run scoped: --only 846,630,1094,1344,393
  // 1344 and 393 get GROUP-level tags only; neither has an honest micro in
  // the catalog yet (see the note in the ScaleAI list commit).
  846: ['pat_ds::array::hash::freq-counter',                          // Hand of Straights — Counter, then
        'pat_topic::hash::freq-counter'],                             //   consume k consecutive from the min key
  630: ['pat_ds::array::greedy::greedy-end-sorted',                   // Course Schedule III — sort by deadline,
        'pat_group::scheduling'],                                     //   regret-swap the longest course out
  1094:['pat_topic::prefix-sum::difference-array',                    // Car Pooling — +n at from, −n at to,
        'pat_ds::array::prefix-sum::difference-array'],               //   integrate once (twin of 1109)
  1344:['pat_group::simulation'],                                     // Angle Between Hands — closed-form clock
                                                                      //   arithmetic; spec-following, like 2303
  393: ['pat_group::simulation'],                                     // UTF-8 Validation — mask/shift byte scan
                                                                      //   with a continuation counter
}

// ── env + auth (matches the convention used by sibling scripts) ──────────
async function loadEnv() {
  const text = await readFile(join(__dir, '../portal/.env.local'), 'utf8')
  const env = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  if (!env.VITE_SHEET_ID) throw new Error('Missing VITE_SHEET_ID in portal/.env.local')
  return { sheetId: env.VITE_SHEET_ID }
}
async function authorize() {
  const creds = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
  const cfg = creds.installed ?? creds.web
  const c = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, 'http://localhost:3000')
  try {
    const token = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
    const granted = (token.scope ?? '').split(/\s+/)
    if (!SCOPES.every(s => granted.includes(s))) return getNewToken(c)
    c.setCredentials(token)
    c.on('tokens', t => writeFile(TOKEN_PATH, JSON.stringify({ ...token, ...t })))
    return c
  } catch { return getNewToken(c) }
}
function getNewToken(c) {
  const url = c.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES })
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const code = new URL(req.url, 'http://localhost:3000').searchParams.get('code')
      if (!code) { res.end('No code'); return }
      res.end('<h2>✓ Authorized — close this tab.</h2>'); server.close()
      try { const { tokens } = await c.getToken(code); c.setCredentials(tokens); await writeFile(TOKEN_PATH, JSON.stringify(tokens)); resolve(c) } catch (e) { reject(e) }
    })
    server.listen(3000, () => { console.log('\nAuthorize in browser:\n  ' + url + '\n'); exec(`open "${url}"`) })
    server.on('error', reject)
  })
}

async function main() {
  const { sheetId } = await loadEnv()
  const auth        = await authorize()
  const sheets      = google.sheets({ version: 'v4', auth })
  const { data }    = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId, range: `${TAB}!A2:H`,
  })
  const rows = data.values || []
  console.log(`\n  Read ${rows.length} LCProblems rows.`)
  console.log(`  Batch has ${Object.keys(BATCH).length} LC ids queued.\n`)

  const byId = new Map()
  rows.forEach((r, i) => {
    const id = (r[COL_ID] || '').trim()
    if (id) byId.set(id, { rowIdx: i, tags: r[COL_TAGS] || '' })
  })

  const requests = []
  const missing  = []
  let totalAdd   = 0

  for (const [lcId, newTags] of Object.entries(BATCH)) {
    if (ONLY && !ONLY.has(String(lcId))) continue
    const row = byId.get(String(lcId))
    if (!row) { missing.push(lcId); continue }
    const existing = new Set(row.tags.split(/[;\n]+/).map(s => s.trim()).filter(Boolean))
    const toAdd = newTags.filter(t => !existing.has(t))
    if (!toAdd.length) {
      console.log(`    LC ${lcId.padStart(4)}  (all tags already present)`)
      continue
    }
    const merged = [...existing, ...toAdd].join('; ')
    requests.push({ range: `${TAB}!H${row.rowIdx + 2}`, values: [[merged]] })
    totalAdd += toAdd.length
    console.log(`    LC ${lcId.padStart(4)}  +${toAdd.join('  +')}`)
  }

  if (missing.length) console.log(`\n  Missing from sheet: ${missing.join(', ')}`)
  console.log(`\n  ${requests.length} rows would change; ${totalAdd} new tag occurrences.\n`)

  if (!DO_WRITE) { console.log('  [dry-run] no sheet writes performed.  Pass --write to apply.\n'); return }
  if (!requests.length) { console.log('  Nothing to write.\n'); return }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: 'RAW', data: requests },
  })
  console.log(`  ✓ Patched ${requests.length} rows.\n`)
  console.log(`  Next: node scripts/build-patterns-csv.mjs --write\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
