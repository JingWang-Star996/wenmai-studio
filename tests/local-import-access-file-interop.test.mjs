import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  PORTABLE_AGENT_ROLE_PROFILES,
  buildAgentRoleConnectionCard,
  buildPortableAgentRoleAccessFile,
} from "../app/portable-agent-access.ts";

const CLIENT_ID = "agent-client-11111111-2222-4333-8444-555555555555";
const TOKEN = `wenmai_agent_${"a".repeat(32)}_${"b".repeat(32)}`;

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseWithLocalImportScript(accessFile) {
  const importer = resolve("scripts/import-wenmai-local.ps1");
  const command = `
$source = [System.IO.File]::ReadAllText(${quotePowerShell(importer)})
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'importer parse failed' }
foreach ($name in @('Assert-ExactJsonKeys', 'Read-AccessFileCredential')) {
  $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true)
  if ($null -eq $definition) { throw "missing function: $name" }
  Invoke-Expression $definition.Extent.Text
}
$utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$canonicalOrigin = 'http://[::1]:3000'
$endpoint = "$canonicalOrigin/api/local-import/v1"
$result = Read-AccessFileCredential -Path ${quotePowerShell(accessFile)}
if ([string]$result.clientId -cne ${quotePowerShell(CLIENT_ID)}) { throw 'client id mismatch' }
Write-Output 'VALID_LOCAL_REGISTRAR_ACCESS_FILE'
`;
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: resolve("."),
    encoding: "utf8",
    windowsHide: true,
  });
}

test("TypeScript 导出的 local-registrar 文件可被 PowerShell 导入器严格读取", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wenmai-access-interop-"));
  try {
    const exportedAt = new Date();
    const profile = PORTABLE_AGENT_ROLE_PROFILES["local-registrar"];
    const connectionCard = buildAgentRoleConnectionCard({
      roleId: "local-registrar",
      origin: "http://[::1]:3000",
      label: "interop",
      clientId: CLIENT_ID,
      clientKind: "agent",
      serverRole: profile.serverRole,
      permissionPresetId: profile.permissionPresetId,
      scopes: profile.scopes,
      actionIds: profile.actionIds,
      articleIds: ["*"],
      taskIds: [],
      expiresAt: new Date(exportedAt.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    });
    const document = buildPortableAgentRoleAccessFile({ connectionCard, token: TOKEN, exportedAt: exportedAt.toISOString() });
    const accessFile = join(directory, "local-registrar.wenmai-agent.json");
    await writeFile(accessFile, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });

    const result = parseWithLocalImportScript(accessFile);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /VALID_LOCAL_REGISTRAR_ACCESS_FILE/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /wenmai_agent_[a-f0-9_]+/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
