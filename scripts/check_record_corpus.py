from __future__ import annotations

import argparse
import copy
import gzip
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT_DIR = PROJECT_ROOT / "python" / "environment"
if str(ENVIRONMENT_DIR) not in sys.path:
    sys.path.insert(0, str(ENVIRONMENT_DIR))

import service  # noqa: E402
from service_helpers import (  # noqa: E402
    DORA_INDICATOR_POSITIONS,
    RINSHAN_DRAW_POSITIONS,
    URA_INDICATOR_POSITIONS,
)


KNOWN_TILES = {
    *(f"{number}{suit}" for suit in ("m", "p", "s") for number in range(1, 10)),
    "5mr",
    "5pr",
    "5sr",
    "E",
    "S",
    "W",
    "N",
    "P",
    "F",
    "C",
}


def read_record(path: Path) -> dict[str, Any]:
    payload = path.read_bytes()
    if payload.startswith(b"\x1f\x8b"):
        payload = gzip.decompress(payload)
    record = json.loads(payload.decode("utf-8-sig"))
    if not isinstance(record, dict):
        raise ValueError("record root is not an object")
    return record


def validate_full_wall(wall: Any, context: str) -> None:
    if not isinstance(wall, (list, tuple)) or len(wall) != 136:
        raise ValueError(f"{context}: fullWall must contain 136 tiles")
    unknown = [tile for tile in wall if tile not in KNOWN_TILES]
    if unknown:
        raise ValueError(f"{context}: wall contains an unknown tile")
    counts = Counter(tile.replace("r", "") for tile in wall)
    if any(count != 4 for count in counts.values()) or len(counts) != 34:
        raise ValueError(f"{context}: fullWall tile multiplicities are invalid")


def validate_snapshot_wall(snapshot: dict[str, Any], context: str) -> bool:
    full_wall = snapshot.get("fullWall")
    if not full_wall:
        return False
    validate_full_wall(full_wall, context)

    live_wall = snapshot.get("wall")
    if live_wall and tuple(live_wall) != tuple(full_wall[: len(live_wall)]):
        raise ValueError(f"{context}: live wall is inconsistent with fullWall")

    rinshan = snapshot.get("rinshanWall")
    expected_rinshan = tuple(full_wall[index] for index in RINSHAN_DRAW_POSITIONS)
    if rinshan and tuple(rinshan) != expected_rinshan[-len(rinshan) :]:
        raise ValueError(f"{context}: rinshanWall is inconsistent with fullWall")

    for key, positions in (
        ("doraIndicatorStack", DORA_INDICATOR_POSITIONS),
        ("uraIndicatorStack", URA_INDICATOR_POSITIONS),
    ):
        section = snapshot.get(key)
        if section and tuple(section) != tuple(full_wall[index] for index in positions):
            raise ValueError(f"{context}: {key} is inconsistent with fullWall")
    return True


def validate_loaded_record(record: dict[str, Any]) -> tuple[int, int, int]:
    if int(record.get("formatVersion") or 0) != 2:
        raise ValueError("only formatVersion 2 is part of this regression corpus")

    service.load_game_record(copy.deepcopy(record))
    game = service.STATE.get("game")
    if not isinstance(game, dict):
        raise ValueError("loader did not produce a game")
    nodes = game.get("nodes")
    if not isinstance(nodes, dict) or not nodes:
        raise ValueError("loaded game has no nodes")
    if game.get("rootNodeId") not in nodes:
        raise ValueError("root node is missing")
    if game.get("currentNodeId") not in nodes:
        raise ValueError("current node is missing")

    controlled_seat = int(service.STATE.get("controlledSeat", 0))
    wall_count = 0
    legal_action_nodes = 0
    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            raise ValueError(f"node {node_id}: node is not an object")
        snapshot = node.get("snapshot")
        if not isinstance(snapshot, dict):
            raise ValueError(f"node {node_id}: snapshot is missing")
        service.build_table_view(snapshot)
        service.build_result_info(snapshot)

        if validate_snapshot_wall(snapshot, f"node {node_id}"):
            wall_count += 1

        phase = str(snapshot.get("phase") or "")
        if phase in ("discard", "reaction_window", "kan_reaction_window"):
            service.build_legal_actions(snapshot, controlled_seat)
            legal_action_nodes += 1

    service.build_tree_view(game, str(game["currentNodeId"]))
    current_snapshot = nodes[game["currentNodeId"]]["snapshot"]
    service.build_match_summary(game, current_snapshot)

    exported = service.serialize_game_record()
    original_count = len(nodes)
    service.load_game_record(exported)
    reloaded_nodes = service.STATE["game"].get("nodes") or {}
    if len(reloaded_nodes) != original_count:
        raise ValueError("serialize/reload changed the node count")
    return original_count, wall_count, legal_action_nodes


def parse_since(value: str) -> float:
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError as exc:
        raise argparse.ArgumentTypeError("use an ISO date such as 2026-07-25") from exc


def select_records(root: Path, since: float | None, limit: int) -> list[Path]:
    candidates = sorted(root.rglob("*.mjtrain"), key=lambda path: path.stat().st_mtime, reverse=True)
    if since is not None:
        candidates = [path for path in candidates if path.stat().st_mtime >= since]
    return candidates[:limit] if limit > 0 else candidates


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Load and validate an external local corpus of recent .mjtrain records."
    )
    parser.add_argument("records", type=Path, help="External records directory; files are never modified.")
    parser.add_argument("--since", type=parse_since, help="Only records modified on or after this ISO date.")
    parser.add_argument("--limit", type=int, default=20, help="Maximum records to check; 0 checks all.")
    args = parser.parse_args()

    root = args.records.resolve()
    if not root.is_dir():
        raise SystemExit(f"Record directory does not exist: {root}")

    # Loading a read-only record normally requests optional opponent analysis.
    # Corpus checks exercise host behavior only and never contact an engine.
    service.request_current_shanten_prediction = lambda: None

    selected = select_records(root, args.since, args.limit)
    if not selected:
        raise SystemExit("No matching .mjtrain records were found.")

    failures: list[tuple[Path, str]] = []
    total_nodes = 0
    total_walls = 0
    total_legal_nodes = 0
    for path in selected:
        try:
            record = read_record(path)
            nodes, walls, legal_nodes = validate_loaded_record(record)
            total_nodes += nodes
            total_walls += walls
            total_legal_nodes += legal_nodes
            print(f"OK {path.name}: nodes={nodes} walls={walls} legal_nodes={legal_nodes}")
        except Exception as exc:  # report the complete corpus instead of stopping at the first record
            failures.append((path, str(exc)))
            print(f"FAIL {path.name}: {exc}")

    print(
        "CORPUS_SUMMARY "
        f"records={len(selected)} failures={len(failures)} nodes={total_nodes} "
        f"walls={total_walls} legal_nodes={total_legal_nodes}"
    )
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
