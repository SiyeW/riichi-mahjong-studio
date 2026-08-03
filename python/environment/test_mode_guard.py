import unittest

import service


class ModeGuardTest(unittest.TestCase):
    def test_mode_cannot_change_without_loaded_game(self):
        previous_game = service.STATE.get("game")
        previous_loaded = service.STATE.get("gameLoaded")
        previous_mode = service.STATE.get("mode")
        try:
            service.STATE["game"] = None
            service.STATE["gameLoaded"] = False
            service.STATE["mode"] = "play"

            with self.assertRaisesRegex(ValueError, "No active game is loaded"):
                service.handle_command("test", "set_mode", {"mode": "research"})

            self.assertEqual(service.STATE["mode"], "play")
        finally:
            service.STATE["game"] = previous_game
            service.STATE["gameLoaded"] = previous_loaded
            service.STATE["mode"] = previous_mode


if __name__ == "__main__":
    unittest.main()
