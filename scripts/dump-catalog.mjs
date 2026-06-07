import fs from 'fs'
const s = fs.readFileSync('portal/public/patterns.html', 'utf8')
const start = s.indexOf('const PATTERNS')
const m = s.slice(start)

// Pattern headers: { tab: '...', id: '...', name: '...', icon: '...'
const patRe = /\{\s*tab:\s*'([^']+)',\s*id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*icon:\s*'([^']+)'/g
const pats = []
let mm
while ((mm = patRe.exec(m))) pats.push({ tab: mm[1], id: mm[2], name: mm[3], pos: mm.index })

// Micro entries: { id: '...', name: '...'   — assign to the nearest preceding pattern header.
const micRe = /\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)'/g
const mics = []
while ((mm = micRe.exec(m))) {
  // Skip if this is actually a pattern header (has tab before it on same brace) — pattern headers start with tab:
  const pre = m.slice(Math.max(0, mm.index - 12), mm.index)
  if (/tab:\s*'$/.test(m.slice(mm.index, mm.index + 80))) continue
  mics.push({ id: mm[1], name: mm[2], pos: mm.index })
}

let totalMicros = 0
for (let i = 0; i < pats.length; i++) {
  const p = pats[i]
  const next = pats[i + 1] ? pats[i + 1].pos : m.length
  const owned = mics.filter(x => x.pos > p.pos && x.pos < next)
  totalMicros += owned.length
  console.log(`\n[${p.tab}] ${p.id}  —  ${p.name}  (${owned.length})`)
  for (const x of owned) console.log(`    ${x.id}  ::  ${x.name}`)
}
console.log(`\n\nTOTAL categories: ${pats.length}  |  micros: ${totalMicros}`)
console.log('DS:', pats.filter(p => p.tab === 'ds').map(p => p.id).join(', '))
console.log('TOPIC:', pats.filter(p => p.tab === 'topic').map(p => p.id).join(', '))
