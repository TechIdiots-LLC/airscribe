"""When encrypting with a kept pairing fails: forgotten only if the scanner refused it, kept if the link was lost.

A stand-in connection and key store, so these need neither Bumble nor a dongle. On the real SDS150 a lost link
(0x08, connection timeout) was taken for a refusal and the pairing forgotten; the scanner, still holding its side,
then turned away every new pairing.
"""
import asyncio
import unittest

import bumble_link

MAC = "DE:B8:5F:BA:05:56"


class Keys:
    ltk = b"\x01" * 16
    ltk_central = None


class KeyStore:
    def __init__(self):
        self.keys = {MAC: Keys()}

    async def get(self, name):
        return self.keys.get(name)

    async def delete(self, name):
        self.keys.pop(name, None)


class Device:
    def __init__(self):
        self.keystore = KeyStore()
        self.connections = {}


class Conn:
    """A link that ends with `reason` as encryption starts."""

    def __init__(self, device, reason):
        self.device = device
        self.reason = reason
        self.handle = 0x47
        self.peer_address = MAC
        self.is_encrypted = False
        self.airscribe_reasons = []
        device.connections[self.handle] = self

    async def encrypt(self):
        await asyncio.sleep(0.01)
        del self.device.connections[self.handle]
        self.airscribe_reasons.append(self.reason)
        raise asyncio.CancelledError()      # as Bumble cancels what's waiting when a link drops

    async def pair(self):
        raise AssertionError("not paired afresh on a link that's gone")


def secure(reason):
    stack = bumble_link.BumbleStack.__new__(bumble_link.BumbleStack)   # no loop or dongle: only _secure_le
    stack.device = Device()
    conn = Conn(stack.device, reason)
    try:
        asyncio.run(stack._secure_le(conn, MAC))
    except RuntimeError as e:
        return str(e), stack.device.keystore.keys
    raise AssertionError("expected it to fail")


class KeptPairingTests(unittest.TestCase):
    def test_a_lost_link_keeps_the_pairing(self):
        error, keys = secure(0x08)
        self.assertIn(MAC, keys, "kept: the scanner still has its side")
        self.assertIn("dropped while encrypting", error)
        self.assertIn("0x08", error)

    def test_the_scanner_ending_it_forgets_the_pairing(self):
        error, keys = secure(0x13)
        self.assertNotIn(MAC, keys, "forgotten: it was reset, and the next try pairs afresh")
        self.assertIn("refused the pairing", error)

    def test_a_reason_is_named(self):
        self.assertTrue(bumble_link.reason_name(0x08).startswith("0x08"))


if __name__ == "__main__":
    unittest.main()
