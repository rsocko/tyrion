from __future__ import annotations

from datetime import date
import unittest

import check_npm_audit_policy as policy


def reviewed_lock() -> dict:
    return {
        "packages": {
            "node_modules/braces": {
                "version": policy.ALLOWED_BRACES_VERSION,
                "dev": True,
            }
        }
    }


def reviewed_report() -> dict:
    return {
        "vulnerabilities": {
            "braces": {
                "severity": "high",
                "via": [
                    {
                        "url": policy.ALLOWED_ADVISORY,
                        "severity": "high",
                        "range": "<=3.0.3",
                    }
                ],
            },
            "chokidar": {"severity": "high", "via": ["braces"]},
        }
    }


class NpmAuditPolicyTests(unittest.TestCase):
    def test_allows_only_reviewed_transitive_advisory(self) -> None:
        self.assertEqual(
            policy.check_policy(
                reviewed_report(),
                reviewed_lock(),
                {},
                date(2026, 10, 9),
                allow_braces_exception=True,
            ),
            [],
        )

    def test_rejects_an_unapproved_advisory(self) -> None:
        report = reviewed_report()
        report["vulnerabilities"]["other"] = {
            "severity": "critical",
            "via": [{"url": "https://example.invalid/GHSA-unapproved"}],
        }
        failures = policy.check_policy(
            report,
            reviewed_lock(),
            {},
            date(2026, 10, 9),
            allow_braces_exception=True,
        )
        self.assertTrue(any("unapproved high-severity" in item for item in failures))

    def test_rejects_runtime_or_direct_braces_dependency(self) -> None:
        lock = reviewed_lock()
        lock["packages"]["node_modules/braces"]["dev"] = False
        failures = policy.check_policy(
            reviewed_report(),
            lock,
            {"dependencies": {"braces": "3.0.3"}},
            date(2026, 10, 9),
            allow_braces_exception=True,
        )
        self.assertTrue(any("development-only" in item for item in failures))
        self.assertTrue(any("indirect development dependency" in item for item in failures))

    def test_rejects_changed_braces_version(self) -> None:
        lock = reviewed_lock()
        lock["packages"]["node_modules/braces"]["version"] = "3.0.4"
        failures = policy.check_policy(
            reviewed_report(),
            lock,
            {},
            date(2026, 10, 9),
            allow_braces_exception=True,
        )
        self.assertTrue(any("reviewed exception version" in item for item in failures))

    def test_rejects_expired_exception(self) -> None:
        failures = policy.check_policy(
            reviewed_report(),
            reviewed_lock(),
            {},
            date(2026, 11, 10),
            allow_braces_exception=True,
        )
        self.assertTrue(any("expired" in item for item in failures))

    def test_rejects_malformed_audit_metadata(self) -> None:
        self.assertEqual(
            policy.check_policy(
                {},
                reviewed_lock(),
                {},
                date(2026, 10, 9),
                allow_braces_exception=True,
            ),
            ["npm audit report lacks vulnerability metadata"],
        )


if __name__ == "__main__":
    unittest.main()
