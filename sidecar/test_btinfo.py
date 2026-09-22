import unittest

from btinfo import is_radio, parse_devices, parse_uuids

INFO = """Device 00:11:22:33:44:55 (public)
\tName: UV-PRO
\tPaired: yes
\tUUID: Serial Port               (00001101-0000-1000-8000-00805f9b34fb)
\tUUID: Vendor specific           (39144315-32FA-40DB-85ED-FBFEBA2D86E6)
"""


class BtInfoTests(unittest.TestCase):
    def test_devices(self):
        self.assertEqual(
            parse_devices("Device AA:BB:CC:DD:EE:FF My Radio\nnoise\n"),
            [{"mac": "AA:BB:CC:DD:EE:FF", "name": "My Radio"}],
        )

    def test_uuids_are_lowercased(self):
        self.assertIn("39144315-32fa-40db-85ed-fbfeba2d86e6", parse_uuids(INFO))

    def test_radio_detected_by_service_not_name(self):
        self.assertTrue(is_radio(INFO))
        self.assertFalse(is_radio(INFO.replace("39144315", "00000000")))


if __name__ == "__main__":
    unittest.main()
