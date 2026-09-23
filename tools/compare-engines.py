#!/usr/bin/env python3
"""Compare what each engine made of the same transmissions.

Answers the question a benchmark cannot: which model is better *on this
channel's* noise. Radio traffic is compressed, band-limited and full of
squelch tails, and a model that scores well on clean speech may simply be
more willing to invent words when there are none.

Needs `alsoRun` configured so more than one engine has heard the same clips.

    python3 tools/compare-engines.py http://localhost:8100 <token>
    python3 tools/compare-engines.py http://localhost:8100 <token> --show 20

Read-only: it fetches from the API and prints.
"""

import argparse
import json
import re
import urllib.request

# Whisper emits these instead of words when it hears something that is not
# speech. They are honest, but they are also the shape hallucination takes:
# a model that never emits them may be inventing sentences instead.
ANNOTATION = re.compile(r"^\s*[\[(*][^\])*]*[\])*]?\s*$")
# Phrases Whisper falls back on when fed noise, from its training data.
STOCK = {"thank you.", "thanks for watching!", "you", "bye.", "thank you", "."}


def fetch(base, token, path):
    req = urllib.request.Request(
        f"{base.rstrip('/')}/api{path}", headers={"authorization": f"Bearer {token}"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def classify(text):
    t = (text or "").strip()
    if not t:
        return "empty"
    if ANNOTATION.match(t):
        return "annotation"
    if t.lower() in STOCK:
        return "stock phrase"
    return "words"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="server URL, e.g. http://localhost:8100")
    ap.add_argument("token", help="an API token")
    ap.add_argument("--limit", type=int, default=500, help="transmissions to fetch")
    ap.add_argument("--show", type=int, default=8, help="clips to print side by side")
    args = ap.parse_args()

    rows = fetch(args.base, args.token, f"/transmissions?limit={args.limit}")
    engines = sorted({t["engine"] for r in rows for t in r.get("transcripts", [])})
    if len(engines) < 2:
        raise SystemExit(
            f"only {engines or 'no engines'} have transcribed anything.\n"
            "Set stt.alsoRun so a second engine hears the same clips, then\n"
            "let some traffic through - or run transcribe-missing for it."
        )

    print(f"{len(rows)} transmissions, engines: {', '.join(engines)}\n")
    print(f"{'engine':<16} {'clips':>6} {'words':>7} {'empty':>7} {'annot':>7} "
          f"{'stock':>7} {'trunc':>6} {'wds/sec':>8}")
    for e in engines:
        got = [(r["duration_ms"] / 1000, t["text"])
               for r in rows for t in r.get("transcripts", [])
               if t["engine"] == e and t["status"] == "done"]
        if not got:
            continue
        kinds = [classify(txt) for _, txt in got]
        spoken = [(d, txt) for (d, txt), k in zip(got, kinds) if k == "words"]
        wps = sorted(len(txt.split()) / d for d, txt in spoken if d > 0)
        # A long clip reduced to a couple of words: the model stopped early.
        # This is the opposite of hallucinating, and it loses more.
        trunc = sum(1 for d, txt in got if d >= 5 and len((txt or "").split()) <= 3)
        print(f"{e:<16} {len(got):>6} {kinds.count('words'):>7} "
              f"{kinds.count('empty'):>7} {kinds.count('annotation'):>7} "
              f"{kinds.count('stock phrase'):>7} {trunc:>6} "
              f"{(wps[len(wps)//2] if wps else 0):>8.2f}")

    print("\n'annot' and 'stock' are the model declining to guess, or guessing")
    print("badly. On a scanner feed those columns matter as much as 'words':")
    print("a model with none of either may simply be inventing speech instead.")

    # Longest clips first: disagreement shows up most where there is most to say.
    both = [r for r in rows if len({t["engine"] for t in r.get("transcripts", [])}) > 1]
    both.sort(key=lambda r: -r["duration_ms"])
    print(f"\n--- {min(args.show, len(both))} longest clips heard by more than one engine ---")
    for r in both[: args.show]:
        print(f"\n[{r['duration_ms'] / 1000:.1f}s] transmission {r['id']}")
        for t in sorted(r["transcripts"], key=lambda x: x["engine"]):
            body = (t["text"] or "").strip() if t["status"] == "done" else f"<{t['status']}>"
            print(f"  {t['engine']:<14} {body[:100]}")


if __name__ == "__main__":
    main()
