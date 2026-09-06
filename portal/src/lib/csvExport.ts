// Tiny CSV export helper for AdsHub Browse (and any future caller).
//
// Always quotes every cell (handles commas / newlines / quotes safely with
// the standard "double the quote" CSV escape), prepends a UTF-8 BOM so Excel
// detects the encoding correctly, and triggers a download via an anchor.

export function csvCell(v: string | number | undefined | null): string {
  const s = v == null ? '' : String(v)
  return '"' + s.replace(/"/g, '""') + '"'
}

export function csvFromRows(header: string[], rows: (string | number | undefined | null)[][]): string {
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n')
}

// Strip HTML → plain text, suitable for a CSV cell. Block-level elements get
// a separating space so words don't fuse together; runs of whitespace collapse
// to a single space (CSV authors don't want literal newlines mid-cell).
export function htmlToCsvText(html: string): string {
  if (!html) return ''
  try {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body>${html}</body></html>`,
      'text/html',
    )
    doc.querySelectorAll('style, script, noscript').forEach(el => el.remove())
    doc.querySelectorAll('br').forEach(br => br.replaceWith(' '))
    doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr').forEach(el => {
      el.append(' ')
    })
    return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
  } catch {
    // Fallback if DOMParser is unavailable for some reason.
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }
}

// Trigger a browser download for the given CSV text.
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Trigger a browser download for arbitrary text (JSON backups, exports).
export function downloadText(text: string, filename: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
