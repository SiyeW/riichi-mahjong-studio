"""Cached MJAI streams with incremental hashes for adjacent game-tree nodes."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from mjai_stream import build_mjai_events_from_actions, build_mjai_stream


HASH_MASK = (1 << 64) - 1
HASH_MULTIPLIER = 1_000_003


class MjaiStreamCache:
    """Own MJAI stream entries and their bounded least-recently-used lifetime."""

    def __init__(
        self,
        sync_snapshot: Callable[[dict[str, Any]], None],
        *,
        max_entries: int = 64,
    ) -> None:
        self._sync_snapshot = sync_snapshot
        self._max_entries = max_entries
        self._entries: dict[tuple[Any, ...], dict[str, Any]] = {}

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)

    def purge_game(self, game_id: Any) -> None:
        stale_keys = [
            key for key in self._entries if key and key[0] == game_id
        ]
        for key in stale_keys:
            self._entries.pop(key, None)

    def get_bundle(
        self,
        game: dict[str, Any],
        node_id: str,
        seat: int,
        *,
        reveal_all: bool = False,
    ) -> dict[str, Any]:
        node = game["nodes"][node_id]
        snapshot = node["snapshot"]
        self._sync_snapshot(snapshot)
        meta = self._snapshot_meta(snapshot)
        cache_key = self._cache_key(game, node_id, seat, reveal_all)
        cached = self._entries.get(cache_key)
        if cached and cached.get("meta") == meta:
            self._entries.pop(cache_key, None)
            self._entries[cache_key] = cached
            return cached

        parent_id = node.get("parentId")
        if parent_id:
            parent_node = game["nodes"][parent_id]
            parent_snapshot = parent_node["snapshot"]
            self._sync_snapshot(parent_snapshot)
            if self._same_round(parent_snapshot, snapshot):
                parent_entry = self.get_bundle(
                    game,
                    parent_id,
                    seat,
                    reveal_all=reveal_all,
                )
                parent_actions = parent_snapshot.get("actionHistory", []) or []
                child_actions = snapshot.get("actionHistory", []) or []
                parent_len = len(parent_actions)
                if (
                    len(child_actions) >= parent_len
                    and child_actions[:parent_len] == parent_actions
                ):
                    suffix_events = build_mjai_events_from_actions(
                        child_actions[parent_len:],
                        seat,
                        reveal_all=reveal_all,
                    )
                    events = parent_entry["events"] + suffix_events
                    prefix_hashes = self._extend_prefix_hashes(
                        parent_entry.get("prefixHashes"),
                        suffix_events,
                    )
                    entry = self._build_entry(events, meta, prefix_hashes)
                    self._store(cache_key, entry)
                    return entry

        events = build_mjai_stream(snapshot, seat, reveal_all=reveal_all)
        entry = self._build_entry(events, meta)
        self._store(cache_key, entry)
        return entry

    def build_uncached_bundle(
        self,
        snapshot: dict[str, Any],
        seat: int,
        *,
        reveal_all: bool = False,
    ) -> dict[str, Any]:
        """Build a stream bundle without assigning it a game-tree cache key."""
        events = build_mjai_stream(snapshot, seat, reveal_all=reveal_all)
        return self._build_entry(events, self._snapshot_meta(snapshot))

    @staticmethod
    def _snapshot_meta(snapshot: dict[str, Any]) -> dict[str, Any]:
        action_history = snapshot.get("actionHistory", []) or []
        last_action = action_history[-1] if action_history else {}
        return {
            "roundIndex": int(snapshot.get("roundIndex", 0)),
            "honba": int(snapshot.get("honba", 0)),
            "phase": snapshot.get("phase"),
            "actionCount": len(action_history),
            "lastActionType": last_action.get("type"),
            "lastActionActor": last_action.get("actor"),
            "lastActionPai": last_action.get("pai"),
            "startKyotaku": int(
                snapshot.get("startKyotaku", snapshot.get("kyotaku", 0))
            ),
            "startScores": tuple(
                snapshot.get(
                    "startScores",
                    snapshot.get("scores", [25000, 25000, 25000, 25000]),
                )
            ),
        }

    @staticmethod
    def _cache_key(
        game: dict[str, Any],
        node_id: str,
        seat: int,
        reveal_all: bool,
    ) -> tuple[Any, ...]:
        return (game.get("gameId"), node_id, int(seat), bool(reveal_all))

    @staticmethod
    def _same_round(
        parent_snapshot: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> bool:
        return (
            int(parent_snapshot.get("roundIndex", -1))
            == int(snapshot.get("roundIndex", -2))
            and int(parent_snapshot.get("honba", -1))
            == int(snapshot.get("honba", -2))
        )

    @staticmethod
    def _event_hash(event: dict[str, Any]) -> int:
        serialized = json.dumps(event, sort_keys=True, ensure_ascii=False)
        return hash(serialized) & HASH_MASK

    @classmethod
    def _next_hash(cls, current_hash: int, event: dict[str, Any]) -> int:
        return (
            (current_hash * HASH_MULTIPLIER) ^ cls._event_hash(event)
        ) & HASH_MASK

    @classmethod
    def _build_prefix_hashes(
        cls,
        events: list[dict[str, Any]],
    ) -> list[int]:
        prefix_hashes = [0]
        current_hash = 0
        for event in events:
            current_hash = cls._next_hash(current_hash, event)
            prefix_hashes.append(current_hash)
        return prefix_hashes

    @classmethod
    def _extend_prefix_hashes(
        cls,
        parent_prefix_hashes: list[int] | None,
        suffix_events: list[dict[str, Any]],
    ) -> list[int]:
        prefix_hashes = list(parent_prefix_hashes or [0])
        current_hash = prefix_hashes[-1] if prefix_hashes else 0
        if not prefix_hashes:
            prefix_hashes.append(0)
        for event in suffix_events:
            current_hash = cls._next_hash(current_hash, event)
            prefix_hashes.append(current_hash)
        return prefix_hashes

    @classmethod
    def _build_entry(
        cls,
        events: list[dict[str, Any]],
        meta: dict[str, Any],
        prefix_hashes: list[int] | None = None,
    ) -> dict[str, Any]:
        hashes = (
            prefix_hashes
            if prefix_hashes is not None
            else cls._build_prefix_hashes(events)
        )
        return {
            "meta": meta,
            "events": events,
            "eventHash": hashes[-1] if hashes else 0,
            "prefixHashes": hashes,
        }

    def _store(
        self,
        cache_key: tuple[Any, ...],
        entry: dict[str, Any],
    ) -> None:
        self._entries[cache_key] = entry
        while len(self._entries) > self._max_entries:
            oldest_key = next(iter(self._entries))
            self._entries.pop(oldest_key, None)
