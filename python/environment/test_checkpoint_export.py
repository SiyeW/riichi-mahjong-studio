import unittest
from unittest.mock import patch

import service


class CheckpointExportTests(unittest.TestCase):
    def test_checkpoint_exports_record_without_building_or_consuming_ui_state(self):
        record = {'game': {'gameId': 'test'}}
        with patch.object(service, 'serialize_game_record', return_value=record), \
             patch.object(service, 'build_view_payload', side_effect=AssertionError('unneeded view')), \
             patch.object(service, 'build_state_payload', side_effect=AssertionError('unneeded runtime state')):
            result = service.handle_command('request', 'export_game_record', {'checkpoint': True})
        self.assertIs(result['record'], record)
        self.assertEqual(result['request_id'], 'request')
        self.assertNotIn('view', result)
        self.assertIn('analysisVisibility', result['state'])

    def test_normal_export_keeps_the_existing_response(self):
        with patch.object(service, 'serialize_game_record', return_value={'game': {}}), \
             patch.object(service, 'build_response', return_value={'view': 'unchanged'}) as build:
            result = service.handle_command('request', 'export_game_record', {})
        self.assertEqual(result, {'view': 'unchanged'})
        build.assert_called_once()


if __name__ == '__main__':
    unittest.main()
