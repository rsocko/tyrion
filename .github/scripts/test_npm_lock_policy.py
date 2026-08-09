from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import check_npm_lock_policy as policy


def write_lock(directory: str, packages: dict[str, dict[str, object]]) -> Path:
    path = Path(directory) / "package-lock.json"
    path.write_text(
        json.dumps({"lockfileVersion": 3, "packages": packages}),
        encoding="utf-8",
    )
    return path


class NpmLockPolicyTests(unittest.TestCase):
    def test_allows_absent_resolved_and_public_registry_integrity(self) -> None:
        with TemporaryDirectory() as directory:
            lock = write_lock(
                directory,
                {
                    "": {},
                    "node_modules/no-resolved": {
                        "integrity": "sha512-synthetic",
                    },
                    "node_modules/example": {
                        "resolved": "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
                        "integrity": "sha512-synthetic",
                    },
                    "node_modules/local": {
                        "resolved": "../local",
                        "link": True,
                    },
                },
            )
            self.assertEqual(policy.check_lock(lock), [])

    def test_rejects_unexpected_hosts_and_public_packages_without_integrity(self) -> None:
        with TemporaryDirectory() as directory:
            lock = write_lock(
                directory,
                {
                    "node_modules/private": {
                        "resolved": "https://packages.example.invalid/private.tgz",
                        "integrity": "sha512-synthetic",
                    },
                    "node_modules/unverified": {
                        "resolved": "https://registry.npmjs.org/unverified/-/unverified-1.0.0.tgz",
                    },
                },
            )
            failures = policy.check_lock(lock)
            self.assertEqual(len(failures), 2)
            self.assertIn("not the public npm registry", failures[0])
            self.assertIn("lacks integrity", failures[1])

    def test_rejects_non_url_values_without_link_metadata(self) -> None:
        with TemporaryDirectory() as directory:
            lock = write_lock(
                directory,
                {
                    "node_modules/example": {
                        "resolved": "../unexpected",
                        "integrity": "sha512-synthetic",
                    }
                },
            )
            self.assertEqual(len(policy.check_lock(lock)), 1)

    def test_rejects_registry_package_without_integrity_when_resolved_is_absent(
        self,
    ) -> None:
        with TemporaryDirectory() as directory:
            lock = write_lock(
                directory,
                {"node_modules/example": {"version": "1.0.0"}},
            )
            self.assertEqual(len(policy.check_lock(lock)), 1)


if __name__ == "__main__":
    unittest.main()
