import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("DPAPI local-import credential can be replaced across Wenmai restarts", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wenmai-local-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const outputPath = join(directory, "local-import-operator.dpapi");
  const scriptPath = fileURLToPath(new URL("../scripts/set-wenmai-local-import-credential.ps1", import.meta.url));
  const powershell = join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  const writeCredential = (marker) => {
    const token = `wenmai_local_import_${marker.repeat(43)}`;
    const credential = {
      schemaVersion: 1,
      canonicalOrigin: "http://[::1]:3000",
      endpoint: "http://[::1]:3000/api/local-import/v1",
      bootId: `local-import-boot-${marker.repeat(22)}`,
      token,
      createdAt: new Date().toISOString(),
    };
    const result = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-OutputPath", outputPath,
    ], {
      input: JSON.stringify(credential),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return token;
  };

  const firstToken = writeCredential("A");
  const secondToken = writeCredential("B");
  const protectedBytes = await readFile(outputPath);

  assert.ok(protectedBytes.length > 0);
  assert.equal(protectedBytes.includes(Buffer.from(firstToken, "utf8")), false);
  assert.equal(protectedBytes.includes(Buffer.from(secondToken, "utf8")), false);
});
