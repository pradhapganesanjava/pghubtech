// Lenient JSON parser used by AI-flow code paths. Tolerates:
//   1. ```json fences around the object.
//   2. Stray prose before / after a valid object.
//   3. Truncated responses (LLM hit max_tokens mid-value): walks the bracket
//      stack to find the last cleanly-closed boundary, then closes the still-
//      open structures IN THE CORRECT ORDER (a previous version just appended
//      `]` × N + `}` × M, which produced invalid JSON for nested arrays-in-
//      objects like Kubernetes-sized todo trees).

export function parseLooseJson(input: string): unknown | null {
  const t = (input ?? '').trim()
  if (!t) return null
  // 1. Direct
  try { return JSON.parse(t) } catch { /* fall through */ }
  // 2. ```json fence
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i)
  if (fence) {
    try { return JSON.parse(fence[1]) } catch { /* fall through */ }
  }
  // 3. Object slice "{ ... }"
  const start = t.indexOf('{')
  const end   = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) } catch { /* fall through */ }
  }
  // 4. Repair: walk the bracket stack, then try parsing at every "safe"
  //    boundary (comma / close) — from the latest backward to the earliest.
  //    Recovers from BOTH end-of-stream truncation AND mid-stream corruption
  //    (e.g. an LLM typo deep in a description string), as long as a valid
  //    prefix exists.
  if (start >= 0) {
    for (const candidate of repairedCandidates(t.slice(start))) {
      try { return JSON.parse(candidate) } catch { /* try the next one */ }
    }
  }
  return null
}

function* repairedCandidates(input: string): Generator<string> {
  const stack: ('}' | ']')[] = []
  let inStr = false, esc = false
  const snapshots: Array<{ end: number; stack: ('}' | ']')[] }> = []

  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (esc) { esc = false; continue }
    if (inStr) {
      if (c === '\\') { esc = true; continue }
      if (c === '"')  { inStr = false; continue }
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') { stack.push('}'); continue }
    if (c === '[') { stack.push(']'); continue }
    if (c === '}' || c === ']') {
      const want   = c
      const popped = stack.pop()
      if (popped !== want) break   // structural mismatch — can't reliably recover further
      snapshots.push({ end: i + 1, stack: stack.slice() })
      continue
    }
    if (c === ',') {
      // Snapshot BEFORE the comma — trimming it leaves a well-formed value list.
      snapshots.push({ end: i, stack: stack.slice() })
      continue
    }
  }

  // If the input closed cleanly, the whole thing is candidate #1.
  if (stack.length === 0 && !inStr) yield input

  // Otherwise (or in case the clean-close parse fails downstream), iterate
  // snapshots from latest to earliest, capped to bound worst-case cost.
  const MAX_ATTEMPTS = 300
  let attempts = 0
  for (let i = snapshots.length - 1; i >= 0 && attempts < MAX_ATTEMPTS; i--, attempts++) {
    const snap = snapshots[i]
    let trimmed = input.slice(0, snap.end).replace(/[\s,]+$/, '')
    for (let j = snap.stack.length - 1; j >= 0; j--) {
      trimmed += snap.stack[j]
    }
    yield trimmed
  }
}
