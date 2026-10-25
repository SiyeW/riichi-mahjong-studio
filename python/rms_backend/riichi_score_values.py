"""Hand-value support shared conceptually with the renderer's scoring filter.

Parity tests bind this small cross-runtime rule to src/riichiScoring.ts. These
are hand values without honba/sticks, not an alternative settlement engine.
"""

from __future__ import annotations

from functools import lru_cache
import math


@lru_cache(maxsize=2)
def _regular_values(dealer):
    values = set()
    basic = [min(2000, fu * (1 << (han + 2)))
             for han in range(1, 5) for fu in (20, 25, *range(30, 111, 10))
             if han != 1 or fu not in (20, 25)] + [2000, 3000, 4000, 6000]
    rounded = lambda value: ((value + 99) // 100) * 100
    for base in basic:
        values.add(rounded(base * (6 if dealer else 4)))
        values.add(rounded(base * 2) * 3 if dealer else rounded(base * 2) + rounded(base) * 2)
    return frozenset(values)


def possible_hand_value(value, dealer):
    if (type(value) not in (int, float) or type(value) is float and not math.isfinite(value)
            or value <= 0 or value != int(value)):
        return False
    yakuman = 48000 if dealer else 32000
    return value in _regular_values(bool(dealer)) or value >= yakuman and value % yakuman == 0
