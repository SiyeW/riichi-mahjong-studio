from __future__ import annotations

import copy
import json
import unittest
from urllib.parse import quote

from custom_tenhou import (
    _parse_meld,
    build_custom_tenhou_game,
    decode_custom_tenhou_log,
    export_custom_tenhou,
    normalize_custom_tenhou_input,
)


def wall_codes():
    values = []
    for suit in (1, 2, 3):
        for rank in range(1, 10):
            values.extend([suit * 10 + rank] * 4)
    for honor in range(41, 48):
        values.extend([honor] * 4)
    for normal, red in ((15, 51), (25, 52), (35, 53)):
        values[values.index(normal)] = red
    return values


def make_round(round_index=2, honba=0, kyotaku=1):
    wall = wall_codes()
    hands = [wall[seat * 13:(seat + 1) * 13] for seat in range(4)]
    draws = [[wall[52 + seat]] for seat in range(4)]
    discards = [[60] for _ in range(4)]
    result = [[round_index, honba, kyotaku], [25000 - kyotaku * 1000, 25000, 25000, 25000], [wall[56]], []]
    for seat in range(4):
        result.extend([hands[seat], draws[seat], discards[seat]])
    result.append(["不明"])
    return result


def make_document(rounds):
    return {
        "rule": {"aka": 1, "disp": "4-Player South"},
        "title": ["Custom", "Test"],
        "name": ["A", "B", "C", "D"],
        "log": rounds,
        "ver": "2.3",
    }


class CustomTenhouTests(unittest.TestCase):
    def test_accepts_json_single_round_and_defaults_viewpoint_to_dealer(self):
        document = make_document([make_round(round_index=2)])
        normalized = normalize_custom_tenhou_input(json.dumps(document, ensure_ascii=False))
        game, controlled_seat = build_custom_tenhou_game(
            normalized,
            "game_test",
            "2026-08-02T00:00:00Z",
        )

        self.assertEqual(controlled_seat, 2)
        self.assertEqual(game["metadata"]["source"], "tenhou-custom")
        self.assertTrue(game["metadata"]["readOnly"])
        self.assertGreater(len(game["nodes"]), 5)

    def test_merges_naga_lines_and_allows_round_gaps(self):
        first = make_document([make_round(round_index=0)])
        second = make_document([make_round(round_index=4)])
        value = "\n".join(
            "https://tenhou.net/6/#json=" + quote(json.dumps(document, ensure_ascii=False, separators=(",", ":")))
            for document in (first, second)
        )

        normalized = normalize_custom_tenhou_input(value)
        events, _ = decode_custom_tenhou_log(normalized)

        self.assertEqual(len(normalized["log"]), 2)
        self.assertEqual(sum(event.get("type") == "start_kyoku" for event in events), 2)

    def test_allows_renchan_but_rejects_exact_duplicate_round(self):
        decode_custom_tenhou_log(make_document([
            make_round(round_index=0, honba=0),
            make_round(round_index=0, honba=1),
        ]))
        with self.assertRaisesRegex(ValueError, "东1局重复出现"):
            decode_custom_tenhou_log(make_document([
                make_round(round_index=0, honba=0),
                make_round(round_index=0, honba=0),
            ]))

    def test_rejects_score_total_with_round_location(self):
        invalid = make_round(round_index=5)
        invalid[1][0] -= 100
        with self.assertRaisesRegex(ValueError, "南2局.*99900.*100000"):
            decode_custom_tenhou_log(make_document([invalid]))

    def test_rejects_illegal_discard_with_action_location(self):
        invalid = make_round(round_index=0, kyotaku=0)
        invalid[6][0] = 47
        with self.assertRaisesRegex(ValueError, "东1局，第 2 个动作.*手牌中不存在"):
            decode_custom_tenhou_log(make_document([invalid]))

    def test_rejects_meld_with_unrelated_tiles(self):
        with self.assertRaisesRegex(ValueError, "东1局，第 7 个动作.*不是同花色的连续三张牌"):
            _parse_meld("c112537", 1, "东1局", 7)

    def test_exports_all_three_wrappers_and_round_trips(self):
        source = make_document([
            make_round(round_index=0, honba=0),
            make_round(round_index=0, honba=1),
            make_round(round_index=3, honba=0),
        ])
        game, _ = build_custom_tenhou_game(source, "game_test", "2026-08-02T00:00:00Z")
        game["currentNodeId"] = game["mainLeafNodeId"]

        exported = export_custom_tenhou(game)
        mortal = normalize_custom_tenhou_input(exported["mortal"])
        naga = normalize_custom_tenhou_input(exported["naga"])
        tenhou = normalize_custom_tenhou_input(exported["tenhou"])

        self.assertEqual(len(mortal["log"]), 3)
        self.assertEqual(len(naga["log"]), 3)
        self.assertEqual(len(tenhou["log"]), 1)
        decode_custom_tenhou_log(mortal)
        decode_custom_tenhou_log(naga)

    def test_rejects_three_player_rule(self):
        document = make_document([make_round()])
        document["rule"]["disp"] = "3-Player South"
        with self.assertRaisesRegex(ValueError, "仅支持四人麻将"):
            normalize_custom_tenhou_input(json.dumps(document))


if __name__ == "__main__":
    unittest.main()
