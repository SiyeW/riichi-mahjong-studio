import copy
import unittest
from unittest import mock

import service


class ResearchModeActionBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.previous = {
            "mode": service.STATE.get("mode"),
            "controlledSeat": service.STATE.get("controlledSeat"),
            "gameLoaded": service.STATE.get("gameLoaded"),
            "game": service.STATE.get("game"),
        }
        service.cancel_play_prefetch()
        service.STATE["mode"] = "research"
        service.STATE["controlledSeat"] = 0
        service.STATE["gameLoaded"] = True
        service.STATE["game"] = service.create_empty_game(260731)

    def tearDown(self):
        service.cancel_play_prefetch()
        service.STATE.update(self.previous)

    def test_gameplay_commands_cannot_mutate_the_tree(self):
        commands = (
            ("advance_game", {}),
            ("submit_user_action", {"type": "dahai", "pai": "1m"}),
            ("confirm_pending_review", {}),
        )
        with mock.patch.object(
                service,
                "get_training_config",
                return_value={"thinkingTimeMinS": 0.25, "thinkingTimeMaxS": 1.0},
            ):
            for command, payload in commands:
                before = copy.deepcopy(service.STATE["game"])
                with self.subTest(command=command):
                    with self.assertRaisesRegex(ValueError, "only available in play mode"):
                        service.handle_command("test", command, payload)
                    self.assertEqual(service.STATE["game"], before)


if __name__ == "__main__":
    unittest.main()
