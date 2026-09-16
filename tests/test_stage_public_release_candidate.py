import hashlib, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

TOOL = Path(__file__).parents[1] / "scripts" / "stage-public-release-candidate.py"

class StageCandidateTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory(); self.root = Path(self.td.name) / "repo"; self.root.mkdir()
        subprocess.run(["git","init","-q",str(self.root)], check=True)
        (self.root / "src").mkdir(); (self.root / "src" / "ok.txt").write_text("ordinary source\n", encoding="utf-8")
        self.selection = self.root / "qa" / "selection.json"; self.selection.parent.mkdir()
    def tearDown(self): self.td.cleanup()
    def write_selection(self, entries=None):
        if entries is None:
            files = sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob("*") if p.is_file() and ".git" not in p.parts)
            files.append("qa/selection.json"); files=sorted(set(files))
            entries=[{"path":p,"decision":"include","reasonCode":"public_source"} for p in files]
        self.selection.write_text(json.dumps({"schema":"grc.public-release-source-selection/v1","entries":entries},ensure_ascii=False),encoding="utf-8")
        return hashlib.sha256(self.selection.read_bytes()).hexdigest()
    def invoke(self, stage=None, expected=None, extra=()):
        expected = expected or self.write_selection(); stage = stage or (Path(self.td.name) / "stage")
        return subprocess.run([sys.executable,"-B",str(TOOL),"--repo-root",str(self.root),"--selection",str(self.selection),"--stage-root",str(stage),"--expected-selection-sha256",expected,"--recorded-at-utc","2026-08-28T00:00:00Z",*extra],capture_output=True,text=True)
    def test_happy_path_and_deterministic_digest(self):
        sha=self.write_selection(); a=self.invoke(Path(self.td.name)/"a",sha); b=self.invoke(Path(self.td.name)/"b",sha)
        self.assertEqual(a.returncode,0,a.stderr); self.assertEqual(json.loads(a.stdout)["stageFileTreeDigest"],json.loads(b.stdout)["stageFileTreeDigest"])
        self.assertEqual((Path(self.td.name)/"a"/"src"/"ok.txt").read_bytes(),(self.root/"src"/"ok.txt").read_bytes())
    def test_missing_hash_and_universe_drift_fail_closed(self):
        self.assertNotEqual(self.invoke(expected="A"*64).returncode,0)
        sha=self.write_selection(); (self.root/"new.txt").write_text("new")
        self.assertNotEqual(self.invoke(expected=sha).returncode,0)
    def test_exclude_and_forbidden_include(self):
        sha=self.write_selection([{"path":"qa/selection.json","decision":"exclude","reasonCode":"private_release_metadata"},{"path":"src/ok.txt","decision":"include","reasonCode":"public_source"}])
        self.assertEqual(self.invoke(expected=sha).returncode,0)
        (self.root/"D1").mkdir(); (self.root/"D1"/"state.txt").write_text("x")
        sha=self.write_selection(); self.assertNotEqual(self.invoke(expected=sha).returncode,0)
    def test_artifacts_directory_include_fails_closed(self):
        (self.root/"artifacts").mkdir(); (self.root/"artifacts"/"execution-envelope.json").write_text("{}", encoding="utf-8")
        sha=self.write_selection(); result=self.invoke(expected=sha)
        self.assertNotEqual(result.returncode,0)
        self.assertIn("selection includes forbidden path", result.stderr)
    def test_non_secret_env_template_is_allowed_but_runtime_env_is_forbidden(self):
        (self.root/".env.example").write_text("API_KEY=\n", encoding="utf-8")
        sha=self.write_selection(); result=self.invoke(expected=sha)
        self.assertEqual(result.returncode,0,result.stderr)
        (self.root/".env.local").write_text("API_KEY=not-a-real-secret\n", encoding="utf-8")
        sha=self.write_selection(); result=self.invoke(Path(self.td.name)/"runtime-env-stage",sha)
        self.assertNotEqual(result.returncode,0)
        self.assertIn("selection includes forbidden path", result.stderr)
    def test_traversal_case_duplicate_and_stage_guards(self):
        sha=self.write_selection([{"path":"../x","decision":"include","reasonCode":"x"}]); self.assertNotEqual(self.invoke(expected=sha).returncode,0)
        entries=[{"path":"qa/selection.json","decision":"include","reasonCode":"x"},{"path":"src/OK.txt","decision":"include","reasonCode":"x"},{"path":"src/ok.txt","decision":"include","reasonCode":"x"}]
        sha=self.write_selection(entries); self.assertNotEqual(self.invoke(expected=sha).returncode,0)
        sha=self.write_selection(); self.assertNotEqual(self.invoke(self.root/"stage",sha).returncode,0)
        occupied=Path(self.td.name)/"occupied"; occupied.mkdir(); self.assertNotEqual(self.invoke(occupied,sha).returncode,0)
    def test_secret_literal_redaction_and_source_alias(self):
        (self.root/"src"/"variables.ts").write_text('const token = issuedClient.token;\nconst apiKey = "DEEPSEEK_API_KEY";\nconst secret = "PRIVATE_DETAILS_SENTINEL";\n', encoding="utf-8")
        secret_value = "really" * 5
        (self.root/"src"/"secret.txt").write_text(f'token = "{secret_value}"')
        sha=self.write_selection(); result=self.invoke(expected=sha); self.assertNotEqual(result.returncode,0); self.assertNotIn("reallyreally",result.stderr)
        sha=self.write_selection(); result=self.invoke(expected=sha,extra=("--forbidden-literal","ordinary source")); self.assertNotEqual(result.returncode,0); self.assertNotIn("ordinary source",result.stderr)
        if hasattr(os,"symlink"):
            try:
                (self.root/"src"/"link.txt").symlink_to(self.root/"src"/"ok.txt")
            except OSError:
                return
            sha=self.write_selection(); self.assertNotEqual(self.invoke(expected=sha).returncode,0)

    def test_personal_windows_paths_and_cgnat_literals_fail_closed(self):
        separator = chr(92)
        rejected = {
            "windows-single": "C:" + separator + "Users" + separator + "alice" + separator + "notes.txt",
            "windows-double": "D:" + separator * 2 + "Users" + separator * 2 + "bob" + separator * 2 + "notes.txt",
            "cgnat-low": ".".join(("100", "64", "0", "0")),
            "cgnat-high": ".".join(("100", "127", "255", "255")),
        }
        fixture = self.root / "src" / "privacy.txt"
        for label, value in rejected.items():
            fixture.write_text(value, encoding="utf-8")
            sha = self.write_selection()
            result = self.invoke(Path(self.td.name) / label, sha)
            self.assertNotEqual(result.returncode, 0, label)
            self.assertNotIn(value, result.stderr)

    def test_placeholder_paths_and_cgnat_boundaries_are_allowed(self):
        separator = chr(92)
        allowed = [
            "C:" + separator + "Users" + separator + "example" + separator + "notes.txt",
            "C:" + separator * 2 + "Users" + separator * 2 + "Public" + separator * 2 + "notes.txt",
            ".".join(("100", "63", "255", "255")),
            ".".join(("100", "128", "0", "0")),
        ]
        (self.root / "src" / "privacy.txt").write_text("\n".join(allowed), encoding="utf-8")
        sha = self.write_selection()
        result = self.invoke(Path(self.td.name) / "allowed-privacy-placeholders", sha)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_internal_history_identifiers_and_dated_artifacts_fail_closed(self):
        session_id = "01" + "9abcde" + "-1234-7abc-8def-1234567890ab"
        message_id = "om_" + "x" * 32
        rejected = {
            "session-id": session_id,
            "message-id": message_id,
            "thread-uri": "codex:/" + "/threads/" + session_id,
            "dated-artifact": "审稿" + "包_" + "20" + "260812",
        }
        fixture = self.root / "src" / "history.txt"
        for label, value in rejected.items():
            fixture.write_text(value, encoding="utf-8")
            sha = self.write_selection()
            result = self.invoke(Path(self.td.name) / label, sha)
            self.assertNotEqual(result.returncode, 0, label)
            self.assertNotIn(value, result.stderr)

    def test_execution_bearing_workflow_ledger_is_not_public_source(self):
        governance = self.root / "governance"
        governance.mkdir()
        (governance / "example-workflow-contract.json").write_text("{}", encoding="utf-8")
        sha = self.write_selection()
        result = self.invoke(Path(self.td.name) / "workflow-ledger", sha)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("selection includes forbidden path", result.stderr)

if __name__ == "__main__": unittest.main()
