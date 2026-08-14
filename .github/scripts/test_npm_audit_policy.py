from __future__ import annotations

from datetime import date
import unittest

import check_npm_audit_policy as policy


POSTCSS_INPUT = """\
let { nanoid } = require('nanoid/non-secure')
this.id = '<input css ' + nanoid(6) + '>'
"""


def reviewed_lock() -> dict:
    return {
        "packages": {
            "node_modules/nanoid": {"version": "3.3.16"},
            "node_modules/postcss": {
                "version": "8.5.25",
                "dependencies": {"nanoid": "^3.3.16"},
            },
        }
    }


def reviewed_manifest() -> dict:
    return {"overrides": {"nanoid": "3.3.16"}}


def reviewed_report() -> dict:
    return {
        "vulnerabilities": {
            "nanoid": {
                "severity": "high",
                "via": [
                    {
                        "url": policy.ALLOWED_ADVISORY,
                        "severity": "high",
                        "range": "<3.3.18",
                    }
                ],
            },
            "postcss": {"severity": "high", "via": ["nanoid"]},
            "next": {"severity": "high", "via": ["postcss"]},
        }
    }


class NpmAuditPolicyTests(unittest.TestCase):
    def test_allows_only_reviewed_transitive_advisory(self) -> None:
        self.assertEqual(
            policy.check_policy(
                reviewed_report(),
                reviewed_lock(),
                reviewed_manifest(),
                POSTCSS_INPUT,
                date(2026, 8, 9),
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
            reviewed_manifest(),
            POSTCSS_INPUT,
            date(2026, 8, 9),
        )
        self.assertTrue(any("unapproved high-severity" in item for item in failures))

    def test_rejects_changed_postcss_usage(self) -> None:
        failures = policy.check_policy(
            reviewed_report(),
            reviewed_lock(),
            reviewed_manifest(),
            "customAlphabet('abc', 0)",
            date(2026, 8, 9),
        )
        self.assertTrue(any("vulnerable Nano ID generator" in item for item in failures))

    def test_rejects_additional_nanoid_consumer(self) -> None:
        lock = reviewed_lock()
        lock["packages"]["node_modules/other"] = {
            "dependencies": {"nanoid": "3.3.16"}
        }
        failures = policy.check_policy(
            reviewed_report(),
            lock,
            reviewed_manifest(),
            POSTCSS_INPUT,
            date(2026, 8, 9),
        )
        self.assertTrue(any("consumers changed" in item for item in failures))

    def test_rejects_expired_exception(self) -> None:
        failures = policy.check_policy(
            reviewed_report(),
            reviewed_lock(),
            reviewed_manifest(),
            POSTCSS_INPUT,
            date(2026, 9, 10),
        )
        self.assertTrue(any("expired" in item for item in failures))


if __name__ == "__main__":
    unittest.main()
