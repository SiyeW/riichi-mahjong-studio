"""Validate opponent-analysis protocol results and adapt them for the host."""

from __future__ import annotations

import copy
import math
from typing import Any

import numpy as np

TILE34_NAMES = [
    *(f"{number}m" for number in range(1, 10)),
    *(f"{number}p" for number in range(1, 10)),
    *(f"{number}s" for number in range(1, 10)),
    "E",
    "S",
    "W",
    "N",
    "P",
    "F",
    "C",
]

_PROBABILITY_TOLERANCE = 1e-4
_SHANTEN_OUTPUT_ID = "opponent-shanten"
_DEAL_IN_OUTPUT_ID = "opponent-deal-in-probability"


class OpponentPredictionProtocolAdapter:
    """Own the protocol boundary between engine results and host view data."""

    @staticmethod
    def _validate_probability(value: Any, field: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise RuntimeError(f"{field} must be a number")
        result = float(value)
        if not math.isfinite(result):
            raise RuntimeError(f"{field} must be a finite probability")
        if (
            result < -_PROBABILITY_TOLERANCE
            or result > 1.0 + _PROBABILITY_TOLERANCE
        ):
            raise RuntimeError(f"{field} must be between zero and one")
        # Engines commonly reconstruct a probability from float32 components.
        # Absorb harmless boundary drift while still rejecting genuine bad data.
        return min(1.0, max(0.0, result))

    def validate_prediction(
        self,
        result: dict[str, Any],
        *,
        controlled_seat: int,
        enabled_outputs: tuple[str, ...],
        output_references: dict[str, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        outputs = result.get("outputs")
        if not isinstance(outputs, list) or len(outputs) != len(enabled_outputs):
            raise RuntimeError(
                "opponent prediction response has an unexpected output count"
            )
        by_output = {
            str(output.get("id") or ""): output.get("data")
            for output in outputs
            if isinstance(output, dict)
            and isinstance(output.get("data"), dict)
            and output.get("version")
            == output_references.get(str(output.get("id") or ""), {}).get("version")
            and ("version" in output)
            == (
                "version"
                in output_references.get(str(output.get("id") or ""), {})
            )
        }
        expected_outputs = set(enabled_outputs)
        if set(by_output) != expected_outputs:
            raise RuntimeError(
                "opponent prediction response has missing or unexpected outputs"
            )
        shanten_data = by_output.get(_SHANTEN_OUTPUT_ID)
        deal_in_data = by_output.get(_DEAL_IN_OUTPUT_ID)
        if (_SHANTEN_OUTPUT_ID in expected_outputs) != isinstance(shanten_data, dict):
            raise RuntimeError("opponent-shanten response is missing or unexpected")
        if (_DEAL_IN_OUTPUT_ID in expected_outputs) != isinstance(deal_in_data, dict):
            raise RuntimeError(
                "opponent-deal-in-probability response is missing or unexpected"
            )
        expected_seats = {seat for seat in range(4) if seat != controlled_seat}
        validated = {seat: {"seat": seat} for seat in expected_seats}

        shanten_players = (
            shanten_data.get("players") if isinstance(shanten_data, dict) else None
        )
        if shanten_players is not None:
            self._validate_shanten_players(
                shanten_players,
                expected_seats,
                validated,
            )

        deal_in_players = (
            deal_in_data.get("players") if isinstance(deal_in_data, dict) else None
        )
        if deal_in_players is not None:
            self._validate_deal_in_players(
                deal_in_players,
                expected_seats,
                validated,
            )
        return [validated[seat] for seat in sorted(validated)]

    def _validate_shanten_players(
        self,
        players: Any,
        expected_seats: set[int],
        validated: dict[int, dict[str, Any]],
    ) -> None:
        if not isinstance(players, list) or len(players) != 3:
            raise RuntimeError("opponent-shanten must contain exactly three players")
        actual_seats: set[int] = set()
        for player in players:
            if not isinstance(player, dict):
                raise RuntimeError("opponent-shanten player must be an object")
            seat = int(player.get("seat", -1))
            if seat not in expected_seats or seat in actual_seats:
                raise RuntimeError("opponent-shanten player seats are invalid")
            actual_seats.add(seat)
            shanten = player.get("shanten")
            if not isinstance(shanten, list) or len(shanten) != 7:
                raise RuntimeError("opponent-shanten must contain values 0 through 6")
            by_value: dict[int, float] = {}
            for entry in shanten:
                if not isinstance(entry, dict):
                    raise RuntimeError("opponent-shanten entry must be an object")
                value = int(entry.get("value", -1))
                if value not in range(7) or value in by_value:
                    raise RuntimeError("opponent-shanten values are invalid")
                by_value[value] = self._validate_probability(
                    entry.get("probability"),
                    f"players[{seat}].shanten[{value}]",
                )
            if set(by_value) != set(range(7)):
                raise RuntimeError("opponent-shanten values are incomplete")
            if abs(sum(by_value.values()) - 1.0) > _PROBABILITY_TOLERANCE:
                raise RuntimeError(
                    "opponent-shanten probabilities do not sum to one"
                )
            validated[seat].update(
                {
                    "shanten": [by_value[value] for value in range(7)],
                    "furiten": self._validate_probability(
                        player.get("furitenOrNoYaku"),
                        f"players[{seat}].furitenOrNoYaku",
                    ),
                }
            )
        if actual_seats != expected_seats:
            raise RuntimeError("opponent-shanten response is missing a player")

    def _validate_deal_in_players(
        self,
        players: Any,
        expected_seats: set[int],
        validated: dict[int, dict[str, Any]],
    ) -> None:
        if not isinstance(players, list) or len(players) != 3:
            raise RuntimeError(
                "opponent-deal-in-probability must contain exactly three players"
            )
        actual_seats: set[int] = set()
        for player in players:
            if not isinstance(player, dict):
                raise RuntimeError(
                    "opponent-deal-in-probability player must be an object"
                )
            seat = int(player.get("seat", -1))
            if seat not in expected_seats or seat in actual_seats:
                raise RuntimeError(
                    "opponent-deal-in-probability player seats are invalid"
                )
            actual_seats.add(seat)
            waits = player.get("tiles")
            if not isinstance(waits, dict) or set(waits) != set(TILE34_NAMES):
                raise RuntimeError(
                    "opponent-deal-in-probability must cover all 34 tiles"
                )
            validated[seat]["ronWaits"] = {
                tile: self._validate_probability(
                    waits[tile],
                    f"players[{seat}].tiles.{tile}",
                )
                for tile in TILE34_NAMES
            }
        if actual_seats != expected_seats:
            raise RuntimeError(
                "opponent-deal-in-probability response is missing a player"
            )

    @staticmethod
    def to_host_result(
        players: list[dict[str, Any]],
        *,
        protocol_outputs: dict[str, Any],
        controlled_seat: int,
        context: dict[str, Any],
        engine_fingerprint: str,
        target_events: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        del target_events
        by_seat = {int(player["seat"]): player for player in players}
        opponents: dict[str, list[float]] = {}
        waits: dict[str, list[float]] = {}
        raw: dict[str, Any] = {}
        for offset, label in enumerate(
            ("shimocha", "toimen", "kamicha"),
            start=1,
        ):
            seat = (controlled_seat + offset) % 4
            player = by_seat[seat]
            raw[label] = {"seat": seat}
            if "shanten" in player:
                shanten = list(player["shanten"])
                furiten = float(player["furiten"])
                display = np.zeros(8, dtype=np.float32)
                display[0] = shanten[0] * (1.0 - furiten)
                display[1:7] = shanten[1:7]
                display[7] = shanten[0] * furiten
                opponents[label] = [float(value) for value in display]
                raw[label].update(
                    {
                        "shanten_probs": shanten,
                        "furiten_prob": furiten,
                    }
                )
            if "ronWaits" in player:
                raw_waits = [
                    float(player["ronWaits"][tile]) for tile in TILE34_NAMES
                ]
                waits[label] = raw_waits
                raw[label]["ron_wait"] = raw_waits

        # Ground truth is deliberately host-independent in the public build.
        return {
            "predictions": {"opponents": opponents, "ron_wait": waits},
            "ground_truth": {"opponents": {}, "ron_wait": {}},
            "raw": raw,
            "outputs": copy.deepcopy(protocol_outputs),
            "context": copy.deepcopy(context),
            "status": "ready",
            "engineFingerprint": engine_fingerprint,
        }
