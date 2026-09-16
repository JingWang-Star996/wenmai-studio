from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.index_corpus import Document, collect_manifest_evidence, discover_documents, requires_isolated_aux_identity


class ExplicitMappingResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.package = self.root / "package"
        for directory in ("research", "articles", "deliverables", "qa/scrubbed", "work/pre_scrub"):
            (self.package / directory).mkdir(parents=True)
        self.manifest = self.package / "research" / "mapping.json"
        self.manifest.write_text("[]", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def declaration(self, source: str = "article.md", docx: str = "article.docx") -> dict[str, object]:
        _, declarations = collect_manifest_evidence(
            self.manifest, [{"source": source, "docx": docx}], self.root,
        )
        return declarations[0]

    def test_unique_role_paths_ignore_qa_and_work_copies(self) -> None:
        (self.package / "articles" / "article.md").write_text("source", encoding="utf-8")
        for directory in ("deliverables", "qa/scrubbed", "work/pre_scrub"):
            (self.package / directory / "article.docx").write_bytes(directory.encode())
        declaration = self.declaration()
        self.assertEqual(declaration["sourcePathCandidates"], ["package/deliverables/article.docx"])
        self.assertEqual(declaration["targetPathCandidates"], ["package/articles/article.md"])
        self.assertTrue(declaration["explicitUniquePathMapping"])
        self.assertFalse(declaration["weakMapping"])

    def test_multiple_deliverables_remain_suggested(self) -> None:
        (self.package / "articles" / "article.md").write_text("source", encoding="utf-8")
        for directory in ("deliverables/a", "deliverables/b"):
            (self.package / directory).mkdir(parents=True)
            (self.package / directory / "article.docx").write_bytes(directory.encode())
        declaration = self.declaration()
        self.assertEqual(len(declaration["sourcePathCandidates"]), 2)
        self.assertFalse(declaration["explicitUniquePathMapping"])
        self.assertTrue(declaration["weakMapping"])

    def test_missing_side_never_confirms(self) -> None:
        (self.package / "deliverables" / "article.docx").write_bytes(b"docx")
        declaration = self.declaration(source="missing.md")
        self.assertEqual(declaration["targetPathCandidates"], [])
        self.assertFalse(declaration["explicitUniquePathMapping"])
        self.assertTrue(declaration["weakMapping"])

    def test_development_worktrees_are_excluded_from_documents_and_metadata(self) -> None:
        normal = self.root / "library"
        worktree = self.root / ".wenmai-worktrees" / "feature"
        normal.mkdir(parents=True)
        worktree.mkdir(parents=True)
        body = "# 可索引文章\n\n" + "这是用于验证语料发现边界的正文。" * 16
        (normal / "article.md").write_text(body, encoding="utf-8")
        (normal / "metadata.json").write_text(
            '{"title":"可索引文章","status":"draft"}', encoding="utf-8",
        )
        (worktree / "article.md").write_text(body, encoding="utf-8")
        (worktree / "metadata.json").write_text(
            '{"title":"工作树副本","status":"draft"}', encoding="utf-8",
        )

        documents, metadata, _, _ = discover_documents(self.root, self.root / "wenmai-studio")
        document_paths = {document.relative_path for document in documents}
        metadata_paths = {entry["path"] for entry in metadata}
        self.assertIn("library/article.md", document_paths)
        self.assertIn("library/metadata.json", metadata_paths)
        self.assertFalse(any(path.startswith(".wenmai-worktrees/") for path in document_paths))
        self.assertFalse(any(path.startswith(".wenmai-worktrees/") for path in metadata_paths))

    def test_isolated_auxiliary_identity_accepts_windows_path_separator(self) -> None:
        document = Document(
            path=Path("qa\\naturalness.md"),
            relative_path="qa\\naturalness.md",
            title="中文自然度扫描报告",
            canonical_key="qa/naturalness",
            text="",
            format="markdown",
            kind="研究与治理",
            role="qa",
            platforms=[],
            tags=[],
            entities=[],
            metrics={},
            digest="digest",
            modified_at="",
            size_bytes=0,
            metadata_files=[],
            metadata={},
            metadata_records=[],
        )

        self.assertTrue(requires_isolated_aux_identity(document))


if __name__ == "__main__":
    unittest.main()
