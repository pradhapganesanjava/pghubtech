import { readFile, writeFile } from 'fs/promises'
const VIS = 'portal/public/patterns-visuals.json'
const PSE = 'portal/public/patterns-pseudo.json'

const visuals = {
  'floyd-warshall':
`  Relax through each intermediate k (k MUST be the outer loop):

      k=0       k=1       k=2 …
    dist[i][j] = min(dist[i][j], dist[i][k] + dist[k][j])

       i ─────────────▶ j        becomes
       i ──▶ k ──▶ j   if shorter

    after all k: dist[i][j] = true shortest for every pair`,

  'digit-number-construct':
`  Peel with %, build with *base + d:

    n = 1234
      1234 % 10 = 4   n = 123
       123 % 10 = 3   n = 12
        12 % 10 = 2   n = 1
         1 % 10 = 1   n = 0     digits 4 3 2 1

    rebuild rev = rev*10 + d  →  4321
    Roman: walk [(1000,M),(900,CM),…] subtract largest that fits`,

  'array-hash-random':
`  Swap-with-last keeps the array gap-free → O(1) everywhere:

    vals = [a, b, c, d]      idx = {a:0, b:1, c:2, d:3}
    remove b (idx 1):
      move last d into slot 1, pop:
    vals = [a, d, c]         idx = {a:0, d:1, c:2}
    getRandom = vals[rand(len)]`,

  'multi-stream-iterator':
`  Queue of live cursors, round-robin:

    streams: A=[1,2]  B=[3,4,5]
    q = [A,B]
    next→A(1) requeue → q=[B,A]
    next→B(3) requeue → q=[A,B]
    next→A(2) done    → q=[B]
    next→B(4) … 1 3 2 4 5`,

  'grid-simulate':
`  Encode next state in spare bit, read OLD, then shift:

    cell = old | (next << 1)     # bit0 = now, bit1 = next
    pass 1: compute next from (neighbour & 1)  → set bit1
    pass 2: cell >>= 1            # drop old, keep next
    O(1) extra space — no second grid`,

  'board-validate':
`  Validate by INVARIANTS, not by replay:

    tic-tac-toe: countX ∈ {countO, countO+1}
                 if X wins → countX == countO+1
                 if O wins → countX == countO
    ray scan (Reversi): from cell, walk one of 8 dirs:
       me · opp opp opp me   → flips legal ✓`,

  'tiered-scan':
`  Only the slice inside each band gets that band's rate:

    income 70k, brackets [(0-30:10%),(30-60:20%),(60+:30%)]
      band1: 30k × .10
      band2: 30k × .20
      band3: 10k × .30   ← remaining
    sum = tax`,
}

const pseudo = {
  'floyd-warshall':
`for k in range(n):              # intermediate — OUTER loop
    for i in range(n):
        for j in range(n):
            if dist[i][k] + dist[k][j] < dist[i][j]:
                dist[i][j] = dist[i][k] + dist[k][j]`,

  'digit-number-construct':
`# reverse / digit-sum
rev = 0
while n > 0:
    d = n % 10
    rev = rev * 10 + d
    n //= 10
# Roman build
for value, sym in [(1000,'M'),(900,'CM'),(500,'D'),...]:
    while num >= value:
        out += sym; num -= value`,

  'array-hash-random':
`insert(x): if x in idx: return False
           idx[x] = len(vals); vals.append(x); return True
remove(x): if x not in idx: return False
           i, last = idx[x], vals[-1]
           vals[i] = last; idx[last] = i
           vals.pop(); del idx[x]; return True
getRandom(): return vals[randint(0, len(vals)-1)]`,

  'thread-ordering':
`# first -> second -> third, via two gates (sem init 0)
def first():  print('first');  g2.release()
def second(): g2.acquire(); print('second'); g3.release()
def third():  g3.acquire(); print('third')`,

  'thread-alternation':
`# foo/bar take strict turns
fooSem = Semaphore(1); barSem = Semaphore(0)
def foo(): for _ in n: fooSem.acquire(); print('foo'); barSem.release()
def bar(): for _ in n: barSem.acquire(); print('bar'); fooSem.release()`,

  'thread-barrier':
`# 2 H + 1 O before any bond proceeds
def hydrogen(): hSem.acquire(); releaseH(); barrier.wait()
def oxygen():   oSem.acquire(); releaseO(); barrier.wait()
# hSem permits 2, oSem permits 1; barrier of 3 releases the group`,

  'thread-pool-fanout':
`visited = ConcurrentSet([start]); pool = Executor()
def crawl(url):
    for v in getUrls(url):
        if visited.add_if_absent(v):     # ATOMIC check+insert
            pool.submit(crawl, v)
pool.submit(crawl, start); pool.join()`,

  'multi-stream-iterator':
`q = deque(it for it in iterators if it.hasNext())
def next():
    it = q.popleft(); v = it.next()
    if it.hasNext(): q.append(it)
    return v
def hasNext(): return len(q) > 0`,

  'lazy-decode-iterator':
`# compressed "a3b1c2" -> a a a b c c, on demand
def next():
    advance_to_nonzero_run()
    self.count -= 1; return self.ch
def hasNext():
    return self.count > 0 or self.ptr < len(s)`,

  'ordered-aggregate':
`# smallest-infinite-set: boundary + add-back heap/set
addBack(x): if x >= bound and x not in heapset:
               heappush(heap, x); heapset.add(x)
popSmallest():
    if heap and heap[0] < bound:
        x = heappop(heap); heapset.discard(x); return x
    bound += 1; return bound - 1`,

  'observer-pubsub':
`subs = defaultdict(dict); nextId = 0
def subscribe(event, cb):
    id = nextId; subs[event][id] = cb
    return lambda: subs[event].pop(id, None)   # unsubscribe handle
def emit(event, *args):
    for cb in list(subs[event].values()):       # snapshot
        cb(*args)`,

  'grid-simulate':
`for r,c in cells:                  # pass 1: bit1 = next state
    live = count_neighbors(grid, r, c) & 1
    if next_alive(grid[r][c] & 1, live): grid[r][c] |= 2
for r,c in cells: grid[r][c] >>= 1  # pass 2: drop old bit`,

  'board-validate':
`xs, os = count('X'), count('O')
if os not in (xs, xs-1): return False
if wins('X') and xs != os+1: return False
if wins('O') and xs != os:   return False
return True`,

  'line-format':
`# greedy pack then distribute spaces
line = pack_words_that_fit(words)
gaps = len(line) - 1
base, extra = divmod(maxWidth - total_chars, max(gaps,1))
# leftmost 'extra' gaps get one more space; last line left-justified`,

  'tiered-scan':
`tax = 0; prev = 0
for upper, pct in brackets:
    if income <= prev: break
    band = min(income, upper) - prev
    tax += band * pct
    prev = upper
return tax`,
}

const v = JSON.parse(await readFile(VIS, 'utf8')); for (const [k, val] of Object.entries(visuals)) v[k] = val
await writeFile(VIS, JSON.stringify(v, null, 2) + '\n')
const p = JSON.parse(await readFile(PSE, 'utf8')); for (const [k, val] of Object.entries(pseudo)) p[k] = val
await writeFile(PSE, JSON.stringify(p, null, 2) + '\n')
console.log(`visuals +${Object.keys(visuals).length}, pseudo +${Object.keys(pseudo).length}`)
