import copy
import unittest
from unittest.mock import patch

import service
from game_record_storage import hydrate_game_structure


class LegacyNodeLinksTests(unittest.TestCase):
    def test_deep_valid_links_are_checked_without_recursion_or_mutation(self):
        nodes = {
            str(i): {'parentId': str(i - 1) if i else None,
                     'children': [str(i + 1)] if i < 2999 else []}
            for i in range(3000)
        }
        game = {'nodes': nodes}
        original = copy.deepcopy(game)
        for version in (1, 2):
            self.assertIs(hydrate_game_structure(game, version), game)
            self.assertEqual(game, original)

    def test_cycles_in_either_direction_and_disconnected_components_are_rejected(self):
        for version in (1, 2):
            for field, value in [('children', ['b']), ('parentId', 'b')]:
                game = {'nodes': {'root': {'children': []},
                                  'a': {field: value},
                                  'b': {field: ['a'] if field == 'children' else 'a'}}}
                with self.subTest(version=version, field=field):
                    with self.assertRaisesRegex(ValueError, 'cycle'):
                        hydrate_game_structure(game, version)

    def test_missing_and_malformed_links_are_rejected(self):
        for node in [{'children': ['missing']}, {'parentId': 'missing'},
                     {'children': 'root'}, {'children': [{}]}]:
            with self.subTest(node=node):
                with self.assertRaises(ValueError):
                    hydrate_game_structure({'nodes': {'root': node}}, 2)

    def test_import_rejects_cycle_before_stopping_or_replacing_current_game(self):
        saved = dict(service.STATE)
        try:
            old_game = service.create_empty_game(123456)
            service.STATE.update(game=old_game, gameLoaded=True)
            record = {'formatVersion': 2, 'game': copy.deepcopy(old_game), 'state': {}}
            record['game']['nodes']['n_root']['parentId'] = 'n_root'
            with patch.object(service, 'reset_runtime_for_game_change') as reset:
                with self.assertRaisesRegex(ValueError, 'cycle'):
                    service.load_game_record(record)
                reset.assert_not_called()
            self.assertIs(service.STATE['game'], old_game)
        finally:
            service.STATE.clear()
            service.STATE.update(saved)


if __name__ == '__main__':
    unittest.main()
