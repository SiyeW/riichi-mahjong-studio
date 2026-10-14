import threading
import unittest

from rms_backend.record_codec_scheduler import RecordCodecScheduler


class FakeClient:
    generation = 1

    def close(self):
        pass


class RecordCodecSchedulerTests(unittest.TestCase):
    def test_reserved_capacity_is_retained_after_cpu_completion_until_backed(self):
        lane = RecordCodecScheduler(client=FakeClient())
        try:
            a, b = lane.reserve(), lane.reserve()
            self.assertIsNone(lane.reserve())
            foreground = lane.reserve(foreground=True)
            self.assertIsNotNone(foreground)
            self.assertIsNone(lane.reserve(foreground=True))
            lane.submit_required(a, lambda _: None).result(timeout=2)
            self.assertIsNone(lane.reserve())
            a.release()
            a.release()
            c = lane.reserve()
            self.assertIsNotNone(c)
            b.release()
            c.release()
            foreground.release()
        finally:
            lane.close()

    def test_demand_priority_is_fair_and_speculation_is_bounded(self):
        lane = RecordCodecScheduler(client=FakeClient())
        started, release = threading.Event(), threading.Event()
        order = []
        def held(_):
            started.set()
            release.wait(3)
        try:
            active = lane.submit_read('active', held)
            self.assertTrue(started.wait(2))
            reservation = lane.reserve()
            required = lane.submit_required(reservation, lambda _: order.append('encode'))
            demands = [lane.submit_read(f'read-{i}', lambda _, i=i: order.append(i)) for i in range(4)]
            speculative = [lane.submit_read(f'prefetch-{i}', lambda _: None, prefetch=True) for i in range(10)]
            self.assertEqual(lane.metrics()['prefetchQueued'], 3)
            self.assertTrue(all(f.cancelled() for f in speculative[:7]))
            release.set()
            active.result(2)
            required.result(2)
            for demand in demands:
                demand.result(2)
            self.assertEqual(order, [0, 1, 2, 'encode', 3])  # Active demand also earned one credit.
            reservation.release()
        finally:
            release.set()
            lane.close()

    def test_latest_group_replaces_queued_read_but_does_not_kill_running_decode(self):
        lane = RecordCodecScheduler(client=FakeClient())
        started, release = threading.Event(), threading.Event()
        try:
            active = lane.submit_read('a', lambda _: (started.set(), release.wait(3)))
            self.assertTrue(started.wait(2))
            old = lane.submit_read('b', lambda _: None, group='opponent')
            new = lane.submit_read('c', lambda _: None, group='opponent')
            self.assertTrue(old.cancelled())
            joined = lane.submit_read('a', lambda _: self.fail('Duplicate decode'))
            self.assertIs(joined, active)
            prefetched = lane.submit_read('d', lambda _: None, prefetch=True)
            self.assertIs(lane.submit_read('d', lambda _: self.fail('Duplicate decode')), prefetched)
            release.set()
            active.result(2)
            new.result(2)
            prefetched.result(2)
        finally:
            release.set()
            lane.close()
