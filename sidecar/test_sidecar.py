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


if __name__ == "__main__":
    unittest.main()
