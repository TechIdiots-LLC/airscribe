# Notice

The radio protocol details used here (audio channel framing, SBC parameters,
service UUID, supported model list) were read from
[HTCommander](https://github.com/Ylianst/HTCommander) (Apache-2.0,
Ylian Saint-Hilaire), including the current Dart sources (`src/lib/radio/`,
`src/linux/runner/bluetooth_classic_plugin.cc`, `docs/findings/`), and its predecessor HTCommanderLegacy, which in turn build
on the reverse-engineering by Kyle Husmann, KC3SLD
([BenLink](https://github.com/khusmann/benlink)).

`sidecar/htframe.py` reimplements the framing behaviour of `RadioAudio.cs`.
Where code is ported rather than reimplemented from a description, keep the
upstream Apache-2.0 notice on it.

This project has no LICENSE file yet; choose one before publishing.
