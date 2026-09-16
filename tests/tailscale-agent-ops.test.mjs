import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function sources() {
  const paths = {
    status: new URL("../scripts/status-wenmai-tailscale-agent.ps1", import.meta.url),
    enable: new URL("../scripts/enable-wenmai-tailscale-agent.ps1", import.meta.url),
    disable: new URL("../scripts/disable-wenmai-tailscale-agent.ps1", import.meta.url),
    enableCmd: new URL("../启用文脉Tailscale Agent.cmd", import.meta.url),
    disableCmd: new URL("../关闭文脉Tailscale Agent.cmd", import.meta.url),
  };
  return Object.fromEntries(await Promise.all(
    Object.entries(paths).map(async ([key, url]) => [key, await readFile(url, "utf8")]),
  ));
}

function windowsPath(relative) {
  return decodeURIComponent(new URL(relative, root).pathname).replace(/^\/(?:([A-Za-z]):)/, "$1:").replaceAll("/", "\\");
}

test("Tailscale Agent wrappers preserve exit codes and call only the bounded helpers", async () => {
  const { enableCmd, disableCmd } = await sources();
  for (const cmd of [enableCmd, disableCmd]) {
    assert.ok([...cmd].every((character) => character.codePointAt(0) < 128), "CMD contents must remain ASCII for cmd.exe reliability");
    assert.match(cmd, /set "WENMAI_TAILSCALE_EXIT=%ERRORLEVEL%"/);
    assert.match(cmd, /exit \/b %WENMAI_TAILSCALE_EXIT%/);
    assert.match(cmd, /Try Run as administrator|Start-Process -FilePath 'powershell\.exe' -Verb RunAs/);
  }
  assert.match(enableCmd, /scripts\\enable-wenmai-tailscale-agent\.ps1/);
  assert.match(disableCmd, /scripts\\disable-wenmai-tailscale-agent\.ps1/);
});

test("operations expose only the fixed Agent gateway and never proxy port 3000 directly", async () => {
  const { status, enable, disable } = await sources();
  assert.match(status, /WenmaiGatewayHost = "127\.0\.0\.1"/);
  assert.match(status, /WenmaiGatewayPort = 43180/);
  assert.match(status, /WenmaiGatewayHealthPath = "\/_wenmai\/agent-gateway\/health"/);
  assert.match(status, /WenmaiServeTarget = \$script:WenmaiGatewayOrigin/);
  assert.match(status, /WenmaiAgentPath = "\/api\/agent\/v1"/);
  assert.match(enable, /"serve", "--bg", "--https=443", \$script:WenmaiServeTarget/);
  assert.doesNotMatch(enable, /"serve"[^\r\n]+(?:\[::1\]|127\.0\.0\.1):3000/);
  assert.doesNotMatch(`${status}\n${enable}\n${disable}`, /serve[^\r\n]+reset/i);
  assert.doesNotMatch(`${status}\n${enable}\n${disable}`, /--set-path/);
});

test("Serve ownership is exact, conflicts fail closed, and disable never performs a broad reset", async () => {
  const { status, enable, disable } = await sources();
  assert.match(status, /function Test-WenmaiServeConfigExact/);
  assert.match(status, /Test-WenmaiExactPropertySet -InputObject \$handlers -Expected @\("\/"\)/);
  assert.match(status, /Proxy"\) -cne \$script:WenmaiServeTarget/);
  assert.match(enable, /Existing Tailscale Serve configuration is non-empty.+No changes were made/);
  assert.match(disable, /Existing Tailscale Serve configuration is non-empty.+Nothing was removed/);
  assert.match(disable, /@\("serve", "--https=443", "off"\)/);
  assert.doesNotMatch(disable, /reset/i);
});

test("gateway lifecycle requires durable state, health PID, script path, hash, and process creation identity", async () => {
  const { status, enable, disable } = await sources();
  assert.match(status, /tailscale-agent-gateway-state\.json/);
  assert.match(status, /gatewayScriptSha256/);
  assert.match(status, /processCreationDate/);
  assert.match(status, /Get-Process -Id \$pidValue/);
  assert.match(enable, /Get-Process -Id \$ProcessId/);
  assert.match(enable, /Convert-WenmaiProcessCreationDate -Value \$process\.StartTime/);
  assert.match(status, /\$healthPid -eq \[int\]\$State\.pid/);
  assert.match(status, /function Stop-WenmaiOwnedGatewayProcess/);
  assert.match(status, /function Test-WenmaiGatewayTcpReachable/);
  assert.match(status, /FromMilliseconds\(300\)/);
  assert.match(status, /Reason = "tcp_unreachable"/);
  assert.match(status, /"--connect-timeout", "1", "--max-time", "2"/);
  assert.match(enable, /Start-Process.+-WindowStyle Hidden -PassThru/);
  assert.match(enable, /exact health contract \(\$reason\)/);
  assert.match(enable, /Write-WenmaiGatewayState -State \$state/);
  assert.match(enable, /The newly started gateway could not be rolled back/);
  assert.match(enable, /\$health\.Valid[\s\S]{0,140}\$health\.Data\.pid/);
  assert.match(enable, /Stop-Process -Id \(\[int\]\$started\.Id\)/);
  assert.match(disable, /Stop-WenmaiOwnedGatewayProcess -State \$state -ExpectedNodeExe \$nodeExe/);
  assert.doesNotMatch(disable, /Stop-Process\s+-Name|taskkill\.exe|\/T\s+\/F/);
});

test("the exact Tailscale executable path, product identity, and Authenticode signer are required", async () => {
  const { status } = await sources();
  assert.match(status, /Join-Path \$programFiles "Tailscale\\tailscale\.exe"/);
  assert.match(status, /CompanyName -cne "Tailscale Inc\."/);
  assert.match(status, /ProductName -cne "Tailscale"/);
  assert.match(status, /OriginalFilename -cne "tailscale\.exe"/);
  assert.match(status, /Get-AuthenticodeSignature/);
  assert.match(status, /SignatureStatus\]::Valid/);
});

test("PowerShell 5 parser accepts every operation script and DescribeOnly has no side effects", () => {
  const scripts = [
    windowsPath("scripts/status-wenmai-tailscale-agent.ps1"),
    windowsPath("scripts/enable-wenmai-tailscale-agent.ps1"),
    windowsPath("scripts/disable-wenmai-tailscale-agent.ps1"),
  ];
  for (const script of scripts) {
    const escaped = script.replaceAll("'", "''");
    const parseCommand = [
      "$ErrorActionPreference='Stop'",
      `$path='${escaped}'`,
      "$errors=$null",
      "$tokens=$null",
      "[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)|Out-Null",
      "if($errors.Count){$errors|ForEach-Object{Write-Error $_.Message};exit 1}",
    ].join(";");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", parseCommand], { stdio: "pipe" });
  }
  const described = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scripts[0], "-DescribeOnly"],
    { encoding: "utf8" },
  );
  const contract = JSON.parse(described.replace(/^\uFEFF/, ""));
  assert.equal(contract.gatewayOrigin, "http://127.0.0.1:43180");
  assert.equal(contract.gatewayHealthUrl, "http://127.0.0.1:43180/_wenmai/agent-gateway/health");
  assert.equal(contract.serveTarget, "http://127.0.0.1:43180");
  assert.equal(contract.managementExposed, false);
  assert.equal(contract.resetAllowed, false);
});

test("enable helper can be safely loaded as a library for owned gateway startup probes", async () => {
  const { enable } = await sources();
  assert.match(enable, /\[switch\]\$LibraryOnly/);
  assert.match(enable, /if \(\$LibraryOnly\) \{\s*return\s*\}/);
});

test("Serve classifier accepts only the empty baseline or one exact root HTTPS proxy", () => {
  const statusPath = windowsPath("scripts/status-wenmai-tailscale-agent.ps1").replaceAll("'", "''");
  const exact = JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: { "agent.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:43180" } } } },
  }).replaceAll("'", "''");
  const wrongTarget = exact.replace("43180", "3000");
  const extraHandler = JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: { "agent.example.ts.net:443": { Handlers: {
      "/": { Proxy: "http://127.0.0.1:43180" },
      "/foreign": { Proxy: "http://127.0.0.1:9999" },
    } } },
  }).replaceAll("'", "''");
  const command = [
    `. '${statusPath}' -LibraryOnly`,
    "$empty='{}'|ConvertFrom-Json",
    `$exact='${exact}'|ConvertFrom-Json`,
    `$wrong='${wrongTarget}'|ConvertFrom-Json`,
    `$extra='${extraHandler}'|ConvertFrom-Json`,
    "if(-not (Test-WenmaiServeConfigEmpty -Config $empty)){exit 10}",
    "if(-not (Test-WenmaiServeConfigExact -Config $exact)){exit 11}",
    "if(Test-WenmaiServeConfigExact -Config $wrong){exit 12}",
    "if(Test-WenmaiServeConfigExact -Config $extra){exit 13}",
  ].join(";");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { stdio: "pipe" });
});
