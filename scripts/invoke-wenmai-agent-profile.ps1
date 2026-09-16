[CmdletBinding()]
param(
  [string]$ProfileName = "codex-feishu",
  [Parameter(Mandatory = $true)]
  [ValidateSet("ProfileStatus", "LocalImportStatus", "Status", "Worker", "Mcp", "AdminAction", "SuperAdminAction")]
  [string]$Mode,
  [string]$CredentialRoot = "",
  [string]$Action = "",
  [string]$CommandId = "",
  [string]$PayloadJson = "{}"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Net.Http

function Resolve-WenmaiProfileName {
  param([Parameter(Mandatory = $true)][string]$Value)
  $normalized = $Value.Trim().ToLowerInvariant()
  if ($normalized -notmatch '^[a-z0-9][a-z0-9._-]{0,31}$') {
    throw "ProfileName must match ^[a-z0-9][a-z0-9._-]{0,31}$."
  }
  return $normalized
}

function Resolve-WenmaiProfileRoot {
  param([string]$RequestedRoot)
  if ([string]::IsNullOrWhiteSpace($RequestedRoot)) {
    $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
    if ([string]::IsNullOrWhiteSpace($localAppData)) { throw "LOCALAPPDATA is unavailable." }
    $RequestedRoot = Join-Path $localAppData "WenmaiStudio\agent-profiles"
  }
  return [IO.Path]::GetFullPath($RequestedRoot)
}

function Read-WenmaiProtectedProfile {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Root
  )
  $path = [IO.Path]::GetFullPath((Join-Path $Root "$Name.dpapi"))
  $rootWithSeparator = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $path.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The resolved profile path escaped the credential root."
  }
  if (-not [IO.File]::Exists($path)) {
    throw "Wenmai Agent profile '$Name' is unavailable. Sign a Key in Wenmai, then save it with save-wenmai-agent-profile.ps1."
  }
  $utf8Strict = New-Object Text.UTF8Encoding($false, $true)
  $utf8NoBom = New-Object Text.UTF8Encoding($false)
  $protectedBytes = [IO.File]::ReadAllBytes($path)
  $entropy = $utf8NoBom.GetBytes("wenmai.agent.profile.v1:$Name")
  $plainBytes = $null
  try {
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
      $protectedBytes,
      $entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $json = $utf8Strict.GetString($plainBytes)
    return $json | ConvertFrom-Json
  } catch {
    throw "Wenmai Agent profile '$Name' cannot be decrypted by the current Windows user or is invalid."
  } finally {
    [Array]::Clear($entropy, 0, $entropy.Length)
    if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  }
}

function Assert-WenmaiProfileContract {
  param(
    [Parameter(Mandatory = $true)]$Profile,
    [Parameter(Mandatory = $true)][string]$ExpectedName
  )
  $actualNames = @($Profile.PSObject.Properties.Name | Sort-Object)
  $expectedNames = @("canonicalOrigin", "clientId", "expiresAt", "profileName", "savedAt", "schemaVersion", "tailscaleHost", "token", "transport" | Sort-Object)
  if ($actualNames.Count -ne $expectedNames.Count) { throw "Wenmai Agent profile contains an unexpected field set." }
  for ($index = 0; $index -lt $expectedNames.Count; $index += 1) {
    if ($actualNames[$index] -cne $expectedNames[$index]) { throw "Wenmai Agent profile contains an unexpected field set." }
  }
  if ([int]$Profile.schemaVersion -ne 1 -or [string]$Profile.profileName -cne $ExpectedName) {
    throw "Wenmai Agent profile identity does not match the requested profile."
  }
  if ([string]$Profile.clientId -notmatch '^agent-client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
    throw "Wenmai Agent profile clientId is invalid."
  }
  if ([string]$Profile.token -notmatch '^wenmai_agent_[a-f0-9]{32}_[a-f0-9]{32}$') {
    throw "Wenmai Agent profile Key is invalid."
  }
  if ([string]$Profile.canonicalOrigin -cne "http://[::1]:3000") {
    throw "Wenmai Agent profile canonical origin is invalid."
  }
  if ([string]$Profile.transport -notin @("local", "tailscale")) {
    throw "Wenmai Agent profile transport is invalid."
  }
  if ([string]$Profile.transport -eq "local") {
    if ($null -ne $Profile.tailscaleHost -and -not [string]::IsNullOrWhiteSpace([string]$Profile.tailscaleHost)) {
      throw "A local Wenmai Agent profile cannot contain a Tailscale host."
    }
  } elseif ([string]$Profile.tailscaleHost -notmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net$') {
    throw "Wenmai Agent profile Tailscale host is invalid."
  }
  $expiry = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Profile.expiresAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$expiry)) {
    throw "Wenmai Agent profile expiry is invalid."
  }
  return $expiry.ToUniversalTime()
}

function Resolve-WenmaiPython {
  $candidates = @()
  if ($env:WENMAI_PYTHON) { $candidates += [string]$env:WENMAI_PYTHON }
  $userProfile = [Environment]::GetFolderPath("UserProfile")
  if (-not [string]::IsNullOrWhiteSpace($userProfile)) {
    $candidates += (Join-Path $userProfile ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe")
  }
  $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pythonCommand) { $candidates += [string]$pythonCommand.Source }
  $python = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
  if (-not $python) { throw "Python 3 was not found. Set WENMAI_PYTHON to an exact python.exe path." }
  return [IO.Path]::GetFullPath($python)
}

$normalizedProfileName = Resolve-WenmaiProfileName -Value $ProfileName
$profileRoot = Resolve-WenmaiProfileRoot -RequestedRoot $CredentialRoot
$profile = Read-WenmaiProtectedProfile -Name $normalizedProfileName -Root $profileRoot
$expiry = Assert-WenmaiProfileContract -Profile $profile -ExpectedName $normalizedProfileName
$effectiveStatus = if ($expiry -le [DateTimeOffset]::UtcNow) { "expired" } else { "active" }

if ($Mode -eq "ProfileStatus") {
  [pscustomobject][ordered]@{
    ok = $true
    schemaVersion = "wenmai-agent-profile-status/1.0"
    profileName = $normalizedProfileName
    clientId = [string]$profile.clientId
    transport = [string]$profile.transport
    canonicalOrigin = [string]$profile.canonicalOrigin
    tailscaleHost = if ($null -eq $profile.tailscaleHost) { $null } else { [string]$profile.tailscaleHost }
    expiresAt = $expiry.ToString("o")
    effectiveStatus = $effectiveStatus
    secretReturned = $false
  } | ConvertTo-Json -Compress
  exit 0
}
if ($effectiveStatus -ne "active") { throw "Wenmai Agent profile '$normalizedProfileName' is expired. Issue and save a replacement Key." }

$adminActions = @("create_task", "update_task", "cancel_task")
$superAdminActions = @(
  "create_task", "update_task", "cancel_task", "decide_approval", "decide_graph_proposal",
  "decide_patch", "apply_patch", "create_publication_branch", "save_working_copy", "commit_revision", "attach_branch", "register_publication_version",
  "prepare_merge", "save_merge_resolution", "merge_revision",
  "consume_publish_capability"
)
$controlEnvelope = $null
$controlPayload = $null
if ($Mode -in @("AdminAction", "SuperAdminAction")) {
  if ($Mode -eq "AdminAction" -and $Action -cnotin $adminActions) {
    throw "AdminAction only accepts create_task, update_task, or cancel_task."
  }
  if ($Mode -eq "SuperAdminAction") {
    if ([string]$profile.transport -cne "local") {
      throw "SuperAdminAction requires a local DPAPI profile and exact http://[::1]:3000 transport."
    }
    if ($Action -cnotin $superAdminActions) {
      throw "SuperAdminAction only accepts the frozen task, internal-decision, Package Patch, publication-branch, workspace merge, or publish-capability-consume allowlist. Key issuance/revocation, publish-capability issuance, login, 2FA, and external publication clicks are forbidden."
    }
  }
  if ($CommandId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$') {
    throw "CommandId must be a stable 1..160 character ID."
  }
  if ([Text.Encoding]::UTF8.GetByteCount($PayloadJson) -gt 300000) {
    throw "PayloadJson exceeds 300000 UTF-8 bytes."
  }
  try {
    $controlPayload = $PayloadJson | ConvertFrom-Json
  } catch {
    throw "PayloadJson must be strict JSON."
  }
  if ($null -eq $controlPayload -or $controlPayload -isnot [System.Management.Automation.PSCustomObject]) {
    throw "PayloadJson must be a JSON object."
  }
  $controlEnvelope = [ordered]@{
    requestId = $CommandId
    command = if ($Mode -eq "SuperAdminAction") { "super_admin_action" } else { "admin_action" }
    args = [ordered]@{
      action = $Action
      commandId = $CommandId
      payload = $controlPayload
    }
  } | ConvertTo-Json -Depth 64 -Compress
}

if ($Mode -eq "LocalImportStatus") {
  if ([string]$profile.transport -cne "local") { throw "LocalImportStatus requires a local Wenmai Agent profile." }
  $handler = New-Object Net.Http.HttpClientHandler
  $handler.UseProxy = $false
  $handler.AllowAutoRedirect = $false
  $client = New-Object Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(8)
  $message = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Get, "http://[::1]:3000/api/local-import/v1?view=health")
  $message.Headers.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue("Bearer", [string]$profile.token)
  $resultText = $null
  try {
    $response = $client.SendAsync($message).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if ($body.Length -gt 65536) { throw "Wenmai local import status response exceeded 64 KiB." }
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
      $safeMessage = "HTTP $([int]$response.StatusCode)"
      try {
        $failureEnvelope = $body | ConvertFrom-Json
        if ($failureEnvelope.error.message) { $safeMessage = [string]$failureEnvelope.error.message }
      } catch {}
      throw "Wenmai local import status failed: $safeMessage"
    }
    $envelope = $body | ConvertFrom-Json
    if (-not $envelope.ok -or -not $envelope.data.authorized -or $envelope.data.secretReturned) {
      throw "Wenmai local import status returned an invalid envelope."
    }
    $resultText = $envelope | ConvertTo-Json -Depth 8 -Compress
  } finally {
    $profile.token = $null
    $message.Dispose()
    $client.Dispose()
    $handler.Dispose()
  }
  $resultText
  exit 0
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Resolve-WenmaiPython
$scriptPath = if ($Mode -eq "Mcp") {
  Join-Path $PSScriptRoot "wenmai_mcp_server.py"
} else {
  Join-Path $PSScriptRoot "wenmai_agent_client.py"
}
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "The Wenmai Agent executable script is missing." }
$transportArguments = if ([string]$profile.transport -eq "tailscale") {
  @("--trusted-tailscale-host", [string]$profile.tailscaleHost)
} else {
  @("--base-url", [string]$profile.canonicalOrigin)
}
$modeArguments = if ($Mode -eq "Status") { @("status") } elseif ($Mode -eq "Worker") { @("worker") } elseif ($Mode -in @("AdminAction", "SuperAdminAction")) { @("--once") } else { @() }

$hadPreviousToken = Test-Path Env:\WENMAI_AGENT_TOKEN
$previousToken = if ($hadPreviousToken) { [string]$env:WENMAI_AGENT_TOKEN } else { $null }
$exitCode = 1
Push-Location $projectRoot
try {
  [Environment]::SetEnvironmentVariable("WENMAI_AGENT_TOKEN", [string]$profile.token, "Process")
  if ($Mode -in @("AdminAction", "SuperAdminAction")) {
    $previousOutputEncoding = $OutputEncoding
    try {
      $OutputEncoding = New-Object Text.UTF8Encoding($false)
      $controlEnvelope | & $python -B $scriptPath @transportArguments @modeArguments
    } finally {
      $OutputEncoding = $previousOutputEncoding
      $controlEnvelope = $null
      $controlPayload = $null
    }
  } else {
    & $python -B $scriptPath @transportArguments @modeArguments
  }
  $exitCode = [int]$LASTEXITCODE
} finally {
  if ($hadPreviousToken) {
    [Environment]::SetEnvironmentVariable("WENMAI_AGENT_TOKEN", $previousToken, "Process")
  } else {
    [Environment]::SetEnvironmentVariable("WENMAI_AGENT_TOKEN", $null, "Process")
  }
  $profile.token = $null
  $previousToken = $null
  Pop-Location
}
exit $exitCode
