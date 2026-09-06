// Root-title derivation, kept out of todoGen.ts so it can be tested without
// dragging in the LLM client (which reads import.meta.env and only exists
// under Vite).

// The fallback when the model returns no root_title. It used to paste the raw
// instruction and cut it at exactly 60 chars, which severed words mid-syllable
// ("…must be le") and made every root read like a sentence fragment.
//
// A root is a LABEL: drop the spoken lead-in, keep the subject, break on a word.
export function deriveRootTitle(context: string, max = 42): string {
  let t = (context.trim().split(/\n+/)[0] ?? '').trim()
  // "Let me learn about X", "I want to prepare X", "Please help me with X" → X
  for (let i = 0; i < 3; i++) {
    t = t.replace(
      /^\s*(?:let(?:'s| us| me)?|i (?:want to|need to|would like to|should)|please|help me|can you|start|begin)\s+/i, '')
     .replace(/^\s*(?:learn|study|prepare|understand|explore|master|read|practice|do)\s+(?:about|for|on|the)?\s*/i, '')
     .trim()
  }
  if (!t) t = context.trim().split(/\n+/)[0] ?? ''
  if (!t) return 'Generated plan'
  // Stop at the first clause — the rest is usually the how, not the what.
  t = t.split(/\s+(?:so that|such that|such a way|so|which|because)\s+/i)[0].trim()
  t = t.replace(/[\s,;.:–—-]+$/, '')
  if (t.length > max) {
    const cut = t.slice(0, max)
    const sp  = cut.lastIndexOf(' ')
    t = (sp > max * 0.4 ? cut.slice(0, sp) : cut).replace(/[\s,;.:–—-]+$/, '') + '…'
  }
  return t.charAt(0).toUpperCase() + t.slice(1)
}

// Re-derive an EXISTING root's name, preserving the " · YYYY-MM-DD" stamp that
// acceptDrafts appends — the date is how you tell two runs of the same plan
// apart, so tidying the label must not eat it.
export function tidyRootTitle(existing: string): string {
  const m = existing.match(/^(.*?)\s+·\s+(\d{4}-\d{2}-\d{2})\s*$/)
  // The ellipsis stays: stripping it made a second tidy produce different text
  // from the first, so the button would never settle.
  const body = (m ? m[1] : existing).trim()
  const tidied = deriveRootTitle(body)
  return m ? `${tidied} · ${m[2]}` : tidied
}
