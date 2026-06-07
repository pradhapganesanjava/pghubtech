import { readFile, writeFile } from 'fs/promises'

const VIS = 'portal/public/patterns-visuals.json'
const PSE = 'portal/public/patterns-pseudo.json'

const visual = `  611 Valid Triangle — fix the LONGEST side c, batch-count pairs:
  (triangle ⇔ a + b > c, and with a ≤ b ≤ c only this one check matters)

    sorted = [2, 3, 4, 6, 7]          c = nums[k], k scans from the right

    k=4  c=7
      i           j                   nums[i]+nums[j]
     [2, 3, 4, 6, 7]                   2 + 6 = 8 > 7  ✓
      i        j                       → i..j-1 ALL pair with j:
                                          count += j - i  = 3
                                       → j--          (shrink to smaller b)
      i     j
     [2, 3, 4, 6, 7]                   2 + 4 = 6 > 7  ✗  → i++  (need bigger a)
         i  j
     [2, 3, 4, 6, 7]                   3 + 4 = 7 > 7  ✗  → i++  → i==j, stop
                                       k=4 subtotal = 3

    then k=3 (c=6), k=2 (c=4) … accumulate the same way

  KEY: on a ✓ you count a whole BATCH (j-i) and move j; on ✗ you move i.
       Each pivot k is one O(n) sweep, never re-checking counted pairs.`

const pseudo = `nums.sort()
count = 0
for k in range(len(nums) - 1, 1, -1):     # c = nums[k] = longest side
    i, j = 0, k - 1
    while i < j:
        if nums[i] + nums[j] > nums[k]:    # a + b > c  → triangle
            count += j - i                 # (i..j-1, j) all valid at once
            j -= 1                         # try a smaller second side b
        else:
            i += 1                         # need a larger first side a
return count`

const v = JSON.parse(await readFile(VIS, 'utf8')); v['tp-count-pairs'] = visual
await writeFile(VIS, JSON.stringify(v, null, 2) + '\n')
const p = JSON.parse(await readFile(PSE, 'utf8')); p['tp-count-pairs'] = pseudo
await writeFile(PSE, JSON.stringify(p, null, 2) + '\n')
console.log('Added tp-count-pairs visual + pseudo.')
