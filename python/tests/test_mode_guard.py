import unittest

from rms_backend import service


class ModeGuardTest(unittest.TestCase):
    def test_pending_seat_switch_is_consumed_by_view_control(self):
        previous_seat = service.STATE.get("controlledSeat")
        previous_pending = service.STATE.get("pendingSeatSwitch")
        try:
            service.STATE["controlledSeat"] = 0
            service.STATE["pendingSeatSwitch"] = 2

            changed = service.VIEW_CONTROL_COMMANDS.apply_pending_seat_switch({})

            self.assertTrue(changed)
            self.assertEqual(service.STATE["controlledSeat"], 2)
            self.assertIsNone(service.STATE["pendingSeatSwitch"])
            self.assertFalse(
                service.VIEW_CONTROL_COMMANDS.apply_pending_seat_switch({})
            )
        finally:
            service.STATE["controlledSeat"] = previous_seat
            service.STATE["pendingSeatSwitch"] = previous_pending

    def test_mode_cannot_change_without_loaded_game(self):
        previous_game = service.STATE.get("game")
        previous_loaded = service.STATE.get("gameLoaded")
        previous_mode = service.STATE.get("mode")
        try:
            service.STATE["game"] = None
            service.STATE["gameLoaded"] = False
            service.STATE["mode"] = "play"

            with self.assertRaisesRegex(ValueError, "No active game is loaded"):
                service.STATEFUL_COMMANDS.dispatch(
                    "test", "set_mode", {"mode": "research"}
                )

            self.assertEqual(service.STATE["mode"], "play")
        finally:
            service.STATE["game"] = previous_game
            service.STATE["gameLoaded"] = previous_loaded
            service.STATE["mode"] = previous_mode


if __name__ == "__main__":
    unittest.main()
