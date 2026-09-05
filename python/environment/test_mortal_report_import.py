from __future__ import annotations

import unittest
from unittest.mock import patch

from analysis_cache import cache_key_context

import service
from mortal_report_import import (
    OFFICIAL_MORTAL_REPORT_SOURCE_ID,
    attach_mortal_review_cache,
    build_mortal_report_game,
)


def starting_hands():
    return [["1m"] * 13, ["2m"] * 13, ["3m"] * 13, ["4m"] * 13]


def start_kyoku():
    return {
        "type": "start_kyoku",
        "bakaze": "E",
        "kyoku": 1,
        "honba": 0,
        "kyotaku": 0,
        "oya": 0,
        "scores": [25000, 25000, 25000, 25000],
        "dora_marker": "1p",
        "tehais": starting_hands(),
    }


def build_report(result, terminal_event):
    return {
        "player_id": 3,
        "game_length": "Tonpuusen",
        "mjai_log": [
            {"type": "start_game", "names": ["A", "B", "C", "D"]},
            start_kyoku(),
            terminal_event,
            {"type": "end_kyoku"},
            {"type": "end_game"},
        ],
        "split_logs": [
            {
                "log": [
                    [
                        [0, 0, 0],
                        result,
                    ]
                ]
            }
        ],
    }


class MortalReportImportTests(unittest.TestCase):
    def test_attaches_compact_official_review_as_stale_decision_cache(self):
        report = {
            "player_id": 1,
            "game_length": "Tonpuusen",
            "mjai_log": [
                {"type": "start_game", "names": ["A", "B", "C", "D"]},
                start_kyoku(),
                {"type": "tsumo", "actor": 0, "pai": "9m"},
                {"type": "dahai", "actor": 0, "pai": "1m", "tsumogiri": False},
                {"type": "tsumo", "actor": 1, "pai": "3p"},
                {"type": "dahai", "actor": 1, "pai": "2m", "tsumogiri": False},
                {"type": "ryukyoku", "deltas": [0, 0, 0, 0]},
                {"type": "end_kyoku"},
                {"type": "end_game"},
            ],
            "review": {
                "model_tag": "4.1b",
                "temperature": 0.1,
                "kyokus": [
                    {
                        "kyoku": 0,
                        "honba": 0,
                        "entries": [
                            {
                                "last_actor": 0,
                                "tile": "1m",
                                "state": {"tehai": ["2m"] * 13, "fuuros": []},
                                "expected": {"type": "none"},
                                "actual": {"type": "none"},
                                "details": [
                                    {"action": {"type": "none"}, "q_value": 0.25, "prob": 0.8},
                                    {
                                        "action": {
                                            "type": "chi",
                                            "actor": 1,
                                            "target": 0,
                                            "pai": "1m",
                                            "consumed": ["2m", "3m"],
                                        },
                                        "q_value": -0.5,
                                        "prob": 0.2,
                                    },
                                ],
                            },
                            {
                                "last_actor": 1,
                                "tile": "3p",
                                "state": {"tehai": ["2m"] * 13 + ["3p"], "fuuros": []},
                                "expected": {
                                    "type": "dahai",
                                    "actor": 1,
                                    "pai": "2m",
                                    "tsumogiri": False,
                                },
                                "actual": {
                                    "type": "dahai",
                                    "actor": 1,
                                    "pai": "2m",
                                    "tsumogiri": False,
                                },
                                "details": [
                                    {
                                        "action": {
                                            "type": "dahai",
                                            "actor": 1,
                                            "pai": "2m",
                                            "tsumogiri": False,
                                        },
                                        "q_value": 0.4,
                                        "prob": 0.75,
                                    },
                                    {
                                        "action": {
                                            "type": "dahai",
                                            "actor": 1,
                                            "pai": "3p",
                                            "tsumogiri": True,
                                        },
                                        "q_value": 0.1,
                                        "prob": 0.25,
                                    },
                                ],
                            },
                        ],
                    }
                ],
            },
        }

        game, controlled_seat = build_mortal_report_game(
            report, "https://example.invalid/report.json", "game_review", "2026-08-01T00:00:00Z"
        )
        attached = attach_mortal_review_cache(game, report, controlled_seat)

        self.assertEqual(len(attached), 2)
        self.assertNotIn("analysisSources", game)
        reaction = next(value for value in attached.values() if value.get("mode") == "reaction")
        discard = next(value for value in attached.values() if value.get("discardEntries"))
        self.assertEqual(reaction["model"], "Mortal 官方分析")
        self.assertEqual(
            [(metric["title"]["zh-CN"], metric["fractionDigits"]) for metric in reaction["metricDefinitions"]],
            [("Q 值", 3), ("P 值", 2)],
        )
        self.assertEqual(reaction["reactionEntries"][0]["variant"], "none")
        self.assertEqual(reaction["reactionEntries"][0]["probability"], 0.8)
        self.assertEqual(reaction["reactionEntries"][0]["metrics"]["policy"], 0.8)
        self.assertEqual(reaction["recommendationMetricId"], "policy")
        self.assertEqual(discard["bestAction"]["pai"], "2m")
        self.assertEqual(discard["discardEntries"][0]["value"], 0.4)
        self.assertEqual(discard["discardEntries"][1]["tsumogiri"], True)
        cache_keys = [
            key
            for node in game["nodes"].values()
            for key in node.get("analysisCache", {})
        ]
        self.assertTrue(all(key.endswith(f"::{OFFICIAL_MORTAL_REPORT_SOURCE_ID}") for key in cache_keys))
        self.assertTrue(all(cache_key_context(key) is not None for key in cache_keys))

        saved_state = dict(service.STATE)
        try:
            with patch.object(service, 'request_current_opponent_analysis'), \
                 patch.object(service, 'reset_runtime_for_game_change'):
                service.import_mortal_report(report, 'https://example.invalid/report.json')
            self.assertTrue(service.STATE['gameLoaded'])
            self.assertEqual(service.STATE['controlledSeat'], controlled_seat)
            imported_keys = [
                key for node in service.STATE['game']['nodes'].values()
                for key in node.get('analysisCache', {})
            ]
            self.assertEqual(sorted(imported_keys), sorted(cache_keys))
        finally:
            service.STATE.clear()
            service.STATE.update(saved_state)

    def test_malformed_official_review_does_not_block_replay_import(self):
        report = build_report(
            ["流局", [0, 0, 0, 0]],
            {"type": "ryukyoku", "deltas": [0, 0, 0, 0]},
        )
        report["review"] = {"kyokus": [{"kyoku": "broken", "entries": 1}, None]}

        game, controlled_seat = build_mortal_report_game(
            report, "https://example.invalid/report.json", "game_bad_review", "2026-08-01T00:00:00Z"
        )

        self.assertEqual(attach_mortal_review_cache(game, report, controlled_seat), {})

    def test_imports_detailed_hora_and_round_result(self):
        report = build_report(
            [
                "和了",
                [8800, -2600, -2600, -2600],
                [
                    0,
                    0,
                    0,
                    "20符4飜2600点∀",
                    "立直(1飜)",
                    "門前清自摸和(1飜)",
                    "平和(1飜)",
                    "赤ドラ(1飜)",
                ],
            ],
            {
                "type": "hora",
                "actor": 0,
                "target": 0,
                "deltas": [8800, -2600, -2600, -2600],
                "ura_markers": ["C"],
            },
        )

        game, controlled_seat = build_mortal_report_game(
            report, "https://example.invalid/report.json", "game_0001", "2026-07-28T00:00:00Z"
        )
        self.assertEqual(controlled_seat, 3)
        round_result_nodes = [
            node for node in game["nodes"].values() if (node.get("action") or {}).get("type") == "round_result"
        ]
        self.assertEqual(len(round_result_nodes), 1)
        snapshot = round_result_nodes[0]["snapshot"]
        event_data = snapshot["lastAction"]["result"]["eventData"]
        hora_node = next(
            node for node in game["nodes"].values() if (node.get("action") or {}).get("type") == "hora"
        )
        self.assertEqual(hora_node["snapshot"]["scores"], [25000, 25000, 25000, 25000])
        self.assertEqual(snapshot["scores"], [25000, 25000, 25000, 25000])
        self.assertEqual(snapshot["lastAction"]["result"]["scores"], [33800, 22400, 22400, 22400])
        self.assertEqual(game["matchState"]["scores"], [33800, 22400, 22400, 22400])
        self.assertEqual(event_data["deltas"], [8800, -2600, -2600, -2600])
        self.assertEqual(event_data["han"], 4)
        self.assertEqual(event_data["fu"], 20)
        self.assertEqual(
            [item["name"] for item in event_data["yakuDetails"]],
            ["Riichi", "Menzen Tsumo", "Pinfu", "Aka Dora"],
        )
        match_end_node = next(
            node for node in game["nodes"].values() if (node.get("action") or {}).get("type") == "match_end"
        )
        self.assertEqual(match_end_node["snapshot"]["lastAction"]["type"], "match_result")
        terminal_info = service.build_result_info(match_end_node["snapshot"])
        self.assertEqual(terminal_info["title"], "终局")
        self.assertEqual(terminal_info["scores"], [33800, 22400, 22400, 22400])

    def test_unknown_settlement_falls_back_without_failing_import(self):
        report = build_report(
            ["不明"],
            {
                "type": "hora",
                "actor": 1,
                "target": 0,
                "deltas": [-1000, 1000, 0, 0],
                "ura_markers": [],
            },
        )

        game, _ = build_mortal_report_game(
            report, "https://example.invalid/report.json", "game_0002", "2026-07-28T00:00:00Z"
        )
        round_result_nodes = [
            node for node in game["nodes"].values() if (node.get("action") or {}).get("type") == "round_result"
        ]
        self.assertEqual(len(round_result_nodes), 1)
        event_data = round_result_nodes[0]["snapshot"]["lastAction"]["result"]["eventData"]
        self.assertEqual(event_data["actor"], 1)
        self.assertEqual(event_data["deltas"], [-1000, 1000, 0, 0])
        self.assertNotIn("han", event_data)

    def test_malformed_split_logs_do_not_block_import(self):
        report = build_report(
            ["流局", [1000, -3000, 1000, 1000]],
            {
                "type": "ryukyoku",
                "deltas": [1000, -3000, 1000, 1000],
            },
        )
        report["split_logs"] = [{"log": ["broken"]}, None]

        game, _ = build_mortal_report_game(
            report, "https://example.invalid/report.json", "game_0003", "2026-07-28T00:00:00Z"
        )
        round_result_nodes = [
            node for node in game["nodes"].values() if (node.get("action") or {}).get("type") == "round_result"
        ]
        self.assertEqual(len(round_result_nodes), 1)
        result = round_result_nodes[0]["snapshot"]["lastAction"]["result"]
        self.assertEqual(result["eventType"], "ryukyoku")
        self.assertEqual(result["eventData"]["reasonLabel"], "流局")


if __name__ == "__main__":
    unittest.main()
