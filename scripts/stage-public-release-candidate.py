#!/usr/bin/env python3
"""Create a byte-for-byte, isolated public-release candidate.  It never uses git write commands."""
from __future__ import annotations

import argparse, hashlib, json, os, re, shutil, stat, subprocess, sys
from pathlib import Path, PurePosixPath

MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
SCHEMA = "grc.public-release-source-selection/v1"
PRIVATE_KEY = b"-----BEGIN "
TOKEN_PATTERNS = [
    ("pem_private_key_header", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("github_token", re.compile(rb"(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("aws_access_key", re.compile(rb"(?:AKIA|ASIA)[A-Z0-9]{16}")),
    ("sensitive_assignment", re.compile(rb"(?i:\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*)(?:'(?![A-Z0-9_]{16,}')[A-Za-z0-9_./+=-]{16,}'|\"(?![A-Z0-9_]{16,}\")[A-Za-z0-9_./+=-]{16,}\")")),
]
WINDOWS_USER_PATH = re.compile(
    rb"(?i)\b[a-z]:(?:\\{1,2}|/)(?:users|documents and settings)(?:\\{1,2}|/)([^\\/\x00\r\n]+)"
)
IPV4_LITERAL = re.compile(
    rb"(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])"
)
PLACEHOLDER_USERS = {
    b"all users", b"default", b"example", b"public", b"sample", b"test", b"user", b"username", b"yourname",
}
INTERNAL_SESSION_ID = re.compile(
    rb"(?i)(?<![0-9a-f])01[0-9a-f]{6}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-f])"
)
EXTERNAL_MESSAGE_ID = re.compile(rb"(?i)\bom_[a-z0-9]{20,}\b")
INTERNAL_THREAD_URI = b"codex:/" + b"/threads/"
PRIVATE_HISTORY_TERMS = [
    "审稿" + "包",
    "发布" + "包",
    "发布" + "版",
    "私审" + "链",
    "真实" + " message " + "ID",
    "来源" + "任务",
    "历史" + "任务",
]
PRIVATE_HISTORY_TEXT = re.compile(
    (
        "(?:" + "|".join(re.escape(term) for term in PRIVATE_HISTORY_TERMS) + ")"
        + r".{0,160}(?:20\d{6}|01[0-9a-f]{6}-|" + ("om" + "_") + ")"
    ).encode("utf-8"),
    re.I | re.S,
)

class GateError(Exception): pass

def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""): h.update(block)
    return h.hexdigest()

def is_reparse(path: Path) -> bool:
    info = os.lstat(path)
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )

def assert_regular(path: Path, label: str, *, one_link=True) -> os.stat_result:
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or is_reparse(path) or (one_link and info.st_nlink != 1):
        raise GateError(f"{label} is not a single-link ordinary file: {path}")
    return info

def safe_rel(raw: object) -> str:
    if not isinstance(raw, str) or not raw or "\\" in raw or ":" in raw or raw.startswith(("/", "//")):
        raise GateError("unsafe selection path")
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", raw) or any(p in ("", ".", "..") for p in raw.split("/")):
        raise GateError("unsafe selection path")
    if any(part.upper() in {"CON", "PRN", "AUX", "NUL", "COM1", "LPT1"} for part in raw.split("/")):
        raise GateError("unsafe selection path")
    return raw

def prohibited(path: str) -> bool:
    p = path.lower()
    name = p.rsplit("/", 1)[-1]
    prefixes = (".git/", ".local-owner/", ".wrangler/", "d1/", "node_modules/", ".next/", "coverage/", "dist/", "out/", "artifacts/", ".artifacts/", "logs/", "tmp/", "tests/generated/")
    safe_env_template = name == ".env.example" or (name.startswith(".env.") and name.endswith(".example"))
    private_workflow_ledger = (
        p.startswith("governance/") and "workflow-contract" in name and name.endswith(".json")
        and not name.endswith(".template.json")
    )
    return (p.startswith(prefixes) or private_workflow_ledger or (name.startswith(".env") and not safe_env_template) or
            name.endswith((".pem", ".key", ".p12", ".pfx", ".db")) or ".sqlite" in name)

def git_universe(root: Path) -> list[str]:
    got = subprocess.run(["git", "-c", f"safe.directory={root}", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"], capture_output=True)
    if got.returncode: raise GateError("git ls-files failed")
    try: return [x.decode("utf-8") for x in got.stdout.split(b"\0") if x]
    except UnicodeDecodeError as e: raise GateError("universe path is not UTF-8") from e

def canonical_digest(items: list[tuple[str,str]]) -> str:
    h = hashlib.sha256()
    for path, digest in items:
        h.update(path.encode("utf-8")); h.update(b"\0"); h.update(digest.encode("ascii")); h.update(b"\n")
    return h.hexdigest()

def scan_blob(path: str, blob: bytes, forbidden_literals: list[str]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for rule, pattern in TOKEN_PATTERNS:
        if pattern.search(blob): findings.append({"path": path, "rule": rule})
    for match in WINDOWS_USER_PATH.finditer(blob):
        username = match.group(1).strip().lower()
        is_placeholder = (
            username in PLACEHOLDER_USERS
            or (username.startswith(b"%") and username.endswith(b"%"))
            or username.startswith(b"$env:")
            or (username.startswith(b"<") and username.endswith(b">"))
        )
        if not is_placeholder:
            findings.append({"path": path, "rule": "windows_user_path"})
    for match in IPV4_LITERAL.finditer(blob):
        octets = tuple(int(part) for part in match.groups())
        if all(part <= 255 for part in octets) and octets[0] == 100 and 64 <= octets[1] <= 127:
            findings.append({"path": path, "rule": "cgnat_address_literal"})
    if INTERNAL_SESSION_ID.search(blob):
        findings.append({"path": path, "rule": "internal_session_id"})
    if EXTERNAL_MESSAGE_ID.search(blob):
        findings.append({"path": path, "rule": "external_message_id"})
    if INTERNAL_THREAD_URI in blob:
        findings.append({"path": path, "rule": "internal_thread_uri"})
    if PRIVATE_HISTORY_TEXT.search(blob):
        findings.append({"path": path, "rule": "private_history_evidence"})
    for literal in forbidden_literals:
        if literal.encode("utf-8") in blob:
            findings.append({"path": path, "rule": "forbidden_literal"})
    return findings

def load_selection(path: Path, expected: str) -> tuple[dict, list[dict]]:
    if not re.fullmatch(r"[0-9a-f]{64}", expected or ""): raise GateError("expected selection SHA-256 must be 64 lowercase hex")
    assert_regular(path, "selection")
    actual = sha_file(path)
    if actual != expected: raise GateError("selection SHA-256 mismatch")
    try: data = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e: raise GateError("selection is not valid UTF-8 JSON") from e
    if not isinstance(data, dict) or data.get("schema") != SCHEMA or not isinstance(data.get("entries"), list): raise GateError("invalid selection schema")
    entries = data["entries"]
    seen, folded, prior = set(), set(), ""
    for item in entries:
        if not isinstance(item, dict) or set(item) != {"path", "decision", "reasonCode"}: raise GateError("selection entry shape invalid")
        p = safe_rel(item["path"])
        if item["decision"] not in ("include", "exclude") or not isinstance(item["reasonCode"], str) or not item["reasonCode"]: raise GateError("selection entry invalid")
        if p in seen or p.casefold() in folded or (prior and p <= prior): raise GateError("selection has duplicate, case alias, or is not UTF-8 sorted")
        seen.add(p); folded.add(p.casefold()); prior = p
    return data, entries

def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", required=True); ap.add_argument("--selection", required=True)
    ap.add_argument("--stage-root", required=True); ap.add_argument("--expected-selection-sha256", required=True)
    ap.add_argument("--recorded-at-utc", required=True); ap.add_argument("--forbidden-literal", action="append", default=[])
    ns = ap.parse_args(argv)
    try:
        root = Path(ns.repo_root).resolve(strict=True); selection = Path(ns.selection).resolve(strict=True); stage = Path(ns.stage_root)
        if not root.is_dir() or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", ns.recorded_at_utc): raise GateError("repo root or recorded-at-utc invalid")
        if selection.parent != root / selection.relative_to(root).parent: raise GateError("selection must be inside repo")
        stage_lexical = stage.absolute()
        stage_resolved = stage.resolve(strict=False)
        if stage.exists() or root == stage_resolved or root in stage_resolved.parents or stage_resolved in root.parents: raise GateError("stage must not exist, must be outside repo, and must not contain repo")
        if any(is_reparse(p) for p in stage_lexical.parents if p.exists()): raise GateError("stage parent contains reparse point")
        data, entries = load_selection(selection, ns.expected_selection_sha256)
        universe = git_universe(root)
        for p in universe: safe_rel(p)
        actual = set(universe); listed = {e["path"] for e in entries}
        if actual != listed: raise GateError("selection does not exactly cover git universe")
        if selection.relative_to(root).as_posix() not in listed: raise GateError("selection must include itself")
        includes = [e["path"] for e in entries if e["decision"] == "include"]
        excludes = [e["path"] for e in entries if e["decision"] == "exclude"]
        if any(prohibited(p) for p in includes): raise GateError("selection includes forbidden path")
        source = []
        for p in includes:
            fp = root / p; info = assert_regular(fp, "source")
            if info.st_size > MAX_FILE: raise GateError("source file exceeds 16 MiB")
            source.append((p, sha_file(fp), info.st_size))
        if sum(x[2] for x in source) > MAX_TOTAL: raise GateError("source total exceeds 64 MiB")
        stage.mkdir(parents=False)
        if is_reparse(stage) or stage.resolve(strict=True) != stage_resolved: raise GateError("stage target changed during creation")
        literal_hashes = [hashlib.sha256(x.encode("utf-8")).hexdigest() for x in ns.forbidden_literal]
        findings=[]; tree=[]
        for p, before, size in source:
            dest = stage / p; dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / p, dest)
            assert_regular(dest, "staged")
            after = sha_file(dest)
            if after != before: raise GateError("copy hash mismatch")
            blob = dest.read_bytes()
            findings.extend(scan_blob(p, blob, ns.forbidden_literal))
            tree.append((p, after))
        if findings: raise GateError("stage secret scan found prohibited content")
        # Detect source/selection/tool drift after copying and make the receipt deterministic apart from recordedAt.
        if sha_file(selection) != ns.expected_selection_sha256: raise GateError("selection drifted during staging")
        if any(sha_file(root / p) != digest for p, digest, _ in source): raise GateError("source drifted during staging")
        tool = Path(__file__).resolve(); assert_regular(tool, "tool")
        receipt = {"schema":"grc.public-release-stage-receipt/v1", "recordedAtUtc":ns.recorded_at_utc,
          "valid":True,"stageOnly":True,"applied":False,"selectionSha256":ns.expected_selection_sha256,
          "includeCount":len(includes),"excludeCount":len(excludes),"sourceSnapshotDigest":canonical_digest([(p,d) for p,d,_ in source]),
          "stageFileTree":[{"path":p,"sha256":d} for p,d in tree], "stageFileTreeDigest":canonical_digest(tree),
          "toolDiskSnapshot":{"path":tool.name,"sha256":sha_file(tool)}, "forbiddenLiteralSha256":literal_hashes,
          "limitations":["Not a Git commit or history", "Not a secret-free guarantee", "No behavior, browser, DB, GitHub, or public claim"]}
        print(json.dumps(receipt, ensure_ascii=False, separators=(",",":")))
        return 0
    except (GateError, OSError, ValueError) as e:
        print(json.dumps({"valid":False,"stageOnly":True,"applied":False,"error":str(e)}, separators=(",",":")), file=sys.stderr)
        return 2

if __name__ == "__main__": raise SystemExit(main())
