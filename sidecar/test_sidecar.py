import sys
import threading
import unittest
from unittest import mock

import airscribe_sidecar as sidecar


class FakeLink:
    """Stands in for bluez.RadioLink: records being opened and closed."""

    made = []

    def __init__(self, mac, emit, **_kw):
        self.mac = mac
        self.stop = threading.Event()
        self.closed = False
        FakeLink.made.append(self)

    def open(self):
        pass

    def close(self):
        self.closed = True
        self.stop.set()


class BluezBackendTests(unittest.TestCase):
    def setUp(self):
        FakeLink.made = []
        patches = [
            mock.patch.object(sidecar, "RadioLink", FakeLink),
            mock.patch.object(sidecar, "_bluetoothctl", lambda *a: ""),
            mock.patch.object(sidecar.sbc, "find_decoder", lambda: "ffmpeg"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.backend = sidecar.BluezBackend()

    def test_a_live_link_is_not_opened_twice(self):
        self.backend.connect("38:D2:00:01:56:51")
        self.backend.connect("38:D2:00:01:56:51")
        self.assertEqual(len(FakeLink.made), 1)

    def test_a_link_that_gave_up_is_replaced_on_the_next_connect(self):
        # What the server's retry does after "radio stopped responding"
        self.backend.connect("38:D2:00:01:56:51")
        first = FakeLink.made[0]
        first.stop.set()
        self.backend.connect("38:D2:00:01:56:51")
        self.assertEqual(len(FakeLink.made), 2, "the retry must open a new link")
        self.assertTrue(first.closed, "and release the old one's sockets")
        self.assertIs(self.backend.links["38:D2:00:01:56:51"], FakeLink.made[1])


class ShutdownTests(unittest.TestCase):
    def test_a_second_signal_during_shutdown_does_not_cut_it_short(self):
        # Stopping the service: systemd's SIGTERM and the server's arrive
        # together, and the second handler runs inside the first
        calls = []

        class SlowBackend:
            def shutdown(backend_self):
                calls.append("releasing")
                self.assertFalse(shutdown(), "the second signal must not start another")
                calls.append("released")

        shutdown = sidecar.Shutdown(SlowBackend())
        self.assertTrue(shutdown())
        self.assertEqual(calls, ["releasing", "released"])
        self.assertFalse(shutdown(), "and end of input after it does nothing")


class EmitTests(unittest.TestCase):
    def test_a_message_after_the_server_has_gone_is_dropped_not_raised(self):
        class Gone:
            def write(self, _text):
                raise BrokenPipeError(32, "Broken pipe")

            def flush(self):
                raise BrokenPipeError(32, "Broken pipe")

        real = sys.stdout
        sys.stdout = Gone()
        try:
            sidecar.emit({"event": "status", "mac": "38:D2:00:01:56:51", "state": "disconnected"})
            sidecar.emit({"event": "status", "mac": "38:D2:00:01:56:51", "state": "disconnected"})
        finally:
            if sys.stdout is not real:
                try:
                    sys.stdout.close()
                except Exception:
                    pass
            sys.stdout = real


if __name__ == "__main__":
    unittest.main()
