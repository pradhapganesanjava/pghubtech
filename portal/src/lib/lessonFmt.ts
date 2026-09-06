// Lesson prose → scannable bullets.
//
// A lesson is re-read under time pressure, so no line may run past ~80 chars.
// The AI extractor is asked for short bullets, but manual entries and every
// lesson written before that rule still arrive as one long sentence — so the
// display splits rather than trusting the source.

export const LESSON_LINE_MAX = 80

// Clause joints, longest first so "instead of" wins over "of". Splitting here
// keeps a bullet readable; splitting mid-phrase does not.
const JOINTS = [
  ' instead of ', ' rather than ', ' which ', ' because ', ' so that ', ' so ',
  ' but ', ' however ', ' while ', ' whereas ', ' and then ', ' and ', ' then ',
]

// Break one over-long segment at the latest joint that still fits, repeatedly.
function breakClause(seg: string, max: number): string[] {
  if (seg.length <= max) return [seg]
  let best = -1, bestJoint = ''
  for (const j of JOINTS) {
    // Prefer a joint in the second half — an early one leaves a stub bullet.
    const idx = seg.lastIndexOf(j, max)
    if (idx > max * 0.35 && idx > best) { best = idx; bestJoint = j }
  }
  if (best > 0) {
    const head = seg.slice(0, best).trim()
    // Keep the connective on the continuation: "which creates pressure" reads,
    // "creates pressure" loses why it is there.
    const tail = (bestJoint.trim() + ' ' + seg.slice(best + bestJoint.length)).trim()
    return [head, ...breakClause(tail, max)]
  }
  // No joint: fall back to a comma, then to the last space before the cap.
  const comma = seg.lastIndexOf(', ', max)
  if (comma > max * 0.35) {
    return [seg.slice(0, comma).trim(), ...breakClause(seg.slice(comma + 2).trim(), max)]
  }
  const space = seg.lastIndexOf(' ', max)
  if (space <= 0) return [seg]
  return [seg.slice(0, space).trim(), ...breakClause(seg.slice(space + 1).trim(), max)]
}

export function lessonLines(text: string, max = LESSON_LINE_MAX): string[] {
  return String(text || '')
    // Authored newlines first, then sentences, then semicolons. The lookbehind
    // keeps "e.g." and friends from starting a new bullet.
    .split(/\n+/)
    .flatMap(p => p.split(/(?<!\b(?:e\.g|i\.e|vs|cf|approx))\.\s+(?=[A-Z(\d])/))
    .flatMap(p => p.split(/;\s*/))
    .map(x => x.trim().replace(/[.;,]$/, ''))
    .filter(Boolean)
    .flatMap(seg => breakClause(seg, max))
    .map(x => x.trim())
    .filter(Boolean)
}
