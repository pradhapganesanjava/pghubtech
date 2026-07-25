from typing import Dict, List, Tuple

from item import Item
from warehouse import Warehouse


class Packer:
    """Packs items into warehouse bins, minimizing bins used."""

    def __init__(self, warehouse: Warehouse):
        self.warehouse = warehouse

    def pack(self, items: List[Item]) -> Dict[str, int]:
        remaining = list(items)
        assignment: Dict[str, int] = {}

        while remaining:
            chosen = self._select_max_items_for_bin(remaining)
            new_bin = self.warehouse.create_bin()
            for item in chosen:
                new_bin.add_item(item)
                assignment[item.name] = new_bin.bin_id
            remaining = [item for item in remaining if item.name not in assignment]

        return assignment

    def _select_max_items_for_bin(self, items: List[Item]) -> List[Item]:
        """2D 0/1 knapsack: maximize item count within one bin's limits."""
        weight_limit = self.warehouse._weight_limit
        size_limit = self.warehouse._size_limit
        n = len(items)

        # dp[w][s] = max number of items achievable with total weight w and size s
        dp: List[List[int]] = [
            [0] * (size_limit + 1) for _ in range(weight_limit + 1)
        ]
        # choice[i][w][s] = True if item i-1 was taken to reach dp[w][s]
        choice: List[List[List[bool]]] = [
            [[False] * (size_limit + 1) for _ in range(weight_limit + 1)]
            for _ in range(n + 1)
        ]

        for i in range(1, n + 1):
            item = items[i - 1]
            for w in range(weight_limit, item.weight - 1, -1):
                for s in range(size_limit, item.size - 1, -1):
                    prev_w, prev_s = w - item.weight, s - item.size
                    candidate = dp[prev_w][prev_s] + 1
                    if candidate > dp[w][s]:
                        dp[w][s] = candidate
                        choice[i][w][s] = True

        best_w, best_s = self._best_capacity(dp, weight_limit, size_limit)
        return self._reconstruct(items, choice, best_w, best_s)

    def _best_capacity(
        self, dp: List[List[int]], weight_limit: int, size_limit: int
    ) -> Tuple[int, int]:
        best_count = -1
        best_w, best_s = 0, 0
        for w in range(weight_limit + 1):
            for s in range(size_limit + 1):
                if dp[w][s] > best_count:
                    best_count = dp[w][s]
                    best_w, best_s = w, s
        return best_w, best_s

    def _reconstruct(
        self,
        items: List[Item],
        choice: List[List[List[bool]]],
        w: int,
        s: int,
    ) -> List[Item]:
        selected: List[Item] = []
        i = len(items)
        while i > 0 and w >= 0 and s >= 0:
            if choice[i][w][s]:
                item = items[i - 1]
                selected.append(item)
                w -= item.weight
                s -= item.size
            i -= 1
        return selected
