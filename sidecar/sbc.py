"""Turning the radio's SBC audio into PCM.

The radio sends SBC (32 kHz, mono, 16 blocks, 8 subbands, loudness, bitpool
18 on receive). Everything downstream wants 16-bit PCM, so something has to
decode it, and Python has nothing built in.

**Decoding happens once per transmission, not continuously.** The radio
brackets each transmission with an end-of-audio frame, so the SBC for a whole
run can be collected and decoded in one go when the run closes. That avoids a
long-lived decoder process and its buffering, and costs nothing that matters:
a transmission is seconds long and its audio is wanted for transcription, not
for live listening. A 15-second run is about 165 kB of SBC.

ffmpeg is the decoder because it is already the likely dependency for encoding
podcast enclosures, and because binding libsbc through ctypes would mean
pinning a C struct layout that upstream is free to change.
"""

import shutil
import subprocess

# From the stream's own SBC header, confirmed on a real UV-Pro.
SAMPLE_RATE = 32000
FRAME_BYTES = 44
FRAME_SAMPLES = 128


def find_decoder():
    """Locate an SBC-capable ffmpeg.

    Returns the executable's path, or None. Presence is not enough: ffmpeg can
    be built without the SBC decoder, and that failure would otherwise only
    appear on the first transmission.
    """
    exe = shutil.which("ffmpeg")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "-hide_banner", "-decoders"],
                             capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return exe if any(line.split()[1:2] == ["sbc"] for line in out.splitlines()
                      if len(line.split()) > 1) else None


def decode(sbc_bytes, exe="ffmpeg", rate=SAMPLE_RATE):
    """Decode a run of SBC frames to 16-bit little-endian mono PCM.

    :param sbc_bytes: Concatenated SBC frames, as taken from the audio channel.
    :param exe: The ffmpeg executable to use.
    :param rate: Output sample rate; the radio's own rate by default.
    :returns: PCM bytes. Empty input gives empty output.
    :raises RuntimeError: If ffmpeg fails, carrying the tail of its stderr.
    """
    if not sbc_bytes:
        return b""
    cmd = [exe, "-hide_banner", "-loglevel", "error",
           "-f", "sbc", "-i", "pipe:0",
           "-f", "s16le", "-acodec", "pcm_s16le",
           "-ar", str(rate), "-ac", "1", "pipe:1"]
    try:
        p = subprocess.run(cmd, input=sbc_bytes, capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        raise RuntimeError(f"ffmpeg could not be run: {e}") from e
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg exited {p.returncode}: "
                           f"{p.stderr.decode('utf-8', 'replace').strip()[-300:]}")
    return p.stdout


def expected_pcm_bytes(sbc_len):
    """How much PCM a given amount of SBC should produce.

    Used to sanity-check a decode: a mismatch means the frames were not what
    the header said they were.
    :param sbc_len: Length of the SBC input in bytes.
    :returns: Expected PCM length in bytes.
    """
    return (sbc_len // FRAME_BYTES) * FRAME_SAMPLES * 2
