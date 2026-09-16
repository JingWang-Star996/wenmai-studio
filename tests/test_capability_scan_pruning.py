from __future__ import annotations
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("index_capabilities", ROOT / "scripts" / "index_capabilities.py")
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)

class CapabilityScanPruningTests(unittest.TestCase):
    def test_project_discovery_prunes_excluded_directories_before_walk(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "visible").mkdir()
            (root / "visible" / "workflow.md").write_text("ok", encoding="utf-8")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "workflow.md").write_text("blocked", encoding="utf-8")
            names = [path.relative_to(root).as_posix() for path in module.project_files(root)]
            self.assertEqual(names, ["visible/workflow.md"])

if __name__ == "__main__":
    unittest.main()
