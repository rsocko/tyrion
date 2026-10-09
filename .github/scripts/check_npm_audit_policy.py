from __future__ import annotations

from datetime import date
import json
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
PROJECT_NAMES = ("finance-insights", "kid-engine", "triage-app")
ALLOWED_ADVISORY = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm"
ALLOWED_BRACES_VERSION = "3.0.3"
EXCEPTION_EXPIRES = date(2026, 11, 9)


def _advisory_roots(
    package_name: str,
    vulnerabilities: dict[str, Any],
    visiting: frozenset[str] = frozenset(),
) -> tuple[set[str], list[str]]:
    if package_name in visiting:
        return set(), [f"{package_name}: cyclic audit dependency"]

    metadata = vulnerabilities.get(package_name)
    if not isinstance(metadata, dict):
        return set(), [f"{package_name}: missing audit metadata"]

    roots: set[str] = set()
    failures: list[str] = []
    for cause in metadata.get("via", []):
        if isinstance(cause, str):
            nested_roots, nested_failures = _advisory_roots(
                cause, vulnerabilities, visiting | {package_name}
            )
            roots.update(nested_roots)
            failures.extend(nested_failures)
        elif isinstance(cause, dict) and isinstance(cause.get("url"), str):
            roots.add(cause["url"])
        else:
            failures.append(f"{package_name}: malformed audit cause")
    return roots, failures


def check_policy(
    report: dict[str, Any],
    lock: dict[str, Any],
    manifest: dict[str, Any],
    today: date,
    allow_braces_exception: bool = False,
) -> list[str]:
    failures: list[str] = []
    if allow_braces_exception and today > EXCEPTION_EXPIRES:
        failures.append(
            f"temporary braces exception expired on {EXCEPTION_EXPIRES.isoformat()}"
        )

    if allow_braces_exception:
        if "braces" in manifest.get("dependencies", {}) or "braces" in manifest.get(
            "devDependencies", {}
        ):
            failures.append("braces must remain an indirect development dependency")

        braces_entries = [
            (package_path, metadata)
            for package_path, metadata in lock.get("packages", {}).items()
            if package_path.endswith("node_modules/braces")
        ]
        if not braces_entries:
            failures.append("reviewed braces dependency is missing from the lock")
        for package_path, metadata in braces_entries:
            if metadata.get("version") != ALLOWED_BRACES_VERSION:
                failures.append(
                    f"{package_path}: braces version is not the reviewed exception version"
                )
            if metadata.get("dev") is not True:
                failures.append(
                    f"{package_path}: braces must remain development-only"
                )

    vulnerabilities = report.get("vulnerabilities")
    if not isinstance(vulnerabilities, dict):
        return failures + ["npm audit report lacks vulnerability metadata"]

    high_or_critical = {
        name: metadata
        for name, metadata in vulnerabilities.items()
        if isinstance(metadata, dict)
        and metadata.get("severity") in {"high", "critical"}
    }

    observed_allowed_root = False
    for package_name in high_or_critical:
        roots, root_failures = _advisory_roots(package_name, vulnerabilities)
        failures.extend(root_failures)
        if allow_braces_exception and roots == {ALLOWED_ADVISORY}:
            observed_allowed_root = True
        else:
            failures.append(
                f"{package_name}: unapproved high-severity advisory roots "
                f"{sorted(roots)}"
            )

    if allow_braces_exception:
        braces_causes = vulnerabilities.get("braces", {}).get("via", [])
        matching_causes = [
            cause
            for cause in braces_causes
            if isinstance(cause, dict) and cause.get("url") == ALLOWED_ADVISORY
        ]
        if len(matching_causes) != 1:
            failures.append("braces audit entry does not match the approved advisory")
        elif (
            matching_causes[0].get("range") != "<=3.0.3"
            or matching_causes[0].get("severity") != "high"
        ):
            failures.append("braces advisory metadata changed")
        if not observed_allowed_root:
            failures.append("approved braces advisory was not present in npm audit output")

    return failures


def check_project(project_name: str, npm: str) -> list[str]:
    project_root = ROOT / project_name
    lock = json.loads((project_root / "package-lock.json").read_text(encoding="utf-8"))
    manifest = json.loads((project_root / "package.json").read_text(encoding="utf-8"))
    try:
        result = subprocess.run(
            [npm, "audit", "--json"],
            cwd=project_root,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired):
        return [f"{project_name}: npm audit could not be completed"]
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError:
        return [f"{project_name}: npm audit did not return valid JSON"]

    return [
        f"{project_name}: {failure}"
        for failure in check_policy(
            report,
            lock,
            manifest,
            date.today(),
            allow_braces_exception=project_name == "triage-app",
        )
    ]


def main() -> int:
    requested_projects = tuple(sys.argv[1:]) or PROJECT_NAMES
    unknown_projects = sorted(set(requested_projects) - set(PROJECT_NAMES))
    if unknown_projects:
        print(f"unknown npm audit projects: {', '.join(unknown_projects)}", file=sys.stderr)
        return 1

    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if npm is None:
        print("npm executable was not found", file=sys.stderr)
        return 1

    failures: list[str] = []
    for project_name in requested_projects:
        failures.extend(check_project(project_name, npm))
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1

    print(
        "npm advisory policy passed with the temporary development-only braces "
        f"exception through {EXCEPTION_EXPIRES.isoformat()}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
