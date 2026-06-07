import { readFile, writeFile } from 'fs/promises'
const VIS = 'portal/public/patterns-visuals.json'
const add = {
  'thread-ordering':
`  Two gates (semaphores init 0) chain the order:

    first()  ──run──▶ release(g2)
    second() acquire(g2) ──run──▶ release(g3)
    third()  acquire(g3) ──run──▶
    timeline:  first ─▶ second ─▶ third   (always)`,

  'thread-alternation':
`  Ping-pong: each releases the OTHER's semaphore:

    fooSem=1  barSem=0
    foo: acq foo │print│ rel bar
    bar:         acq bar │print│ rel foo
    → foo bar foo bar foo bar …`,

  'thread-barrier':
`  Gather the group, THEN release together:

    H ─┐
    H ─┼─▶ [barrier waits for 2H + 1O] ─▶ bond, all proceed
    O ─┘
    semaphores cap roles: hSem permits 2, oSem permits 1`,

  'thread-pool-fanout':
`  Workers share ONE atomic visited set:

        ┌─ worker1 ─ expand ─┐
   queue┼─ worker2 ─ expand ─┼─▶ visited.addIfAbsent(v) ?─▶ submit
        └─ worker3 ─ expand ─┘        (atomic check+insert)
   join all workers → done`,

  'lazy-decode-iterator':
`  Decode on demand from (symbol, count) cursor:

    "a3b1c2"      ptr→ run (a,3)
    next → a (2 left) → a (1) → a (0) → advance (b,1)
    next → b (0) → advance (c,2) …
    never materialises  a a a b c c`,

  'ordered-aggregate':
`  Heap for the extreme + set/boundary for the rest:

    smallest-infinite-set:
      bound = 1  (everything ≥ bound is "present")
      popSmallest → return bound; bound++
      addBack(x<bound) → push x to min-heap + set
      popSmallest → heap top if < bound, else bound`,

  'observer-pubsub':
`  Map event → {id: cb}; emit over a SNAPSHOT:

    subscribe('tick', f) → id 0, returns unsub()
    subscribe('tick', g) → id 1
    emit('tick') → copy [f,g] then call each
       (handler may unsubscribe mid-dispatch safely)`,

  'line-format':
`  Greedy pack, then spread leftover spaces left-first:

    width=16  words= This is an
    chars=8  gaps=2  extra=16-8=8 → 4,4
    "This····is····an"   (last line: left-justified + pad right)`,
}
const v = JSON.parse(await readFile(VIS, 'utf8')); for (const [k, val] of Object.entries(add)) v[k] = val
await writeFile(VIS, JSON.stringify(v, null, 2) + '\n')
console.log('visuals +' + Object.keys(add).length, '→ total', Object.keys(v).filter(k => k !== '_meta').length)
