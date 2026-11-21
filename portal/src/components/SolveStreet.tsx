// SolveStreet — "street view" in Solve Path's 🗺 Map tab: one problem in the
// middle, its strongest level-1 connections around it. Line thickness is the
// match score, line colour the aspect that contributes most (data structure /
// technique / family / story). Click a neighbour to move there. A route, when
// set, is drawn as the next step to take.

import { dominantAspect, featureLabel, aspectOfKey, ASPECTS, type Link, type MapIndex, type AspectOn, type Names } from '../lib/solveMap'
import { levelMeta, type ComfortEntry } from '../adapters/comfortRepo'

interface Props {
  ix:        MapIndex
  on:        AspectOn
  names:     Names | null
  comfort:   Map<string, ComfortEntry>
  centerId:  string
  links:     Link[]               // level-1 connections, best first
  nextStep:  string | null        // the route's next problem, if on a route
  onMove:    (pid: string) => void
}

const W = 1000, H = 600, CX = 500, CY = 300

export default function SolveStreet({ ix, on, names, comfort, centerId, links, nextStep, onMove }: Props) {
  const center = ix.byId.get(centerId)
  if (!center) return null
  const n = links.length
  const pos = links.map((l, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1)
    return { l, x: CX + 390 * Math.cos(a), y: CY + 225 * Math.sin(a) }
  })
  const lvl = (id: string) => comfort.get(id)?.level ?? 'none'
  const short = (t: string) => (t.length > 24 ? t.slice(0, 23) + '…' : t)

  return (
    <div className="ss">
      <svg className="ss-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        {pos.map(({ l, x, y }) => (
          <g key={'e' + l.id}>
            <line className={`sm-edge sm-a-${dominantAspect(ix, l.shared, on)}${l.id === nextStep ? ' next' : ''}`}
              x1={CX} y1={CY} x2={x} y2={y} strokeWidth={1.5 + 9 * l.sim} />
            <text className="ss-pct" x={CX + (x - CX) * 0.55} y={CY + (y - CY) * 0.55}>{Math.round(l.sim * 100)}%</text>
          </g>
        ))}
        {pos.map(({ l, x, y }) => {
          const p = ix.byId.get(l.id)!
          const r = 18 + 22 * l.sim
          return (
            <g key={'n' + l.id} className="ss-node" onClick={() => onMove(l.id)}>
              <title>{`#${p.frontendId} ${p.title} · ${Math.round(l.sim * 100)}% match`}</title>
              <circle cx={x} cy={y} r={r} className={`sm-p sm-c-${lvl(l.id)}${l.id === nextStep ? ' next' : ''}`} />
              <text x={x} y={y + 4} className="ss-id">#{p.frontendId}</text>
              <text x={x} y={y + r + 15} className="ss-title">{short(p.title)}</text>
            </g>
          )
        })}
        <g className="ss-center">
          <circle cx={CX} cy={CY} r={46} className={`sm-p sm-c-${lvl(centerId)} sel`} />
          <text x={CX} y={CY + 5} className="ss-id ss-id-c">#{center.frontendId}</text>
          <text x={CX} y={CY + 66} className="ss-title ss-title-c">{short(center.title)}</text>
        </g>
      </svg>
      <ul className="ss-list">
        {links.map(l => {
          const p = ix.byId.get(l.id)!
          const e = comfort.get(l.id)
          return (
            <li key={l.id} className={l.id === nextStep ? 'next' : ''}>
              <button className="ss-row" onClick={() => onMove(l.id)}>
                <span className="ss-pct-chip">{Math.round(l.sim * 100)}%</span>
                <span className={`sp-num ${p.difficulty === 'Easy' ? 'sp-easy' : p.difficulty === 'Hard' ? 'sp-hard' : 'sp-medium'}`}>#{p.frontendId}</span>
                <span className="ss-row-title">{p.title}</span>
                {e && <span title={levelMeta(e.level).label}>{levelMeta(e.level).icon}</span>}
                {l.id === nextStep && <span className="ss-next-tag">next on route</span>}
              </button>
              <div className="ss-shared">
                {l.shared
                  .sort((a, b) => ASPECTS.findIndex(x => x.id === aspectOfKey(a)) - ASPECTS.findIndex(x => x.id === aspectOfKey(b)))
                  .map(k => (
                    <span key={k} className={`ss-chip sm-a-${aspectOfKey(k)}`}>
                      {ASPECTS.find(x => x.id === aspectOfKey(k))!.icon} {featureLabel(k, names)}
                    </span>
                  ))}
              </div>
            </li>
          )
        })}
        {!links.length && <li className="sp-dim">No connections with the aspects switched on. Turn on more aspects, or tag this problem in AdsHub.</li>}
      </ul>
    </div>
  )
}
