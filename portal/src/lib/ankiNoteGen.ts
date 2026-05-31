// Ask the LLM to populate ALL fields of a chosen template from a free-text
// prompt. Used by the "Add Note" modal so the user can describe what they
// want studied and have the Front / Back / extras filled in automatically.
//
// The model is told the template's exact field schema (key, label, hints,
// front/back role) and returns strict JSON keyed by field key, so the
// caller can drop the result straight into form state.

import type { AnkiField, AnkiTemplate } from '../adapters/ankiRepo'
import { LLM } from './llm'
import { parseLooseJson } from './looseJson'

export interface AnkiNoteDraft {
  fields: Record<string, string>
  tags:   string[]
}

function fieldSpec(f: AnkiField): string {
  const role = f.isFront ? 'FRONT' : f.isBack ? 'BACK' : 'EXTRA'
  const hint =
    f.type === 'select' && f.options
      ? `enum (one of: ${f.options})`
      : f.type === 'html' || f.isFront || f.isBack
        ? 'HTML required — see Rule 4 for structure'
        : 'plain text'
  return `  - "${f.key}" (${f.label}) — role=${role}, ${hint}`
}

function buildSystemPrompt(tpl: AnkiTemplate): string {
  const sortedFields = [...tpl.fields].sort((a, b) => a.order - b.order)
  const fieldsBlock  = sortedFields.map(fieldSpec).join('\n')
  const schemaKeys   = sortedFields.map(f => `    "${f.key}": "…"`).join(',\n')
  return [
    `You generate a single spaced-repetition flashcard for the Anki-style template "${tpl.displayName}".`,
    `Output STRICT JSON ONLY — no prose, no markdown fences, no commentary. First character "{", last character "}".`,
    ``,
    `Template fields:`,
    fieldsBlock,
    ``,
    `Schema:`,
    `{`,
    `  "fields": {`,
    schemaKeys,
    `  },`,
    `  "tags": ["snake_case_topic", "tech::subtopic"]   // 1-4 tags; "::" for hierarchy`,
    `}`,
    ``,
    `Rules:`,
    `1. Output JSON only. Every key in "fields" MUST match the template field keys above exactly.`,
    `2. FRONT field(s) hold the question / cue. BACK field(s) hold the answer / explanation. EXTRA fields hold supporting context (examples, mnemonics, source) — fill them only if genuinely useful, otherwise return "".`,
    `3. The card must be FULLY self-contained. A learner who has not seen the source prompt must understand it.`,
    `4. For FRONT / BACK / html fields, return WELL-FORMATTED HTML (not Markdown, not plain text). Use the structure that makes the content readable:`,
    `   • Wrap each paragraph in <p>…</p>.`,
    `   • Use <strong> for inline section labels (e.g. "<strong>Idea:</strong> …") instead of Markdown ** or ##.`,
    `   • Bulleted lists: <ul><li>…</li></ul>. Numbered: <ol><li>…</li></ol>.`,
    `   • Multi-line code: <pre><code>…</code></pre> with real newlines inside. Inline code: <code>…</code>. Escape <, > and & in code as &lt;, &gt;, &amp;.`,
    `   • For multi-section technical answers (e.g. Idea / Algorithm / Complexity / Example) emit each as its own <p><strong>Section:</strong> …</p> followed by a <pre><code> example if relevant.`,
    `   • Allowed tags: p, ul, ol, li, strong, em, code, pre, br, h3, h4. NO <script>, <style>, <iframe>, external URLs.`,
    `5. For select fields, the value MUST be one of the listed options exactly. If unsure, return "".`,
    `6. Keep the FRONT concise (a single question or cloze prompt). The BACK should be as long as the topic requires — for technical answers prefer 3-6 short sections with a code example over a one-liner. Don't truncate code; show the full minimal solution.`,
    `7. Tags describe the SUBJECT (e.g. "javascript::async", "biology::cell"). Lowercase, snake_case, "::" for hierarchy.`,
    ``,
    `Example of a well-formatted BACK for a coding question:`,
    `"<p><strong>Idea:</strong> sliding window — keep a count map of the last K elements and shrink from the left when the window grows.</p>` +
    `<p><strong>Algorithm:</strong></p><ol><li>Two pointers <code>l</code>, <code>r</code>.</li><li>Expand <code>r</code>; update map.</li><li>While invariant breaks, shrink <code>l</code>.</li></ol>` +
    `<p><strong>Code:</strong></p><pre><code>def f(nums, k):\\n    cnt = {}\\n    l = 0\\n    for r, x in enumerate(nums):\\n        cnt[x] = cnt.get(x, 0) + 1\\n        while len(cnt) &gt; k:\\n            cnt[nums[l]] -= 1\\n            if cnt[nums[l]] == 0: del cnt[nums[l]]\\n            l += 1\\n    return r - l + 1</code></pre>` +
    `<p><strong>Complexity:</strong> O(n) time, O(k) space.</p>"`,
  ].join('\n')
}

export async function generateAnkiNoteForTemplate(
  template:  AnkiTemplate,
  prompt:    string,
  // Bumped 1500 → 2500 so multi-section BACKs with code blocks don't get
  // truncated mid-snippet — the well-formatted HTML guidance above can
  // easily run over 1500 tokens for a non-trivial coding answer.
  maxTokens = 2500,
): Promise<AnkiNoteDraft | null> {
  const text = prompt.trim()
  if (!text) return null
  const reply = await LLM.chat([
    { role: 'system', content: buildSystemPrompt(template) },
    { role: 'user',   content: text },
  ], maxTokens)
  return normalize(parseLooseJson(reply), template)
}

// Last-mile safety net: if the model returns markdown-ish text despite the
// system prompt, convert the common forms to HTML so the saved note still
// renders cleanly. Idempotent on HTML input — we only touch obviously-
// markdown patterns and run an "already-HTML" sniff first.
function looksLikeHtml(s: string): boolean {
  return /<\/?(p|div|ul|ol|li|pre|code|h[1-6]|br|strong|em|table)\b/i.test(s)
}

function escapeHtmlBasics(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineMdToHtml(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${escapeHtmlBasics(c)}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>')
}

export function markdownishToHtml(s: string): string {
  if (!s) return ''
  // Already HTML? Just run the inline transforms over text nodes via a
  // DOMParser, so backticks inside <p>…</p> still become <code>.
  if (looksLikeHtml(s)) {
    try {
      const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${s}</body></html>`, 'text/html')
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
      const text: Text[] = []
      let n: Node | null
      while ((n = walker.nextNode())) text.push(n as Text)
      for (const t of text) {
        // Skip text inside <code>/<pre>; those are intentional verbatim.
        let parent: Node | null = t.parentNode
        let inCode = false
        while (parent && parent !== doc.body) {
          const tag = (parent as HTMLElement).tagName?.toLowerCase()
          if (tag === 'code' || tag === 'pre') { inCode = true; break }
          parent = parent.parentNode
        }
        if (inCode) continue
        const raw = t.nodeValue ?? ''
        if (!/[`*]/.test(raw)) continue
        const span = doc.createElement('span')
        span.innerHTML = inlineMdToHtml(escapeHtmlBasics(raw))
        // Unwrap span: insert its children before, then drop the span.
        const frag = doc.createDocumentFragment()
        while (span.firstChild) frag.appendChild(span.firstChild)
        t.parentNode?.replaceChild(frag, t)
      }
      return doc.body.innerHTML
    } catch { return s }
  }

  // Plain text / markdown — full conversion.
  // Extract fenced code blocks first so later transforms don't touch them.
  const blocks: string[] = []
  s = s.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, c) => {
    const i = blocks.push(c) - 1
    return `__MDCB${i}__`
  })

  const lines = s.split('\n')
  const out: string[] = []
  let inUl = false, inOl = false
  function closeLists() {
    if (inUl) { out.push('</ul>'); inUl = false }
    if (inOl) { out.push('</ol>'); inOl = false }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { closeLists(); continue }
    // # headings → h3/h4
    const h = /^(#{2,4})\s+(.+)$/.exec(line)
    if (h) {
      closeLists()
      const level = Math.min(h[1].length + 1, 6)
      out.push(`<h${level}>${inlineMdToHtml(escapeHtmlBasics(h[2]))}</h${level}>`)
      continue
    }
    // - or * bullet
    if (/^[-*]\s+/.test(line)) {
      if (inOl) { out.push('</ol>'); inOl = false }
      if (!inUl) { out.push('<ul>'); inUl = true }
      out.push(`<li>${inlineMdToHtml(escapeHtmlBasics(line.replace(/^[-*]\s+/, '')))}</li>`)
      continue
    }
    // 1. numbered
    if (/^\d+\.\s+/.test(line)) {
      if (inUl) { out.push('</ul>'); inUl = false }
      if (!inOl) { out.push('<ol>'); inOl = true }
      out.push(`<li>${inlineMdToHtml(escapeHtmlBasics(line.replace(/^\d+\.\s+/, '')))}</li>`)
      continue
    }
    closeLists()
    out.push(`<p>${inlineMdToHtml(escapeHtmlBasics(line))}</p>`)
  }
  closeLists()

  let html = out.join('')
  html = html.replace(/__MDCB(\d+)__/g, (_, i) => {
    const c = escapeHtmlBasics(blocks[Number(i)])
    return `<pre><code>${c}</code></pre>`
  })
  return html
}

function normalize(raw: unknown, template: AnkiTemplate): AnkiNoteDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { fields?: unknown; tags?: unknown }
  const out: Record<string, string> = {}
  const incoming = (obj.fields && typeof obj.fields === 'object')
    ? obj.fields as Record<string, unknown>
    : {}
  // Only keep keys the template actually declares so unknown keys don't
  // leak into the sheet write.
  for (const f of template.fields) {
    const v = incoming[f.key]
    let s = typeof v === 'string' ? v : (v == null ? '' : String(v))
    // Safety net: convert any leftover markdown to HTML for rich fields so
    // the rendered card reads cleanly even when the model ignored the
    // HTML-required directive in the prompt.
    if (s && (f.type === 'html' || f.isFront || f.isBack)) {
      s = markdownishToHtml(s)
    }
    out[f.key] = s
  }
  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.trim())
        .filter(Boolean)
    : []
  return { fields: out, tags }
}
