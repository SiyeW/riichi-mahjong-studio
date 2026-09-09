import unittest

from service_debug import DebugScenarioDependencies, run_debug_scenario


class DebugScenarioDependencyTests(unittest.TestCase):
    def test_unknown_command_never_touches_dependencies(self):
        touched = []
        deps = DebugScenarioDependencies(
            state={},
            create_empty_game=lambda _seed: touched.append("create"),
            sync_snapshot=lambda _snapshot: touched.append("sync"),
            persist_snapshot=lambda _snapshot: touched.append("persist"),
            evaluate_reactions=lambda _snapshot: touched.append("reactions"),
            get_reaction_priority=lambda _action: 0,
        )

        self.assertFalse(run_debug_scenario("not-a-scenario", deps))
        self.assertEqual(touched, [])

    def test_pon_scenario_uses_only_its_named_dependencies(self):
        state = {}
        calls = []
        snapshot = {}
        game = {
            "rootNodeId": "root",
            "currentNodeId": "root",
            "nodes": {"root": {"snapshot": snapshot}},
        }

        def sync(target):
            calls.append("sync")
            target.update({
                "initialHands": [[], [], [], []],
                "hands": [[], [], [], []],
            })

        deps = DebugScenarioDependencies(
            state=state,
            create_empty_game=lambda seed: game if seed == 424242 else None,
            sync_snapshot=sync,
            persist_snapshot=lambda _snapshot: calls.append("persist"),
            evaluate_reactions=lambda _snapshot: [{"seat": 0, "response": {"type": "pon"}}],
            get_reaction_priority=lambda _action: 0,
        )

        self.assertTrue(run_debug_scenario("debug_setup_user_pon", deps))
        self.assertIs(state["game"], game)
        self.assertTrue(state["gameLoaded"])
        self.assertEqual(state["mode"], "play")
        self.assertEqual(snapshot["reactionWindow"][0]["response"]["type"], "pon")
        self.assertEqual(calls, ["sync", "persist", "persist"])


if __name__ == "__main__":
    unittest.main()
