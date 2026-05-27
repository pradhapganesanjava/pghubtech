import { useEffect, useMemo, useRef } from 'react'
import { buildLineage } from '../lib/lineage'
import type { LCProblem } from '../adapters/adsRepo'

interface Props {
  problems:      LCProblem[]
  focusNum:      number | null            // LeetCode number to focus, or null
  onOpenProblem: (num: string) => void    // a problem node was clicked in the graph
}

// Bridges the bundled knowledge_graph.html (public/lineage/) and AdsHub:
//   • builds the entity/relation graph from LCProblems and pushes it in
//   • relays node clicks back out so the portal can open the problem detail
//   • forwards a focus request (the 🌳 button on a problem)
export default function AdsLineage({ problems, focusNum, onOpenProblem }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef  = useRef(false)
  const focusRef  = useRef(focusNum)
  focusRef.current = focusNum

  // Heavy: ~4k problems → run once per dataset.
  const graph = useMemo(() => buildLineage(problems), [problems])
  const graphRef = useRef(graph)
  graphRef.current = graph

  function pushAll() {
    const w = iframeRef.current?.contentWindow
    if (!w) return
    w.postMessage({ type: 'kg-data', entities: graphRef.current.entities, relations: graphRef.current.relations }, '*')
    if (focusRef.current != null) w.postMessage({ type: 'kg-focus', num: focusRef.current }, '*')
  }

  // Inbound messages from the graph iframe.
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return
      const d = ev.data || {}
      if (d.type === 'kg-ready') { readyRef.current = true; pushAll() }
      else if (d.type === 'kg-open-problem' && d.num != null) onOpenProblem(String(d.num))
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onOpenProblem])

  // Re-push when the dataset changes (after ready).
  useEffect(() => { if (readyRef.current) pushAll() /* eslint-disable-next-line */ }, [graph])

  // Forward focus changes once the iframe is ready.
  useEffect(() => {
    if (focusNum != null && readyRef.current) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'kg-focus', num: focusNum }, '*')
    }
  }, [focusNum])

  const base = import.meta.env.BASE_URL || '/'
  return (
    <iframe
      ref={iframeRef}
      title="Lineage graph"
      className="adshub-lineage-frame"
      src={`${base}lineage/knowledge_graph.html`}
      onLoad={pushAll}
    />
  )
}
