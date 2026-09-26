import unittest

from rms_backend.auto_analysis_plan import is_terminal_analysis_node, preceding_prediction_node


class TerminalAnalysisTests(unittest.TestCase):
    def test_outcome_history_and_settlement_are_terminal(self):
        for event in ("hora", "ryukyoku", "end_kyoku"):
            with self.subTest(event=event):
                self.assertTrue(is_terminal_analysis_node({
                    "action": {"type": "reaction"},
                    "snapshot": {"actionHistory": [{"type": event}, {"type": "dora"}]},
                }))
        for phase in ("game_end", "round_result", "match_end"):
            with self.subTest(phase=phase):
                self.assertTrue(is_terminal_analysis_node({"snapshot": {"phase": phase}}))
        self.assertFalse(is_terminal_analysis_node({"snapshot": {"actionHistory": [
            {"type": "hora"}, {"type": "start_kyoku"}, {"type": "tsumo"},
        ]}}))
        self.assertFalse(is_terminal_analysis_node({"action": {"type": "tsumo"}}))

    def test_display_source_is_same_branch_and_round_not_last_screen(self):
        def node(parent, phase, round_index=0):
            return {"parentId": parent, "snapshot": {
                "phase": phase, "roundIndex": round_index, "honba": 0,
            }}
        nodes = {"p": node(None, "discard"), "win": node("p", "game_end"),
                 "result": node("win", "round_result"), "end": node("result", "match_end"),
                 "other": node(None, "discard")}
        game = {"nodes": nodes}
        self.assertIs(preceding_prediction_node(game, "end"), nodes["p"])
        nodes["p"]["snapshot"]["roundIndex"] = -1
        self.assertIsNone(preceding_prediction_node(game, "end"))
        nodes["win"]["parentId"] = "end"
        self.assertIsNone(preceding_prediction_node(game, "end"))
