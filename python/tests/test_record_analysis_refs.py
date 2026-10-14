import copy
import json
from pathlib import Path
import tempfile
import unittest

from rms_backend.record_analysis_refs import AnalysisPending, AnalysisReference
from rms_backend.record_codec_scheduler import RecordCodecScheduler
from rms_backend.record_result_store import RecordResultStore
from rms_backend.record_workspace_writer import RecordWorkspaceWriter


class AnalysisReferenceTests(unittest.TestCase):
    def test_node_metadata_and_cold_access_never_decode_or_wait_and_eviction_leaves_no_mirror(self):
        with tempfile.TemporaryDirectory() as directory:
            writer = RecordWorkspaceWriter(Path(directory) / 'data.sqlite', 'test', create=True)
            scheduler = RecordCodecScheduler()
            store = RecordResultStore('test', scheduler, writer)
            try:
                writer.ready.result(3)
                result = {'status': 'ready', 'outputs': {'unknown': [0, .25, 1]}}
                identity = store.register('slot', fields={'status': [True, 'ready'], 'outputs': [False, None]}, raw=result)
                reference = AnalysisReference(store, identity)
                self.assertIsInstance(reference, dict)
                self.assertEqual(reference.get('status'), 'ready')
                self.assertEqual(list(reference), ['status', 'outputs'])
                self.assertEqual(reference.get('missing', 'fallback'), 'fallback')
                self.assertTrue(reference.pending_io)
                with self.assertRaises(AnalysisPending):
                    reference.get('outputs')
                with self.assertRaises(AnalysisPending):
                    copy.deepcopy(reference)
                with self.assertRaises((AnalysisPending, TypeError)):
                    json.dumps(reference)  # Never silently serialize cold data as null.
                self.assertIsNone(scheduler.client.pid)
                reference.request().result(5)
                self.assertEqual(dict(reference), result)
                self.assertEqual(copy.deepcopy(reference), result)
                with self.assertRaises(TypeError):
                    reference['status'] = 'changed'
                store._versions[identity].durable.result(3)
                store.cache.set_budget(1)
                self.assertTrue(reference.pending_io)
                with self.assertRaises(AnalysisPending):
                    reference['outputs']
                self.assertEqual(reference.get('status'), 'ready')
            finally:
                store.close()
                scheduler.close()
                writer.close()
