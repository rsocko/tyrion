from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

REQUIRED_FILES = (
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "docs/LICENSING-AND-PROVENANCE.md",
    "triage-app/src/app/icon.svg",
)

REMOVED_ASSETS = (
    "triage-app/src/app/favicon.ico",
    "triage-app/src/app/fonts/GeistVF.woff",
    "triage-app/src/app/fonts/GeistMonoVF.woff",
)

RETIRED_BRAND_PHRASES = (
    "a lannister always pays his debts",
    "i count, and i know things",
)

REVIEWED_NPM_LICENSES = {
    "(MIT OR CC0-1.0)",
    "(MIT OR WTFPL)",
    "(BSD-2-Clause OR MIT OR Apache-2.0)",
    "0BSD",
    "Apache-2.0",
    "Apache-2.0 AND LGPL-3.0-or-later",
    "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BlueOak-1.0.0",
    "CC-BY-4.0",
    "CC0-1.0",
    "ISC",
    "LGPL-3.0-or-later",
    "MIT",
    "MPL-2.0",
    "Python-2.0",
}


def main() -> int:
    failures: list[str] = []

    for relative in REQUIRED_FILES:
        if not (ROOT / relative).is_file():
            failures.append(f"required licensing file is missing: {relative}")

    for relative in REMOVED_ASSETS:
        if (ROOT / relative).exists():
            failures.append(f"retired scaffold asset is present: {relative}")

    for relative in ("brand", "mockups", "triage-app/src", "README.md"):
        path = ROOT / relative
        files = [path] if path.is_file() else path.rglob("*")
        for candidate in files:
            if not candidate.is_file() or candidate.suffix.lower() not in {
                ".css",
                ".html",
                ".md",
                ".ts",
                ".tsx",
            }:
                continue
            text = candidate.read_text(encoding="utf-8").lower()
            for phrase in RETIRED_BRAND_PHRASES:
                if phrase in text:
                    failures.append(
                        f"retired third-party brand phrase found in "
                        f"{candidate.relative_to(ROOT)}: {phrase}"
                    )

    for relative in (
        "kid-engine/package-lock.json",
        "finance-insights/package-lock.json",
        "triage-app/package-lock.json",
    ):
        lock = json.loads((ROOT / relative).read_text(encoding="utf-8"))
        for package_path, metadata in lock["packages"].items():
            license_expression = metadata.get("license")
            if (
                license_expression
                and license_expression not in REVIEWED_NPM_LICENSES
            ):
                failures.append(
                    f"unreviewed npm license in {relative} ({package_path or '<root>'}): "
                    f"{license_expression}"
                )
            resolved = metadata.get("resolved", "")
            if "pkgs.visualstudio.com" in resolved or "ms-feed-" in resolved:
                failures.append(
                    f"non-public npm registry in {relative} ({package_path}): {resolved}"
                )

    if failures:
        print("\n".join(failures))
        return 1

    print("License policy checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
