import copy
import unittest
from unittest import mock

from rms_backend import service


class GameSessionResetTest(unittest.TestCase):
    def setUp(self):
        service.STATE["game"] = None
        service.STATE["gameLoaded"] = False
        service.STATE["nextGameId"] = 1
        service.DECISION_ANALYSIS.reset()
        service.MJAI_STREAMS.clear()

    @staticmethod
    def _record(game):
        return {
            "formatVersion": 2,
            "game": copy.deepcopy(game),
            "state": {
                "mode": "play",
                "controlledSeat": 0,
                "pendingSeatSwitch": None,
                "visibleHands": False,
            },
        }

    def test_new_game_after_loaded_record_uses_fresh_identity_and_stream_cache(self):
        loaded_game = service.create_empty_game(111111)
        service.STATE["nextGameId"] = 1
        service.RECORD_SESSION.load(self._record(loaded_game))

        loaded_id = service.STATE["game"]["gameId"]
        loaded_node_id = service.STATE["game"]["currentNodeId"]
        service.MJAI_STREAMS.get_bundle(service.STATE["game"], loaded_node_id, 0)
        self.assertGreater(len(service.MJAI_STREAMS), 0)

        with (
            mock.patch.object(service.RECORD_SESSION.dependencies, "advance_to_next_user_turn"),
            mock.patch.object(service.SERVICE_RUNTIME.background, "submit"),
        ):
            service.RECORD_SESSION.create()

        self.assertNotEqual(service.STATE["game"]["gameId"], loaded_id)
        self.assertEqual(service.STATE["game"]["gameId"], "game_0002")
        self.assertEqual(len(service.MJAI_STREAMS), 0)

    def test_loading_same_game_id_clears_cached_mjai_stream(self):
        first_game = service.create_empty_game(222222)
        service.RECORD_SESSION.load(self._record(first_game))
        node_id = service.STATE["game"]["currentNodeId"]
        first_bundle = service.MJAI_STREAMS.get_bundle(
            service.STATE["game"], node_id, 1
        )
        first_events = copy.deepcopy(first_bundle["events"])

        second_game = service.create_empty_game(333333)
        second_game["gameId"] = first_game["gameId"]
        second_snapshot = second_game["nodes"][second_game["currentNodeId"]]["snapshot"]
        second_snapshot["initialHands"][0][0] = "N"
        service.RECORD_SESSION.load(self._record(second_game))

        self.assertEqual(len(service.MJAI_STREAMS), 0)
        second_bundle = service.MJAI_STREAMS.get_bundle(
            service.STATE["game"], node_id, 1
        )
        self.assertNotEqual(second_bundle["events"], first_events)

    def test_close_game_clears_loaded_session(self):
        service.STATE["game"] = service.create_empty_game(444444)
        service.STATE["gameLoaded"] = True
        service.STATE["mode"] = "research"
        service.STATE["pendingSeatSwitch"] = 2
        service.STATE["visibleHands"] = True

        with mock.patch.object(service.RECORD_SESSION.dependencies, "reset_runtime"):
            service.RECORD_SESSION.close()

        self.assertIsNone(service.STATE["game"])
        self.assertFalse(service.STATE["gameLoaded"])
        self.assertEqual(service.STATE["mode"], "play")
        self.assertIsNone(service.STATE["pendingSeatSwitch"])
        self.assertFalse(service.STATE["visibleHands"])


if __name__ == "__main__":
    unittest.main()
