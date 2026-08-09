from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "monarch-bridge"
POLICY_PATH = BRIDGE / "dependency-policy.json"
LOCK_PATTERN = re.compile(
    r"^([A-Za-z0-9_.-]+)==([^ ;\\]+)"
    r"(?:\s*;\s*(.+?))?\s+\\$"
)
HASH_PATTERN = re.compile(r"^\s+--hash=sha256:([0-9a-f]{64})(?:\s+\\)?$")
PIN_PATTERN = re.compile(
    r"^([A-Za-z0-9_.-]+)(?:\[([A-Za-z0-9_.,-]+)\])?==([^ ;]+)$"
)
NAME_SEPARATOR = re.compile(r"[-_.]+")

PERMISSIVE_LICENSES = {
    "Apache-2.0",
    "Apache-2.0 AND MIT",
    "Apache-2.0 OR BSD-2-Clause",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "MIT",
    "PSF-2.0",
}
REVIEWED_LICENSE_EXCEPTIONS = {
    "autocommand": "LGPL-3.0-only",
    "certifi": "MPL-2.0",
}


def canonical_name(name: str) -> str:
    return NAME_SEPARATOR.sub("-", name).lower()


def version_key(version: str) -> tuple[int, ...]:
    parts = version.split(".")
    if not parts or any(not part.isdigit() for part in parts):
        raise ValueError(f"policy version must be numeric: {version}")
    return tuple(int(part) for part in parts)


def read_input(
    path: Path,
) -> tuple[dict[str, str], dict[str, tuple[str, ...]], list[str]]:
    pins: dict[str, str] = {}
    extras: dict[str, tuple[str, ...]] = {}
    includes: list[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-r "):
            includes.append(line[3:].strip())
            continue
        match = PIN_PATTERN.fullmatch(line)
        if not match:
            raise ValueError(f"{path.name} contains a non-exact direct requirement: {line}")
        name = canonical_name(match.group(1))
        pins[name] = match.group(3)
        if match.group(2):
            extras[name] = tuple(sorted(match.group(2).split(",")))
    return pins, extras, includes


def read_lock(
    path: Path,
) -> tuple[dict[str, str], dict[str, str], dict[str, set[str]], list[str]]:
    text = path.read_text(encoding="utf-8")
    failures: list[str] = []
    input_name = (
        "requirements-runtime.in"
        if path.name == "requirements-runtime.txt"
        else "requirements-test.in"
    )
    command = (
        f"uv pip compile {input_name} --python-version 3.12 --universal "
        f"--generate-hashes --index-url https://pypi.org/simple -o {path.name}"
    )
    if command not in text:
        failures.append(
            f"{path.name} is missing its reviewed public-PyPI generation command"
        )
    lowered = text.lower().replace("https://pypi.org/simple", "")
    for forbidden in (
        "pkgs.visualstudio.com",
        "ms-feed-",
        "--extra-index-url",
        "--find-links",
        " @ http",
        "://",
    ):
        if forbidden in lowered:
            failures.append(f"{path.name} contains a non-lock or non-public source: {forbidden}")

    pins: dict[str, str] = {}
    markers: dict[str, str] = {}
    hashes: dict[str, set[str]] = {}
    current: str | None = None
    for raw_line in text.splitlines():
        requirement = LOCK_PATTERN.match(raw_line)
        if requirement:
            current = canonical_name(requirement.group(1))
            if current in pins:
                failures.append(f"{path.name} repeats {current}")
            pins[current] = requirement.group(2)
            if requirement.group(3):
                markers[current] = requirement.group(3)
            hashes[current] = set()
            continue
        hash_match = HASH_PATTERN.match(raw_line)
        if hash_match and current:
            hashes[current].add(hash_match.group(1))
            continue
        stripped = raw_line.strip()
        if stripped and not stripped.startswith("#"):
            failures.append(f"{path.name} has unrecognized lock syntax: {stripped}")

    for name in pins:
        if not hashes[name]:
            failures.append(f"{path.name} does not hash-lock {name}")
    return pins, markers, hashes, failures


def package_versions(policy: dict, scope: str | None = None) -> dict[str, str]:
    return {
        canonical_name(name): metadata["version"]
        for name, metadata in policy["packages"].items()
        if scope is None or metadata["scope"] == scope
    }


def package_markers(policy: dict, scope: str | None = None) -> dict[str, str]:
    return {
        canonical_name(name): metadata["marker"]
        for name, metadata in policy["packages"].items()
        if "marker" in metadata and (scope is None or metadata["scope"] == scope)
    }


def artifact_hashes_sha256(hashes: set[str]) -> str:
    serialized = "\n".join(sorted(hashes)) + "\n"
    return hashlib.sha256(serialized.encode()).hexdigest()


def compare_map(label: str, actual: dict[str, str], expected: dict[str, str]) -> list[str]:
    failures: list[str] = []
    if actual == expected:
        return failures
    for name in sorted(expected.keys() - actual.keys()):
        failures.append(f"{label} is missing {name}=={expected[name]}")
    for name in sorted(actual.keys() - expected.keys()):
        failures.append(f"{label} has unexpected package {name}=={actual[name]}")
    for name in sorted(actual.keys() & expected.keys()):
        if actual[name] != expected[name]:
            failures.append(
                f"{label} has {name}=={actual[name]}, expected {expected[name]}"
            )
    return failures


def license_metadata_sha256(distribution: importlib.metadata.Distribution) -> str:
    payload = {
        "classifiers": sorted(
            value
            for value in (distribution.metadata.get_all("Classifier") or [])
            if value.startswith("License ::")
        ),
        "license": distribution.metadata.get("License") or None,
        "license_expression": distribution.metadata.get("License-Expression") or None,
    }
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode()).hexdigest()


def check_installed(
    expected: dict[str, str],
    markers: dict[str, str],
    license_metadata: dict[str, str],
) -> list[str]:
    from packaging.markers import Marker

    installed = {
        canonical_name(distribution.metadata["Name"]): distribution
        for distribution in importlib.metadata.distributions()
        if distribution.metadata["Name"]
    }
    failures: list[str] = []
    for name, version in sorted(expected.items()):
        if name in markers and not Marker(markers[name]).evaluate():
            continue
        distribution = installed.get(name)
        if distribution is None or distribution.version != version:
            observed = distribution.version if distribution else "<missing>"
            failures.append(
                f"installed environment has {name}=={observed}, expected {version}"
            )
            continue
        observed_license = license_metadata_sha256(distribution)
        if observed_license != license_metadata[name]:
            failures.append(
                f"installed {name}=={version} license metadata changed "
                f"({observed_license}, expected {license_metadata[name]})"
            )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--installed",
        action="store_true",
        help="also compare the current environment with the test lock",
    )
    args = parser.parse_args()

    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    failures: list[str] = []
    generated_with = policy["generatedWith"]
    if generated_with != {
        "index": "https://pypi.org/simple",
        "python": "3.12",
        "resolver": "uv",
        "resolverVersion": "0.12.2",
        "universal": True,
    }:
        failures.append("dependency-policy.json has unreviewed generator settings")

    runtime_expected = package_versions(policy, "runtime")
    test_only_expected = package_versions(policy, "test")
    test_expected = runtime_expected | test_only_expected
    runtime_markers = package_markers(policy, "runtime")
    test_markers = runtime_markers | package_markers(policy, "test")
    license_metadata = {
        canonical_name(name): digest
        for name, digest in policy["licenseMetadataSha256"].items()
    }
    if set(license_metadata) != set(test_expected):
        failures.append("license metadata fingerprints do not cover the locked graph")
    for name, digest in license_metadata.items():
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            failures.append(f"{name} has an invalid license metadata fingerprint")
    artifact_hashes = {
        canonical_name(name): digest
        for name, digest in policy["artifactHashesSha256"].items()
    }
    if set(artifact_hashes) != set(test_expected):
        failures.append("artifact hash fingerprints do not cover the locked graph")
    for name, digest in artifact_hashes.items():
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            failures.append(f"{name} has an invalid artifact hash fingerprint")

    runtime_input, runtime_extras, runtime_includes = read_input(
        BRIDGE / "requirements-runtime.in"
    )
    test_input, test_extras, test_includes = read_input(
        BRIDGE / "requirements-test.in"
    )
    direct_runtime = {
        name: runtime_expected[name]
        for name in map(canonical_name, policy["directRuntime"])
    }
    direct_test = {
        name: test_expected[name]
        for name in map(canonical_name, policy["directTest"])
    }
    failures.extend(compare_map("requirements-runtime.in", runtime_input, direct_runtime))
    failures.extend(compare_map("requirements-test.in", test_input, direct_test))
    expected_extras = {
        canonical_name(name): tuple(sorted(extras))
        for name, extras in policy["directExtras"].items()
    }
    if runtime_extras != expected_extras:
        failures.append(
            f"requirements-runtime.in extras are {runtime_extras}, "
            f"expected {expected_extras}"
        )
    if test_extras:
        failures.append(f"requirements-test.in has unexpected extras: {test_extras}")
    if runtime_includes:
        failures.append("requirements-runtime.in must not include another requirement file")
    if test_includes != ["requirements-runtime.in"]:
        failures.append("requirements-test.in must include only requirements-runtime.in")

    runtime_lock, locked_runtime_markers, runtime_hashes, runtime_failures = read_lock(
        BRIDGE / "requirements-runtime.txt"
    )
    test_lock, locked_test_markers, test_hashes, test_failures = read_lock(
        BRIDGE / "requirements.txt"
    )
    failures.extend(runtime_failures)
    failures.extend(test_failures)
    failures.extend(compare_map("requirements-runtime.txt", runtime_lock, runtime_expected))
    failures.extend(compare_map("requirements.txt", test_lock, test_expected))
    if locked_runtime_markers != runtime_markers:
        failures.append(
            f"requirements-runtime.txt markers are {locked_runtime_markers}, "
            f"expected {runtime_markers}"
        )
    if locked_test_markers != test_markers:
        failures.append(
            f"requirements.txt markers are {locked_test_markers}, "
            f"expected {test_markers}"
        )
    for name in sorted(runtime_expected):
        if runtime_hashes.get(name) != test_hashes.get(name):
            failures.append(f"runtime hashes differ between locks for {name}")
    for name in sorted(test_expected):
        observed = artifact_hashes_sha256(test_hashes.get(name, set()))
        if observed != artifact_hashes.get(name):
            failures.append(
                f"{name} artifact hash set changed "
                f"({observed}, expected {artifact_hashes.get(name)})"
            )

    if "pytest-asyncio" in runtime_lock or "pytest-asyncio" in test_lock:
        failures.append("unused pytest-asyncio must not be installed")
    if "anyio" not in test_input:
        failures.append("anyio must remain a direct test dependency")

    for name, metadata in policy["packages"].items():
        canonical = canonical_name(name)
        license_expression = metadata["license"]
        expected_exception = REVIEWED_LICENSE_EXCEPTIONS.get(canonical)
        if expected_exception:
            if license_expression != expected_exception:
                failures.append(
                    f"{canonical} license changed from reviewed exception "
                    f"{expected_exception} to {license_expression}"
                )
        elif license_expression not in PERMISSIVE_LICENSES:
            failures.append(f"{canonical} has unreviewed license {license_expression}")

    for name, advisory in policy["securityFloors"].items():
        canonical = canonical_name(name)
        locked = test_expected.get(canonical)
        minimum = advisory["minimum"]
        if locked is None or version_key(locked) < version_key(minimum):
            failures.append(
                f"{canonical}=={locked or '<missing>'} is below reviewed security "
                f"floor {minimum} ({', '.join(advisory['advisories'])})"
            )

    if args.installed:
        failures.extend(
            check_installed(test_expected, test_markers, license_metadata)
        )

    if failures:
        print("\n".join(failures))
        return 1
    print(
        "Python dependency policy checks passed "
        f"({len(runtime_expected)} runtime, {len(test_only_expected)} test-only)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
