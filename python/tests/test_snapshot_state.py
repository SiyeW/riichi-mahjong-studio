import copy
import unittest

from rms_backend import snapshot_state


class SnapshotStateTests(unittest.TestCase):
    def test_new_mirrors_do_not_copy_existing_flat_fields_back(self):
        snapshot = {'hands': [['1m'], [], [], []], 'scores': [26000, 24000, 25000, 25000],
                    'pendingKan': {'type': 'ankan', 'consumed': ['5mr', '5m', '5m', '5m']},
                    'pendingDoraRevealAfterActionCount': 1}
        hands, scores = snapshot['hands'], snapshot['scores']
        snapshot_state.sync(snapshot)
        self.assertIs(snapshot['hands'], hands)
        self.assertIs(snapshot['scores'], scores)
        self.assertEqual(snapshot['hands'], snapshot['kyokuState']['hands'])
        self.assertIsNot(snapshot['hands'], snapshot['kyokuState']['hands'])
        snapshot['hands'][0].append('2m')
        snapshot['scores'][0] += 1000
        snapshot['pendingKan']['consumed'].clear()
        self.assertEqual(snapshot['kyokuState']['hands'][0], ['1m'])
        self.assertEqual(snapshot['matchState']['scores'][0], 26000)
        self.assertEqual(len(snapshot['kyokuState']['pendingKan']['consumed']), 4)
        self.assertEqual(snapshot['pendingDoraRevealAfterActionCount'], 1)

    def test_existing_mirrors_remain_authoritative_and_detached(self):
        snapshot = {'hands': [['wrong'], [], [], []], 'scores': [0] * 4,
                    'matchState': {'scores': [30000, 20000, 25000, 25000], 'honba': '2'},
                    'kyokuState': {'hands': [['9s'], [], [], []], 'pendingKan': {'actor': 1}}}
        before = copy.deepcopy(snapshot)
        snapshot_state.sync(snapshot)
        self.assertEqual(snapshot['hands'], before['kyokuState']['hands'])
        self.assertEqual(snapshot['scores'], before['matchState']['scores'])
        self.assertEqual(snapshot['honba'], 2)
        snapshot['hands'][0].append('8s')
        snapshot['pendingKan']['actor'] = 2
        self.assertEqual(snapshot['kyokuState'], before['kyokuState'])
        # Repeated runtime synchronization still publishes mirror updates.
        snapshot['kyokuState']['hands'][0].append('7s')
        snapshot_state.sync(snapshot)
        self.assertEqual(snapshot['hands'][0], ['9s', '7s'])

    def test_missing_fields_get_independent_defaults(self):
        first, second = {}, {}
        snapshot_state.sync(first)
        snapshot_state.sync(second)
        first['hands'][0].append('1m')
        first['scores'][0] = 0
        first['riichiDeclared'][0] = True
        self.assertEqual(first['kyokuState']['hands'], [[], [], [], []])
        self.assertEqual(first['matchState']['scores'], [25000] * 4)
        self.assertEqual(second['hands'], [[], [], [], []])
        self.assertEqual(second['scores'], [25000] * 4)
        self.assertEqual(snapshot_state.EMPTY_SEAT_LISTS, [[], [], [], []])
        self.assertEqual(snapshot_state.FALSE_BY_SEAT, [False] * 4)

    def test_mixed_flat_and_legacy_mirror_fields_keep_normalization(self):
        snapshot = {'hands': [['1p'], [], [], []], 'scores': [1, 2, 3, 4],
                    'matchState': {'scores': [10, 20, 30, 40]},
                    'pendingDoraRevealCount': -1, 'pendingDoraRevealAfterActionCount': -2}
        snapshot_state.sync(snapshot)
        self.assertEqual(snapshot['scores'], [10, 20, 30, 40])
        self.assertEqual(snapshot['startScores'], [1, 2, 3, 4])
        self.assertNotIn('pendingDoraRevealCount', snapshot)
        self.assertNotIn('pendingDoraRevealAfterActionCount', snapshot)


if __name__ == '__main__':
    unittest.main()
