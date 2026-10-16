import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from rms_backend.decision_analysis_session import DecisionAnalysisSession


class DecisionDisplayReadinessTests(unittest.TestCase):
    def session(self):
        session = DecisionAnalysisSession.__new__(DecisionAnalysisSession)
        session.state = {'controlledSeat': 2, 'decisionRecommendationsEnabled': True, 'game': {}}
        session.dependencies = SimpleNamespace(read_presenter=Mock())
        return session

    def test_cold_saved_read_is_explicitly_pending_without_model_inference(self):
        session = self.session()
        session.dependencies.read_presenter.read.return_value = None
        reference = object()
        result = session._read_cached_display(reference, {'cacheStatus': 'stale', 'cacheSource': {'id': 'saved'}})
        self.assertEqual(result['context']['dataState'], 'reading')
        self.assertEqual(result['seat'], 2)
        self.assertEqual(result['discardEntries'], [])
        self.assertEqual(result['cacheSource'], {'id': 'saved'})
        ready = {'model': 'test', 'seat': 2, 'discardEntries': [{'pai': '1m', 'value': .5}]}
        session.dependencies.read_presenter.read.return_value = ready
        self.assertIs(session._read_cached_display(reference), ready)

    def test_dispatch_returns_pending_display_but_does_not_mutate_retained_data(self):
        session = self.session()
        session._active_use = None
        session.cache_key = Mock(return_value='key')
        session.action_gateway = Mock()
        session.action_gateway.accepts_requests.return_value = True
        session.submit_background = Mock()
        retained = {'discardEntries': [{'pai': '1m', 'value': .5}], 'cacheStatus': 'stale'}
        session._stale_analysis = Mock(return_value=retained)
        result = session._get_or_schedule({'id': 'n'}, {'phase': 'discard'}, [{'type': 'dahai'}])
        session.submit_background.assert_called_once()
        self.assertEqual(result['context']['dataState'], 'running')
        self.assertEqual(result['discardEntries'], retained['discardEntries'])
        self.assertNotIn('context', retained)
        self.assertIsNone(session._get_or_schedule({'id': 'n'}, {'phase': 'discard'}, []))


if __name__ == '__main__':
    unittest.main()
