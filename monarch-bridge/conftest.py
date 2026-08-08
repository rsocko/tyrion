"""Isolate deterministic tests from developer configuration and sessions."""

import os
import tempfile
from pathlib import Path


TEST_STATE = Path(tempfile.gettempdir()) / f"tyrion-bridge-tests-{os.getpid()}"

os.environ["BRIDGE_HOST"] = "127.0.0.1"
os.environ["BRIDGE_LOAD_DOTENV"] = "false"
os.environ["DEMO_MODE"] = "true"
os.environ["SESSION_FILE"] = str(TEST_STATE / "session.json")
