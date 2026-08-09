import tempfile
import unittest
from pathlib import Path

import check_python_dependency_policy as policy


LOCK_HEADER = (
    "# uv pip compile requirements-test.in --python-version 3.12 --universal "
    "--generate-hashes --index-url https://pypi.org/simple -o requirements.txt\n"
)
HASH = "a" * 64


class PythonDependencyPolicyTests(unittest.TestCase):
    def test_direct_input_preserves_reviewed_extras(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "requirements.in"
            path.write_text(
                "uvicorn[standard,testing]==0.52.1\n", encoding="utf-8"
            )

            pins, extras, includes = policy.read_input(path)

        self.assertEqual(pins, {"uvicorn": "0.52.1"})
        self.assertEqual(extras, {"uvicorn": ("standard", "testing")})
        self.assertEqual(includes, [])

    def test_lock_preserves_platform_marker_and_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "requirements.txt"
            path.write_text(
                LOCK_HEADER
                + "demo==1.2.3 ; sys_platform == 'win32' \\\n"
                + f"    --hash=sha256:{HASH}\n",
                encoding="utf-8",
            )

            pins, markers, hashes, failures = policy.read_lock(path)

        self.assertEqual(pins, {"demo": "1.2.3"})
        self.assertEqual(markers, {"demo": "sys_platform == 'win32'"})
        self.assertEqual(hashes, {"demo": {HASH}})
        self.assertEqual(failures, [])

    def test_lock_rejects_trailing_requirement_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "requirements.txt"
            path.write_text(
                LOCK_HEADER
                + "demo==1.2.3 unexpected \\\n"
                + f"    --hash=sha256:{HASH}\n",
                encoding="utf-8",
            )

            pins, _markers, _hashes, failures = policy.read_lock(path)

        self.assertEqual(pins, {})
        self.assertTrue(
            any("unrecognized lock syntax" in failure for failure in failures)
        )

    def test_lock_requires_reviewed_public_index_command(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "requirements.txt"
            path.write_text(
                "# uv pip compile requirements-test.in --python-version 3.12 "
                "--universal --generate-hashes -o requirements.txt\n"
                + "demo==1.2.3 \\\n"
                + f"    --hash=sha256:{HASH}\n",
                encoding="utf-8",
            )

            _pins, _markers, _hashes, failures = policy.read_lock(path)

        self.assertTrue(
            any("public-PyPI generation command" in failure for failure in failures)
        )


if __name__ == "__main__":
    unittest.main()
