import unittest
from types import SimpleNamespace
from unittest import mock

from rms_backend import runtime_metrics


class FakeProcess:
    def __init__(self, pid, resident_bytes, children=None, *, parent=10):
        self.pid = pid
        self.resident_bytes = resident_bytes
        self._children = children or []
        self.parent = parent

    def ppid(self):
        return self.parent

    def memory_full_info(self):
        raise AssertionError('Footer telemetry must not scan full process memory.')

    def memory_info(self):
        return SimpleNamespace(rss=self.resident_bytes)

    def children(self, recursive=False):
        self.recursive_requested = recursive
        return self._children


class RuntimeMemoryMetricTests(unittest.TestCase):
    def test_missing_psutil_only_disables_runtime_metrics(self):
        with mock.patch.object(runtime_metrics, "psutil", None):
            with self.assertRaisesRegex(RuntimeError, "require psutil"):
                runtime_metrics.collect_runtime_memory_metrics()

    def test_backend_and_descendant_resident_memory_are_separated_without_full_scans(self):
        first_engine = FakeProcess(11, 200)
        second_engine = FakeProcess(12, 300)
        root = FakeProcess(10, 100, [first_engine, second_engine, first_engine])

        with (
            mock.patch.object(runtime_metrics.os, "getpid", return_value=10),
            mock.patch.object(runtime_metrics.psutil, "Process", return_value=root),
        ):
            metrics = runtime_metrics.collect_runtime_memory_metrics(engine_pids=(11, 12))

        self.assertTrue(root.recursive_requested)
        self.assertEqual(metrics['memoryBasis'], 'resident')
        self.assertEqual(metrics["backendResidentBytes"], 100)
        self.assertEqual(metrics["engineResidentBytes"], 500)
        self.assertEqual(metrics["engineProcessCount"], 2)

    def test_codec_process_is_not_counted_as_an_engine(self):
        root = FakeProcess(10, 100, [FakeProcess(11, 200), FakeProcess(12, 300)])
        with mock.patch.object(runtime_metrics.os, 'getpid', return_value=10), \
             mock.patch.object(runtime_metrics.psutil, 'Process', return_value=root):
            metrics = runtime_metrics.collect_runtime_memory_metrics(codec_pid=12, engine_pids=(11,))
        self.assertEqual(metrics['codecResidentBytes'], 300)
        self.assertEqual(metrics['engineResidentBytes'], 200)
        self.assertEqual(metrics['engineProcessCount'], 1)

    def test_process_families_follow_actual_owners_and_console_support_is_not_an_engine(self):
        root = FakeProcess(10, 100, [FakeProcess(11, 200), FakeProcess(12, 300),
            FakeProcess(13, 50, parent=11), FakeProcess(14, 60, parent=12), FakeProcess(15, 70)])
        with mock.patch.object(runtime_metrics.os, 'getpid', return_value=10), \
             mock.patch.object(runtime_metrics.psutil, 'Process', return_value=root):
            metrics = runtime_metrics.collect_runtime_memory_metrics(codec_pid=12, engine_pids=(11,))
        self.assertEqual(metrics['backendResidentBytes'], 170)
        self.assertEqual(metrics['engineResidentBytes'], 250)
        self.assertEqual(metrics['codecResidentBytes'], 360)
        self.assertEqual(metrics['engineProcessCount'], 2)

    def test_inaccessible_resident_memory_remains_unknown_not_zero_or_another_metric(self):
        process = FakeProcess(10, 100)
        process.memory_info = mock.Mock(side_effect=runtime_metrics.psutil.AccessDenied(10))
        self.assertIsNone(runtime_metrics._resident_memory_bytes(process))
        process.memory_info = mock.Mock(side_effect=runtime_metrics.psutil.NoSuchProcess(10))
        self.assertEqual(runtime_metrics._resident_memory_bytes(process), 0)

    def test_denied_child_inventory_does_not_invent_a_complete_process_total(self):
        root = FakeProcess(10, 100)
        root.children = mock.Mock(side_effect=runtime_metrics.psutil.AccessDenied(10))
        with mock.patch.object(runtime_metrics.psutil, 'Process', return_value=root):
            metrics = runtime_metrics.collect_runtime_memory_metrics()
        for key in ('backendResidentBytes', 'engineResidentBytes', 'codecResidentBytes', 'engineProcessCount'):
            self.assertIsNone(metrics[key])


if __name__ == "__main__":
    unittest.main()
