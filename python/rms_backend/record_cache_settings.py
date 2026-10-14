"""One shared cache preference policy for main, renderer and frozen backend."""

import json
from pathlib import Path
import sys

_root = Path(sys._MEIPASS) if getattr(sys, 'frozen', False) else Path(__file__).resolve().parents[2]
POLICY = json.loads((_root / 'electron' / 'record-cache-policy.json').read_text(encoding='utf-8'))


def cache_budget_bytes(value):
    valid = (type(value) in (int, float) and POLICY['minimumMiB'] <= value <= POLICY['maximumMiB']
             and value == int(value))
    mib = int(value) if valid else POLICY['defaultMiB']
    return mib * 1024 * 1024
