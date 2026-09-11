from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
PROJECT_NAMES = ("finance-insights", "kid-engine", "triage-app")


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
) -> list[str]:
    vulnerabilities = report.get("vulnerabilities")
    if not isinstance(vulnerabilities, dict):
        return ["npm audit report lacks vulnerability metadata"]

    high_or_critical = {
        name: metadata
        for name, metadata in vulnerabilities.items()
        if isinstance(metadata, dict)
        and metadata.get("severity") in {"high", "critical"}
    }

    failures: list[str] = []
    for package_name in high_or_critical:
        roots, root_failures = _advisory_roots(package_name, vulnerabilities)
        failures.extend(root_failures)
        failures.append(
            f"{package_name}: high-severity advisory roots {sorted(roots)}"
        )

    return failures


def check_project(project_name: str, npm: str) -> list[str]:
    project_root = ROOT / project_name
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
        for failure in check_policy(report)
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

    print("npm advisory policy passed with no high or critical vulnerabilities.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
