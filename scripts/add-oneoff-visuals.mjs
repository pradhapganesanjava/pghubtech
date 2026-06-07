import { readFile, writeFile } from 'fs/promises'
const VIS = 'portal/public/patterns-visuals.json'
const PSE = 'portal/public/patterns-pseudo.json'

const visuals = {
  'vertical-char-scan':
`  Scan column by column, stop at first mismatch:

    flower
    flow      ← shortest bounds the prefix
    flight
    col: f l o…  → "fl" then i≠o ✗  →  "fl"`,

  'custom-order-compare':
`  Rank by the GIVEN order, then compare:

    order = "hlabcdefgijk..."   rank: h<l<a<b…
    "apple" vs "app":  a=a p=p p=p, then "app" ends
        shorter-but-not-prefix-first?  prefix ok → sorted
    "hello" vs "leetcode": h(0) vs l(1) → h first ✓`,

  'round-robin-elim':
`  Two index-queues; smaller index acts, re-enqueues at +n:

    R: [0, 3, 5]   D: [1, 2, 4]      n=6
    front 0(R) vs 1(D): 0<1 → 0 bans 1, R re-adds 0+6
    R:[3,5,6]  D:[2,4]
    … faction whose queue empties first loses`,

  'bit-reverse':
`  Pull low bit off n, push onto result:

    n = ...1011 (LSB first)        result builds MSB-first
    res=(res<<1)|(n&1); n>>=1
    step: res  1 → 11 → 110 → 1101 …
    after 32 steps: bits fully reversed`,

  'combinatorial-rank':
`  Skip whole blocks by counting completions:

    k-th permutation of [1,2,3,4], k=9 (0-indexed)
    pos0: (3!)=6 each →  9//6=1 → pick 2; k=9-6=3
    pos1: (2!)=2 each →  3//2=1 → pick 3; k=3-2=1
    pos2: (1!)=1 each →  1//1=1 → pick 4; k=0 → 1
    → 2 3 4 1`,

  'contribution-sign-cases':
`  Expand |·| into ± cases; each case is linear:

    maximize |a[i]-a[j]| + |i-j|  over i<j
    drop |..|: ±(a[i]-a[j]) ± (i-j)  → 4 sign cases
    each case = max(f(i)) - min(f(j)) in one pass
    answer = best over the 4 cases`,

  'interactive-bsearch':
`  Oracle says which HALF holds the answer:

    [ . . . . . . . . ]   ask compare(left, right)
       L----m   m+1--R    → bigger side keeps the max
    recurse into that half  →  O(log n) queries`,

  'interactive-deduce':
`  Query others against a reference, group by relation:

    ref = a[0]
    for i: query(0, i) → same | diff
       same → group A,  diff → group B
    majority = larger group (+ a couple ref-flip checks)`,

  'fenwick-bit':
`  lowbit jumps: update climbs, query descends:

    update(i): i += i & -i   →  i, i+lowbit, …
    query(i):  s += t[i]; i -= i & -i  →  i, i-lowbit, …
    idx 6=110 → query visits 6, 4 ; update visits 6, 8`,

  'segment-tree':
`        [0..7] sum/min
        /            \\
   [0..3]            [4..7]
   /    \\           /    \\
 [0..1][2..3]    [4..5][6..7]
  query/update touch O(log n) covered nodes; lazy tag
  pushes range updates down on demand`,
}

const pseudo = {
  'vertical-char-scan':
`for i in range(len(strs[0])):
    c = strs[0][i]
    for s in strs[1:]:
        if i == len(s) or s[i] != c:
            return strs[0][:i]
return strs[0]`,

  'custom-order-compare':
`rank = {ch: i for i, ch in enumerate(order)}
def le(a, b):
    for x, y in zip(a, b):
        if x != y: return rank[x] < rank[y]
    return len(a) <= len(b)        # prefix must come first
return all(le(words[i], words[i+1]) for i in range(len(words)-1))`,

  'round-robin-elim':
`R = deque(i for i,c in enumerate(s) if c=='R')
D = deque(i for i,c in enumerate(s) if c=='D')
while R and D:
    r, d = R.popleft(), D.popleft()
    if r < d: R.append(r + n)      # r acts, bans d
    else:     D.append(d + n)
return 'Radiant' if R else 'Dire'`,

  'bit-reverse':
`res = 0
for _ in range(32):
    res = (res << 1) | (n & 1)
    n >>= 1
return res`,

  'combinatorial-rank':
`# k-th permutation (0-indexed) of nums
res = []; k = k
for pos in range(len(nums), 0, -1):
    f = factorial(pos - 1)
    i, k = divmod(k, f)
    res.append(nums.pop(i))
return res`,

  'contribution-sign-cases':
`best = -inf
for s1 in (+1, -1):
    for s2 in (+1, -1):
        hi, lo = -inf, inf
        for i, x in enumerate(arr):
            f = s1 * x + s2 * i
            best = max(best, f - lo)
            hi, lo = max(hi, f), min(lo, f)
return best`,

  'interactive-bsearch':
`lo, hi = 0, n - 1
while lo < hi:
    mid = (lo + hi) // 2
    if oracle_left_bigger(lo, mid, hi):   # API call
        hi = mid
    else:
        lo = mid + 1
return lo`,

  'interactive-deduce':
`ref = 0; same = [0]; diff = []
for i in range(1, n):
    (same if reader.query(ref, i) else diff).append(i)
# compare |same| vs |diff| (+ extra ref-flip checks) for majority
return ref if len(same) > len(diff) else (diff[0] if diff else -1)`,

  'fenwick-bit':
`def update(i, delta):
    i += 1
    while i <= n: tree[i] += delta; i += i & -i
def query(i):                  # prefix sum [0..i]
    i += 1; s = 0
    while i > 0: s += tree[i]; i -= i & -i
    return s`,

  'segment-tree':
`def update(node, l, r, i, val):
    if l == r: seg[node] = val; return
    m = (l + r) // 2
    if i <= m: update(2*node, l, m, i, val)
    else:      update(2*node+1, m+1, r, i, val)
    seg[node] = combine(seg[2*node], seg[2*node+1])
def query(node, l, r, ql, qr):
    if qr < l or r < ql: return IDENTITY
    if ql <= l and r <= qr: return seg[node]
    m = (l + r) // 2
    return combine(query(2*node,l,m,ql,qr), query(2*node+1,m+1,r,ql,qr))`,
}

const v = JSON.parse(await readFile(VIS, 'utf8')); for (const [k, val] of Object.entries(visuals)) v[k] = val
await writeFile(VIS, JSON.stringify(v, null, 2) + '\n')
const p = JSON.parse(await readFile(PSE, 'utf8')); for (const [k, val] of Object.entries(pseudo)) p[k] = val
await writeFile(PSE, JSON.stringify(p, null, 2) + '\n')
console.log(`visuals +${Object.keys(visuals).length}, pseudo +${Object.keys(pseudo).length}`)
