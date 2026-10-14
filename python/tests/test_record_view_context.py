import unittest

from rms_backend.record_view_context import RecordViewContext


class RecordViewContextTests(unittest.TestCase):
    def setUp(self):
        self.state = dict(gameLoaded=True, game=dict(gameId='same-id', currentNodeId='A'),
                          controlledSeat=0, mode='research', visibleHands=False)
        self.epochs = [1, 2]
        self.views = RecordViewContext(self.state, lambda: tuple(self.epochs))

    def test_same_node_explicit_visit_aba_and_reopening_are_distinct(self):
        first = self.views.current()
        self.assertEqual(first, self.views.current())
        self.views.begin_visit(1)
        same_node = self.views.current()
        self.assertGreater(same_node['sequence'], first['sequence'])
        self.state['game']['currentNodeId'] = 'B'
        middle = self.views.current()
        self.state['game']['currentNodeId'] = 'A'
        last = self.views.current()
        self.assertGreater(last['sequence'], middle['sequence'])
        self.state['game'] = dict(self.state['game'])
        self.assertNotEqual(self.views.current()['sessionId'], first['sessionId'])

    def test_permissions_epochs_and_event_target_are_part_of_display_authority(self):
        first = self.views.current()
        self.state['visibleHands'] = True
        second = self.views.current()
        self.epochs[0] += 1
        third = self.views.current()
        self.assertLess(first['sequence'], second['sequence'])
        self.assertLess(second['sequence'], third['sequence'])
        event = dict(type='analysis_ready', gameId='same-id', nodeId='A', analysis=dict(seat=0))
        self.assertEqual(self.views.tag_event(event)['viewToken'], third)
        event['nodeId'] = 'B'
        self.assertNotIn('viewToken', self.views.tag_event(event))
        self.state['gameLoaded'] = False
        self.assertIsNone(self.views.current())
