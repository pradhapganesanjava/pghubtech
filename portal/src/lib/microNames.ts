// Display names for micro-pattern ids ("bfs-multi-source" → "Multi-Source
// BFS"), read from the shared catalog public/patterns-catalog.js — the same
// file patterns.html and the lineage graph load. The catalog is a plain script
// that sets window.PG_PATTERNS, so it is injected once and read back.
// Ids the catalog doesn't define fall back to a prettified id.

interface CatalogPattern { id: string; name: string; micros?: { id: string; name: string }[] }
declare global { interface Window { PG_PATTERNS?: CatalogPattern[] } }

export interface MicroNames { micro: Map<string, string>; topic: Map<string, string> }

let _p: Promise<MicroNames> | null = null

export function loadMicroNames(): Promise<MicroNames> {
  if (_p) return _p
  _p = new Promise<void>(resolve => {
    if (window.PG_PATTERNS) { resolve(); return }
    const s = document.createElement('script')
    s.src = `${import.meta.env.BASE_URL}patterns-catalog.js?v=${__BUILD_ID__}`
    s.onload = () => resolve()
    s.onerror = () => resolve()          // names are a nicety; ids still work
    document.head.appendChild(s)
  }).then(() => {
    const micro = new Map<string, string>(), topic = new Map<string, string>()
    for (const p of window.PG_PATTERNS ?? []) {
      topic.set(p.id, p.name)
      for (const m of p.micros ?? []) micro.set(m.id, m.name)
    }
    return { micro, topic }
  })
  return _p
}

export const prettyId = (id: string) =>
  id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
