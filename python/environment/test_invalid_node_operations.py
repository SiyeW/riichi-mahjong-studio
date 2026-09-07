import copy
import unittest
from unittest.mock import patch

import service


class InvalidNodeOperationTests(unittest.TestCase):
    def test_rejected_navigation_and_deletion_leave_runtime_and_record_unchanged(self):
        saved = dict(service.STATE)
        try:
            game = service.create_empty_game(123456)
            service.STATE.update(game=game, gameLoaded=True, mode='research')
            operations = [
                (service.RECORD_COMMANDS.jump, 'missing'),
                (service.RECORD_COMMANDS.delete, 'missing'),
                (service.RECORD_COMMANDS.delete, game['rootNodeId']),
            ]
            for operation, node_id in operations:
                with self.subTest(operation=operation.__name__, node_id=node_id):
                    before = copy.deepcopy(game)
                    with patch.object(service.RECORD_COMMANDS.dependencies, 'cancel_play_prefetch') as prefetch, \
                         patch.object(service.RECORD_COMMANDS.dependencies, 'cancel_auto_analysis') as auto, \
                         patch.object(service.RECORD_COMMANDS.dependencies, 'purge_background_analysis') as purge:
                        with self.assertRaises(ValueError):
                            operation(node_id)
                        prefetch.assert_not_called()
                        auto.assert_not_called()
                        purge.assert_not_called()
                    self.assertEqual(game, before)
        finally:
            service.STATE.clear()
            service.STATE.update(saved)


if __name__ == '__main__':
    unittest.main()
