import unittest

from item import Item
from packer import Packer
from warehouse import Warehouse


def get_large_items() -> list[Item]:
    items = []
    for i in range(30):
        w = (i % 5) + 3
        s = 4 if i < 15 else 6
        items.append(Item(f"item-{i:03d}", w, s))
    return items


class TestPacker(unittest.TestCase):
    def test_large_catalog(self) -> None:
        warehouse = Warehouse(weight_limit=15, size_limit=10)
        packer = Packer(warehouse)
        items = get_large_items()
        packer.pack(items)
        self.assertLess(
            warehouse.total_bins(),
            18,
            f"used {warehouse.total_bins()} bins, expected fewer than 18",
        )
        self.assertEqual(warehouse.total_items(), 30)


if __name__ == "__main__":
    unittest.main()
