from __future__ import annotations

import unittest

import check_npm_audit_policy as policy


def vulnerable_report() -> dict:
    return {
        "vulnerabilities": {
            "nanoid": {
                "severity": "high",
                "via": [
                    {
                        "url": "https://github.com/advisories/GHSA-example",
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
    def test_allows_a_report_without_high_or_critical_advisories(self) -> None:
        report = {
            "vulnerabilities": {
                "example": {
                    "severity": "moderate",
                    "via": [{"url": "https://example.invalid/GHSA-moderate"}],
                }
            }
        }
        self.assertEqual(policy.check_policy(report), [])

    def test_rejects_every_high_or_critical_advisory(self) -> None:
        report = vulnerable_report()
        report["vulnerabilities"]["other"] = {
            "severity": "critical",
            "via": [{"url": "https://example.invalid/GHSA-unapproved"}],
        }
        failures = policy.check_policy(report)
        self.assertTrue(any("nanoid: high-severity" in item for item in failures))
        self.assertTrue(any("postcss: high-severity" in item for item in failures))
        self.assertTrue(any("other: high-severity" in item for item in failures))

    def test_rejects_malformed_audit_metadata(self) -> None:
        self.assertEqual(
            policy.check_policy({}),
            ["npm audit report lacks vulnerability metadata"],
        )


if __name__ == "__main__":
    unittest.main()
