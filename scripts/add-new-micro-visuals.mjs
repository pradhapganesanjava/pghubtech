import { readFile, writeFile } from 'fs/promises'

const VIS = 'portal/public/patterns-visuals.json'
const PSE = 'portal/public/patterns-pseudo.json'

const visuals = {
  'bijection-map':
`  Two maps must agree BOTH ways:

    pattern = "abba"   words = [dog, cat, cat, dog]
      a→dog   dog→a
      b→cat   cat→b
      b→cat ✓ cat→b ✓
      a→dog ✓ dog→a ✓        → true

    "abba" / [dog, cat, cat, fish]
      a→dog … then a→fish ✗  (a already bound to dog)
                              → false`,

  'minimax-game-dp':
`  dp[i][j] = best SCORE DIFFERENCE the mover can force on a[i..j]

    take an end, opponent then plays optimally (subtract their best):
      dp[i][j] = max( a[i] − dp[i+1][j],     # take left
                      a[j] − dp[i][j-1] )     # take right

    a = [5, 3, 4, 5]
      base: dp[i][i] = a[i]
      grow by length … dp[0][3] > 0  → first player wins`,

  'rejection-sampling':
`  Rand7 × Rand7 → uniform 1..49, keep only 1..40:

    idx = (rand7()-1)*7 + rand7()     # uniform 1..49
        ┌─ 1..40  → (idx-1) % 10 + 1  # ACCEPT → 1..10
    49 ─┤
        └─ 41..49 → throw away        # REJECT → resample

    keep the largest multiple of N (40) so each output is equally likely`,
}

const pseudo = {
  'bijection-map':
`a2b, b2a = {}, {}
for x, y in zip(seq_a, seq_b):
    if a2b.get(x, y) != y or b2a.get(y, x) != x:
        return False           # collides with an earlier binding
    a2b[x] = y; b2a[y] = x
return True`,

  'minimax-game-dp':
`n = len(a)
dp = [[0]*n for _ in range(n)]
for i in range(n):
    dp[i][i] = a[i]
for length in range(2, n+1):
    for i in range(0, n-length+1):
        j = i + length - 1
        dp[i][j] = max(a[i] - dp[i+1][j],   # take left
                       a[j] - dp[i][j-1])    # take right
return dp[0][n-1] >= 0          # first player does not lose`,

  'rejection-sampling':
`while True:
    idx = (rand7() - 1) * 7 + rand7()   # uniform 1..49
    if idx <= 40:                       # 40 = floor(49/10)*10
        return (idx - 1) % 10 + 1       # uniform 1..10
    # idx in 41..49 -> reject, resample (O(1) expected loops)`,
}

for (const [path, add] of [[VIS, visuals], [PSE, pseudo]]) {
  const j = JSON.parse(await readFile(path, 'utf8'))
  for (const [k, v] of Object.entries(add)) j[k] = v
  await writeFile(path, JSON.stringify(j, null, 2) + '\n')
  console.log(`Updated ${path}: +${Object.keys(add).length} keys (now ${Object.keys(j).filter(k => k !== '_meta').length} micros)`)
}
