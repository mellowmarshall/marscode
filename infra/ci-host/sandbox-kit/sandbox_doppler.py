#!/usr/bin/env python3
"""What sandbox-kit reads from Doppler, on stdin, never in argv (private-repo).

  sandbox_doppler.py names [--declaration PATH]
      stdin: `doppler secrets --only-names --json`. Exit 1, with one line per name, when the
      config's names differ from the fleet shape's configs.sbx (required and optional).
  sandbox_doppler.py headers ID_NAME SECRET_NAME
      stdin: `doppler secrets download --format json`. stdout: the two Cloudflare Access
      header lines for curl's -H @file. Nothing else of the download is printed.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sandbox_declaration


def name_drift(actual, required, optional) -> list[str]:
    """One line per name on one side only. Doppler's own DOPPLER_* names do not count."""
    have = {name for name in actual if not name.startswith("DOPPLER_")}
    required, optional = set(required), set(optional)
    problems = [f"{name} is in Doppler and not declared" for name in sorted(have - required - optional)]
    problems += [f"{name} is declared required and not in Doppler" for name in sorted(required - have)]
    return problems


def access_headers(secrets: dict, id_name: str, secret_name: str) -> str:
    missing = [n for n in (id_name, secret_name) if not secrets.get(n)]
    if missing:
        raise sandbox_declaration.DeclarationError(f"Doppler has no value for {', '.join(missing)}")
    return f"CF-Access-Client-Id: {secrets[id_name]}\nCF-Access-Client-Secret: {secrets[secret_name]}\n"


def main(argv: list[str]) -> int:
    args = list(argv)
    if args[:1] == ["headers"] and len(args) == 3:
        sys.stdout.write(access_headers(json.load(sys.stdin), args[1], args[2]))
        return 0
    if args[:1] == ["names"]:
        path = os.environ.get("SANDBOX_KIT_DECLARATION") or sandbox_declaration.DEFAULT_DECLARATION
        if args[1:2] == ["--declaration"] and len(args) == 3:
            path = args[2]
        elif len(args) != 1:
            print(__doc__.strip(), file=sys.stderr)
            return 2
        doppler = sandbox_declaration.load(path)["doppler"]
        problems = name_drift(json.load(sys.stdin), doppler["required"], doppler["optional"])
        if problems:
            print("\n".join(problems))
            return 1
        return 0
    print(__doc__.strip(), file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (sandbox_declaration.DeclarationError, json.JSONDecodeError) as exc:
        print(f"sandbox-kit: {exc}", file=sys.stderr)
        sys.exit(1)
