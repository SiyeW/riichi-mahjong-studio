import unittest
from unittest import mock

from legal_action_provider import LegalActionProvider


def snapshot_with_hand(*tiles):
    return {
        "phase": "discard",
        "currentActor": 0,
        "hands": [list(tiles), [], [], []],
        "scores": [25000] * 4,
        "riichiAccepted": [False] * 4,
        "rivers": [[] for _ in range(4)],
        "melds": [[] for _ in range(4)],
        "actionHistory": [],
    }


class LegalActionProviderTest(unittest.TestCase):
    def create_provider(self, build_actions, *, research=True, cache_limit=4096):
        return LegalActionProvider(
            build_actions=build_actions,
            controlled_seat=lambda: 0,
            research_mode=lambda: research,
            normalize_seat=int,
            cache_limit=cache_limit,
        )

    def test_research_results_are_cached_and_returned_as_copies(self):
        build_actions = mock.Mock(return_value=[{"id": "discard"}])
        provider = self.create_provider(build_actions)
        game = {"nodes": {"node": {"snapshot": snapshot_with_hand("1m")}}}

        first = provider.for_node(game, "node")
        first.append({"id": "mutated"})
        second = provider.for_node(game, "node")

        self.assertEqual(build_actions.call_count, 1)
        self.assertEqual(second, [{"id": "discard"}])

    def test_snapshot_change_invalidates_the_cached_result(self):
        build_actions = mock.Mock(return_value=[])
        provider = self.create_provider(build_actions)
        snapshot = snapshot_with_hand("1m")
        game = {"nodes": {"node": {"snapshot": snapshot}}}

        provider.for_node(game, "node")
        snapshot["hands"][0].append("2m")
        provider.for_node(game, "node")

        self.assertEqual(build_actions.call_count, 2)

    def test_play_mode_does_not_reuse_research_cache(self):
        build_actions = mock.Mock(return_value=[])
        provider = self.create_provider(build_actions, research=False)
        game = {"nodes": {"node": {"snapshot": snapshot_with_hand("1m")}}}

        provider.for_node(game, "node")
        provider.for_node(game, "node")

        self.assertEqual(build_actions.call_count, 2)

    def test_clear_cache_releases_previous_results(self):
        build_actions = mock.Mock(return_value=[])
        provider = self.create_provider(build_actions)
        game = {"nodes": {"node": {"snapshot": snapshot_with_hand("1m")}}}

        provider.for_node(game, "node")
        provider.clear_cache()
        provider.for_node(game, "node")

        self.assertEqual(build_actions.call_count, 2)


if __name__ == "__main__":
    unittest.main()
