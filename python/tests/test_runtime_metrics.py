import unittest
from types import SimpleNamespace
from unittest import mock

from rms_backend import runtime_metrics


class FakeProcess:
    def __init__(self, pid, private_bytes, children=None, *, deny_full_info=False):
        self.pid = pid
        self.private_bytes = private_bytes
        self._children = children or []
        self.deny_full_info = deny_full_info

    def memory_full_info(self):
        if self.deny_full_info:
            raise runtime_metrics.psutil.AccessDenied(self.pid)
        return SimpleNamespace(uss=self.private_bytes)

    def memory_info(self):
        return SimpleNamespace(rss=self.private_bytes)

    def children(self, recursive=False):
        self.recursive_requested = recursive
        return self._children


class RuntimeMemoryMetricTests(unittest.TestCase):
    def test_missing_psutil_only_disables_runtime_metrics(self):
        with mock.patch.object(runtime_metrics, "psutil", None):
            with self.assertRaisesRegex(RuntimeError, "require psutil"):
                runtime_metrics.collect_runtime_memory_metrics()

    def test_backend_and_descendant_private_memory_are_separated(self):
        first_engine = FakeProcess(11, 200)
        second_engine = FakeProcess(12, 300, deny_full_info=True)
        root = FakeProcess(10, 100, [first_engine, second_engine, first_engine])

        with (
            mock.patch.object(runtime_metrics.os, "getpid", return_value=10),
            mock.patch.object(runtime_metrics.psutil, "Process", return_value=root),
        ):
            metrics = runtime_metrics.collect_runtime_memory_metrics()

        self.assertTrue(root.recursive_requested)
        self.assertEqual(metrics["backendPrivateBytes"], 100)
        self.assertEqual(metrics["enginePrivateBytes"], 500)
        self.assertEqual(metrics["engineProcessCount"], 2)


if __name__ == "__main__":
    unittest.main()
