// Centralised HTML sanitiser. Every dangerouslySetInnerHTML / innerHTML site
// in the portal must funnel through this so untrusted card content (sheet
// values, pasted HTML, migrated Anki decks) cannot inject script that would
// run with the user's OAuth token in scope.

import DOMPurify from 'dompurify'

// Default URI regex extended to accept blob: URLs (used for inline image
// previews). data:image/* is allowed via ADD_DATA_URI_TAGS.
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|ftp|tel|sms|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

const CONFIG: DOMPurify.Config = {
  ADD_DATA_URI_TAGS: ['img'],
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ALLOWED_URI_REGEXP,
  // Belt-and-braces: explicitly forbid common XSS sinks even though DOMPurify
  // already strips them by default.
  FORBID_TAGS:  ['script', 'iframe', 'object', 'embed', 'base', 'form'],
  FORBID_ATTR:  ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onsubmit'],
}

export function sanitizeHtml(html: string | null | undefined): string {
  if (!html) return ''
  return DOMPurify.sanitize(html, CONFIG) as string
}

// True if the URL's scheme is safe to use as a hyperlink target. Used by the
// rich editor's "Insert link" prompt before invoking createLink.
export function isSafeLinkUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return true
  return /^(?:https?|mailto|tel|sms):/i.test(trimmed)
}
