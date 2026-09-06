import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import desktop_app as desktop


class LifecycleTests(unittest.TestCase):
    def service(self, data):
        return patch.object(desktop.urllib.request, 'urlopen', return_value=io.StringIO(json.dumps(data)))

    def test_owned_backend(self):
        process = Mock(pid=123)
        process.poll.return_value = None
        with self.service({'desktop_instance': 'ours', 'pid': 123}):
            self.assertTrue(desktop.wait_for_service(process, 'ours'))

    def test_old_or_foreign_backend_rejected(self):
        for data in ({'status': 'ready'}, {'desktop_instance': 'other', 'pid': 123}, {'desktop_instance': 'ours', 'pid': 456}):
            process = Mock(pid=123)
            process.poll.return_value = None
            with self.service(data), self.assertRaises(RuntimeError):
                desktop.wait_for_service(process, 'ours')

    def test_dead_child_rejected(self):
        process = Mock()
        process.poll.return_value = 1
        with self.assertRaises(RuntimeError):
            desktop.wait_for_service(process, 'ours')

    def test_cleanup_owned_child(self):
        process = Mock(returncode=0)
        process.poll.return_value = None
        desktop.stop_backend(process)
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)

    def test_cleanup_on_startup_failure(self):
        process = Mock()
        with patch.object(desktop, 'configure_environment'), patch.object(desktop.subprocess, 'Popen', return_value=process), patch.object(desktop, 'wait_for_service', side_effect=RuntimeError('conflict')), patch.object(desktop, 'stop_backend') as stop:
            with self.assertRaises(RuntimeError):
                desktop.launch_desktop()
            stop.assert_called_once_with(process)

    def test_single_instance_and_release(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(desktop, 'DATA_ROOT', Path(directory)):
            with desktop.single_instance():
                with self.assertRaises(RuntimeError):
                    with desktop.single_instance():
                        self.fail('Duplicate instance accepted')
            with desktop.single_instance():
                pass


if __name__ == '__main__':
    unittest.main()
