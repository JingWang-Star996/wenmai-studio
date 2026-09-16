import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectionPath = path.join(projectRoot, "release", "public-source-selection-v1.json");
const ignoredDirectories = new Set([
  ".git", ".next", ".vinext", "coverage", "dist", "logs", "node_modules", "out", "tmp",
]);
const placeholderUsers = new Set([
  "all users", "default", "example", "public", "sample", "test", "user", "username", "yourname",
]);
const localOwnerMarker = String.fromCharCode(73, 71, 71);
const localOwnerPattern = new RegExp(`(?<![A-Za-z0-9])${localOwnerMarker}(?![A-Za-z0-9])`, "u");
const windowsUserPath = /\b[A-Za-z]:(?:\\{1,2}|\/)(?:Users|Documents and Settings)(?:\\{1,2}|\/)([^\\/\0\r\n]+)/giu;
const ipv4Literal = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/gu;
const internalSessionId = /(?<![0-9a-f])01[0-9a-f]{6}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-f])/iu;
const externalMessageId = /\bom_[a-z0-9]{20,}\b/iu;
const internalThreadPrefix = "codex:/" + "/threads/";
const privateHistoryTerms = [
  "审稿" + "包",
  "发布" + "包",
  "发布" + "版",
  "私审" + "链",
  "真实" + " message " + "ID",
  "来源" + "任务",
  "历史" + "任务",
];
const privateHistoryEvidence = new RegExp(
  `(?:${privateHistoryTerms.join("|")}).{0,160}(?:20\\d{6}|01[0-9a-f]{6}-|${"om" + "_"})`,
  "isu",
);

async function publicPaths() {
  if (existsSync(selectionPath)) {
    const selection = JSON.parse(await readFile(selectionPath, "utf8"));
    const ownEntry = selection.entries.find((entry) => entry.path === "release/public-source-selection-v1.json");
    assert.equal(ownEntry?.decision, "exclude", "release selection metadata must not publish itself");
    return selection.entries.filter((entry) => entry.decision === "include").map((entry) => entry.path);
  }

  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        found.push(path.relative(projectRoot, absolute).split(path.sep).join("/"));
      } else {
        assert.fail(`public tree contains a non-regular entry: ${path.relative(projectRoot, absolute)}`);
      }
    }
  }
  await visit(projectRoot);
  return found.sort();
}

function scanText(relativePath, text) {
  const findings = [];
  for (const match of text.matchAll(windowsUserPath)) {
    const username = match[1].trim().toLowerCase();
    const placeholder = placeholderUsers.has(username)
      || (username.startsWith("%") && username.endsWith("%"))
      || username.startsWith("$env:")
      || (username.startsWith("<") && username.endsWith(">"));
    if (!placeholder) findings.push({ path: relativePath, rule: "windows_user_path" });
  }
  for (const match of text.matchAll(ipv4Literal)) {
    const octets = match.slice(1).map(Number);
    if (octets.every((value) => value <= 255) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
      findings.push({ path: relativePath, rule: "cgnat_address_literal" });
    }
  }
  if (localOwnerPattern.test(text)) findings.push({ path: relativePath, rule: "local_owner_identity" });
  if (internalSessionId.test(text)) findings.push({ path: relativePath, rule: "internal_session_id" });
  if (externalMessageId.test(text)) findings.push({ path: relativePath, rule: "external_message_id" });
  if (text.includes(internalThreadPrefix)) findings.push({ path: relativePath, rule: "internal_thread_uri" });
  if (privateHistoryEvidence.test(text)) findings.push({ path: relativePath, rule: "private_history_evidence" });
  return findings;
}

test("public release tree contains no personal Windows path, CGNAT literal, or local owner marker", async () => {
  const findings = [];
  const paths = await publicPaths();
  assert.ok(paths.length > 0, "public tree must not be empty");
  for (const relativePath of paths) {
    const name = path.posix.basename(relativePath).toLowerCase();
    assert.ok(
      !(relativePath.startsWith("governance/") && name.includes("workflow-contract") && name.endsWith(".json") && !name.endsWith(".template.json")),
      `public tree contains an execution-bearing workflow ledger: ${relativePath}`,
    );
    const absolute = path.join(projectRoot, ...relativePath.split("/"));
    const info = await lstat(absolute);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `public entry must be a regular file: ${relativePath}`);
    const bytes = await readFile(absolute);
    if (bytes.subarray(0, 8192).includes(0)) continue;
    findings.push(...scanText(relativePath, bytes.toString("utf8")));
  }
  assert.deepEqual(findings, []);
});
