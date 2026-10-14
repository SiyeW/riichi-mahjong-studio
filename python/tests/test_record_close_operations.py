from concurrent.futures import ThreadPoolExecutor
from threading import Event
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

from rms_backend.records.close_operations import RecordCloseOperations
from tests.test_record_save_operations import RecordSaveFixture


class RecordCloseOperationsTests(RecordSaveFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.closes = RecordCloseOperations(self.resources, self.session)
        self.addCleanup(self.closes.shutdown)

    def capture_close(self, retain=True):
        identity = str(uuid4())
        self.closes.capture(self.identity, identity, retain=retain)
        return identity

    def test_dirty_close_retains_workspace_and_does_not_encode_imported_cold_facts(self):
        storage = self.session.storage
        storage.results.register('cold', raw={'outputs': {'external': [0, 1]}}, fields={}, revision=0)
        close_id = self.capture_close()
        with patch.object(storage.results, 'portable', side_effect=AssertionError('unnecessary conversion')):
            result = self.closes.prepare(close_id)
        self.assertEqual(result['recovery']['kind'], 'workspace')
        self.assertIsNone(storage.reserve_analysis())
        self.closes.confirm(close_id)
        self.assertEqual(self.resources.wait_released(self.identity)['disposition'], 'retained')

    def test_clean_close_uses_saved_source_identity_and_current_bookmark(self):
        token, target, stage = self.capture_and_write('clean.mjstudio', 1)
        os.replace(stage, target)
        self.operations.committed(token)
        self.session.storage.move_cursor(dict(currentNodeId=self.state['game']['currentNodeId'],
                                              mode='research', controlledSeat=2, visibleHands=True))
        close_id = self.capture_close()
        with patch.object(self.session.storage, 'ensure_private_base', side_effect=AssertionError('clean copy')):
            result = self.closes.prepare(close_id)
        self.assertEqual(result['recovery']['path'], str(target))
        self.assertEqual(result['recovery']['bookmark']['controlledSeat'], 2)
        self.assertIn('prefix', result['recovery']['fileIdentity'])
        self.closes.confirm(close_id)
        self.assertEqual(self.resources.wait_released(self.identity)['disposition'], 'retention-off')

    def test_retention_off_does_not_wait_for_recovery_or_encode(self):
        close_id = self.capture_close(retain=False)
        with patch.object(self.session.storage, 'wait_authored', side_effect=AssertionError('retention disabled')):
            self.assertIsNone(self.closes.prepare(close_id)['recovery'])
        self.closes.confirm(close_id)
        self.resources.wait_released(self.identity)

    def test_cancel_is_immediate_and_old_barrier_cannot_retire_a_new_generation(self):
        storage = self.session.storage
        old = self.capture_close()
        entered, release = Event(), Event()
        actual = storage.wait_authored
        def wait(cutoff):
            entered.set()
            self.assertTrue(release.wait(5))
            return actual(cutoff)
        with ThreadPoolExecutor(max_workers=1) as executor, patch.object(storage, 'wait_authored', side_effect=wait):
            future = executor.submit(self.closes.prepare, old)
            try:
                self.assertTrue(entered.wait(5))
                self.assertTrue(self.closes.cancel(old)['cancelled'])
                reservation = storage.reserve_analysis()
                self.assertIsNotNone(reservation)
                reservation.reservation.release()
                fresh = self.capture_close()
                release.set()
                with self.assertRaisesRegex(ValueError, 'cancelled'):
                    future.result(timeout=5)
                self.assertEqual(self.closes.prepare(fresh)['recovery']['kind'], 'workspace')
                self.closes.confirm(fresh)
                self.resources.wait_released(self.identity)
            finally:
                release.set()

    def test_confirm_requires_successful_prepare_and_pending_save_keeps_resource_owned(self):
        token, target, stage = self.capture_and_write('save-in-flight.mjstudio', 1)
        close_id = self.capture_close()
        with self.assertRaisesRegex(ValueError, 'complete recovery'):
            self.closes.confirm(close_id)
        self.closes.prepare(close_id)
        storage = self.session.storage
        self.closes.confirm(close_id)
        self.assertFalse(storage.writer.closed.done())
        os.replace(stage, target)
        self.operations.committed(token)
        self.resources.wait_released(self.identity)
        self.assertTrue(storage.writer.closed.done())


if __name__ == '__main__':
    unittest.main()
