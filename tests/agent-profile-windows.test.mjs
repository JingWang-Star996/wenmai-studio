import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const powershell = join(
  process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const saveScript = fileURLToPath(new URL("../scripts/save-wenmai-agent-profile.ps1", import.meta.url));
const invokeScript = fileURLToPath(new URL("../scripts/invoke-wenmai-agent-profile.ps1", import.meta.url));

function run(script, args, input = "") {
  return spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    ...args,
  ], {
    input,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("Windows DPAPI Agent profile never returns or stores plaintext Key and requires explicit replacement", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wenmai-agent-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const profileName = "codex-feishu-test";
  const clientId = "agent-client-11111111-2222-4333-8444-555555555555";
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const firstToken = `wenmai_agent_${"a".repeat(32)}_${"b".repeat(32)}`;
  const secondToken = `wenmai_agent_${"c".repeat(32)}_${"d".repeat(32)}`;
  const commonArgs = [
    "-ProfileName", profileName,
    "-Transport", "local",
    "-ClientId", clientId,
    "-ExpiresAt", expiresAt,
    "-CredentialRoot", directory,
    "-TokenFromStdin",
  ];

  const first = run(saveScript, commonArgs, `${firstToken}\n`);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstEnvelope = JSON.parse(first.stdout.trim());
  assert.equal(firstEnvelope.ok, true);
  assert.equal(firstEnvelope.profileName, profileName);
  assert.equal(firstEnvelope.secretReturned, false);
  assert.equal(first.stdout.includes(firstToken), false);
  assert.equal(first.stderr.includes(firstToken), false);

  const profilePath = join(directory, `${profileName}.dpapi`);
  const firstProtected = await readFile(profilePath);
  assert.ok(firstProtected.length > 0);
  assert.equal(firstProtected.includes(Buffer.from(firstToken, "utf8")), false);

  const status = run(invokeScript, [
    "-ProfileName", profileName,
    "-Mode", "ProfileStatus",
    "-CredentialRoot", directory,
  ]);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  const statusEnvelope = JSON.parse(status.stdout.trim());
  assert.deepEqual({
    ok: statusEnvelope.ok,
    profileName: statusEnvelope.profileName,
    clientId: statusEnvelope.clientId,
    effectiveStatus: statusEnvelope.effectiveStatus,
    secretReturned: statusEnvelope.secretReturned,
  }, {
    ok: true,
    profileName,
    clientId,
    effectiveStatus: "active",
    secretReturned: false,
  });
  assert.equal(status.stdout.includes(firstToken), false);

  const forbiddenAdminBridge = run(invokeScript, [
    "-ProfileName", profileName,
    "-Mode", "AdminAction",
    "-Action", "decide_approval",
    "-CommandId", "admin-forbidden-1",
    "-PayloadJson", "{}",
    "-CredentialRoot", directory,
  ]);
  assert.notEqual(forbiddenAdminBridge.status, 0);
  assert.match(forbiddenAdminBridge.stderr, /only accepts create_task, update_task, or cancel_task/i);
  assert.equal(forbiddenAdminBridge.stdout.includes(firstToken), false);
  assert.equal(forbiddenAdminBridge.stderr.includes(firstToken), false);

  const forbiddenSuperAdminBridge = run(invokeScript, [
    "-ProfileName", profileName,
    "-Mode", "SuperAdminAction",
    "-Action", "issue_client",
    "-CommandId", "super-admin-forbidden-1",
    "-PayloadJson", "{}",
    "-CredentialRoot", directory,
  ]);
  assert.notEqual(forbiddenSuperAdminBridge.status, 0);
  assert.match(
    forbiddenSuperAdminBridge.stderr,
    /SuperAdminAction only accepts[\s\S]*publish-capability\s*-consume allowlist/i,
  );
  assert.equal(forbiddenSuperAdminBridge.stdout.includes(firstToken), false);
  assert.equal(forbiddenSuperAdminBridge.stderr.includes(firstToken), false);

  const accidentalOverwrite = run(saveScript, commonArgs, `${secondToken}\n`);
  assert.notEqual(accidentalOverwrite.status, 0);
  assert.match(accidentalOverwrite.stderr, /already exists/i);
  assert.equal(accidentalOverwrite.stderr.includes(secondToken), false);

  const replacement = run(saveScript, [...commonArgs, "-ReplaceExisting"], `${secondToken}\n`);
  assert.equal(replacement.status, 0, replacement.stderr || replacement.stdout);
  const secondProtected = await readFile(profilePath);
  assert.equal(secondProtected.includes(Buffer.from(firstToken, "utf8")), false);
  assert.equal(secondProtected.includes(Buffer.from(secondToken, "utf8")), false);
  assert.notDeepEqual(secondProtected, firstProtected);

  const invalidName = run(saveScript, [
    "-ProfileName", "../escape",
    "-Transport", "local",
    "-ClientId", clientId,
    "-ExpiresAt", expiresAt,
    "-CredentialRoot", directory,
    "-TokenFromStdin",
  ], `${firstToken}\n`);
  assert.notEqual(invalidName.status, 0);
  assert.equal(invalidName.stderr.includes(firstToken), false);
});
