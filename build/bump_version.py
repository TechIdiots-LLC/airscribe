#!/usr/bin/env python3

"""Bump the version in package.json (and package-lock.json) and roll the
"## master" section of CHANGELOG.md into a new version section. Used by the
bump-version job (.gitlab/scripts/bump.ps1); merging its merge request
releases the version (.gitlab-ci.yml). Based on garage-lxc's and tippr's.

usage: python build/bump_version.py <patch|minor|major|prepatch|preminor|premajor|prerelease> [preid]

Prints the new version, and writes version=... to $GITHUB_OUTPUT when it is set.
"""
import json
import os
import re
import sys

PACKAGE = "package.json"
LOCK = "package-lock.json"
CHANGELOG = "CHANGELOG.md"
MASTER_SECTION = "\n".join([
    "## master",
    "### ✨ Features and improvements",
    "- _...Add new stuff here..._",
    "",
    "### 🐞 Bug fixes",
    "- _...Add new stuff here..._",
    "",
    "",
])


def read_text(path):
    raw = open(path, "rb").read()
    newline = "\r\n" if b"\r\n" in raw else "\n"
    return raw.decode("utf-8-sig").replace("\r\n", "\n"), newline


def write_text(path, text, newline):
    with open(path, "w", encoding="utf-8", newline=newline) as f:
        f.write(text)


def write_json(path, data, newline):
    # As npm writes it: two-space indent and a final newline
    write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n", newline)


def bump(current, kind, preid):
    pre = re.match(r"^(\d+)\.(\d+)\.(\d+)-(.+?)\.(\d+)$", current)
    rel = re.match(r"^(\d+)\.(\d+)\.(\d+)$", current)
    if pre:
        major, minor, patch = (int(pre.group(i)) for i in (1, 2, 3))
        pre_tag, pre_num, is_pre = pre.group(4), int(pre.group(5)), True
    elif rel:
        major, minor, patch = (int(rel.group(i)) for i in (1, 2, 3))
        pre_tag, pre_num, is_pre = None, 0, False
    else:
        raise SystemExit("unrecognised version %r in %s" % (current, PACKAGE))

    if kind == "patch":
        return "%d.%d.%d" % (major, minor, patch if is_pre else patch + 1)
    if kind == "minor":
        return "%d.%d.0" % (major, minor if is_pre and patch == 0 else minor + 1)
    if kind == "major":
        return "%d.0.0" % (major if is_pre and minor == patch == 0 else major + 1)
    if kind == "prepatch":
        return "%d.%d.%d-%s.1" % (major, minor, patch + 1, preid)
    if kind == "preminor":
        return "%d.%d.0-%s.1" % (major, minor + 1, preid)
    if kind == "premajor":
        return "%d.0.0-%s.1" % (major + 1, preid)
    if kind == "prerelease":
        if is_pre:
            return "%d.%d.%d-%s.%d" % (major, minor, patch, pre_tag, pre_num + 1)
        return "%d.%d.%d-%s.1" % (major, minor, patch + 1, preid)
    raise SystemExit("unknown bump type %r" % kind)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    kind = sys.argv[1]
    preid = sys.argv[2].strip() if len(sys.argv) > 2 and sys.argv[2].strip() else "rc"

    text, newline = read_text(PACKAGE)
    package = json.loads(text)
    current = package["version"]
    new_version = bump(current, kind, preid)
    print("%s -> %s" % (current, new_version))
    package["version"] = new_version
    write_json(PACKAGE, package, newline)

    if os.path.exists(LOCK):
        text, lock_newline = read_text(LOCK)
        lock = json.loads(text)
        lock["version"] = new_version
        if "" in lock.get("packages", {}):
            lock["packages"][""]["version"] = new_version
        write_json(LOCK, lock, lock_newline)

    if os.path.exists(CHANGELOG):
        changelog, cl_newline = read_text(CHANGELOG)
    else:
        changelog, cl_newline = "# Changelog\n\n", newline
    if "## master" not in changelog:
        raise SystemExit("CHANGELOG.md has no \"## master\" section to release")
    changelog = changelog.replace("## master", "## " + new_version, 1)
    changelog = changelog.replace("- _...Add new stuff here..._\n", "")
    title = re.match(r"^(# .+?\n\n)", changelog)
    head, rest = ((title.group(1), changelog[len(title.group(1)):]) if title
                  else ("# Changelog\n\n", changelog))
    write_text(CHANGELOG, head + MASTER_SECTION + rest, cl_newline)

    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write("version=%s\n" % new_version)


if __name__ == "__main__":
    main()
