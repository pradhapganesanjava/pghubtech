// Audio-mode helpers for HomeView card review.
//
// Two responsibilities:
//   1. htmlToSpokenText(html) — turn rendered card HTML into a clean plain-text
//      string suitable for TTS. Skips <pre>/<code> blocks entirely (you don't
//      want a TTS voice reading curly braces and semicolons aloud) and strips
//      <style>/<script>. Collapses whitespace.
//   2. chunkForTts(text, max) — split a long string into TTS-sized chunks
//      (Azure TTS caps individual requests at ~4096 chars; we default to 3000
//      to leave headroom and to break at sentence boundaries when possible).
//      Returns an array — callers play chunk 0, then offer a "Continue" button
//      to play chunk 1, etc.

const CODE_OMITTED_NOTE = '… (code block omitted) …'

export function htmlToSpokenText(html: string): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html')

  // Drop sub-trees we never want to narrate.
  doc.querySelectorAll('style, script, noscript, svg, canvas').forEach(el => el.remove())

  // Replace each <pre>/<code> block with a marker so the listener at least
  // knows a code block was skipped (instead of silent gap mid-explanation).
  doc.querySelectorAll('pre, code').forEach(el => {
    const marker = doc.createTextNode(CODE_OMITTED_NOTE)
    el.replaceWith(marker)
  })

  // Block-level elements → ensure a newline shows up in textContent so the
  // chunker has natural sentence boundaries even when authors omit periods.
  doc.querySelectorAll('br').forEach(br => br.replaceWith(doc.createTextNode('\n')))
  doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, hr').forEach(el => {
    el.appendChild(doc.createTextNode('\n'))
  })

  const raw = doc.body.textContent ?? ''
  return raw
    .replace(/ /g, ' ')        // nbsp → space
    .replace(/[ \t]+/g, ' ')        // collapse runs of spaces
    .replace(/\n[ \t]+/g, '\n')     // trim line starts
    .replace(/[ \t]+\n/g, '\n')     // trim line ends
    .replace(/\n{3,}/g, '\n\n')     // collapse blank runs
    .trim()
}

// Split text into TTS-sized chunks at the nicest available boundary
// (paragraph → sentence → word → hard cut). max is exclusive upper bound.
export function chunkForTts(text: string, max = 3000): string[] {
  if (!text) return []
  if (text.length <= max) return [text]
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + max, text.length)
    if (end < text.length) {
      // Try to break on a paragraph, then sentence, then space, in that order.
      const slice = text.slice(i, end)
      const para  = slice.lastIndexOf('\n\n')
      const sent  = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '))
      const word  = slice.lastIndexOf(' ')
      const cut   = para > max * 0.3 ? para + 2
                  : sent > max * 0.3 ? sent + 2
                  : word > max * 0.5 ? word + 1
                  : slice.length
      end = i + cut
    }
    out.push(text.slice(i, end).trim())
    i = end
  }
  return out.filter(c => c.length > 0)
}
