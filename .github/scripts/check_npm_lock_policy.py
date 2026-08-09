from __future__ import annotations

import json
from pathlib import Path
import re
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[2]
LOCKFILES = (
    ROOT / "kid-engine" / "package-lock.json",
    ROOT / "triage-app" / "package-lock.json",
)
PUBLIC_NPM_HOST = "registry.npmjs.org"


def check_lock(path: Path) -> list[str]:
    failures: list[str] = []
    lock = json.loads(path.read_text(encoding="utf-8"))

    for package_path, metadata in lock.get("packages", {}).items():
        is_registry_package = package_path.startswith("node_modules/") and not metadata.get(
            "link"
        )
        integrity = metadata.get("integrity")
        if is_registry_package and (
            not isinstance(integrity, str)
            or not re.match(r"^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$", integrity)
        ):
            failures.append(
                f"{package_path}: registry package lacks integrity"
            )

        resolved = metadata.get("resolved")
        if resolved is None:
            continue
        if not isinstance(resolved, str):
            failures.append(f"{package_path or '<root>'}: resolved must be a string")
            continue

        parsed = urlparse(resolved)
        if not parsed.scheme:
            if not metadata.get("link"):
                failures.append(
                    f"{package_path or '<root>'}: non-URL resolved value is not a local link"
                )
            continue

        if (
            parsed.scheme != "https"
            or parsed.hostname != PUBLIC_NPM_HOST
            or parsed.port is not None
            or parsed.username is not None
            or parsed.password is not None
        ):
            failures.append(
                f"{package_path or '<root>'}: resolved URL is not the public npm registry"
            )
            continue

    return failures


def main() -> int:
    failures: list[str] = []
    for lockfile in LOCKFILES:
        for failure in check_lock(lockfile):
            failures.append(f"{lockfile.relative_to(ROOT)}: {failure}")

    if failures:
        print("\n".join(failures))
        return 1

    print("npm lock portability policy checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
