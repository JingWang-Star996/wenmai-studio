[CmdletBinding()]
param(
  [string]$ProfileName = "codex-feishu",
  [Parameter(Mandatory = $true)]
  [ValidateSet("local", "tailscale")]
  [string]$Transport,
  [Parameter(Mandatory = $true)]
  [string]$ClientId,
  [Parameter(Mandatory = $true)]
  [string]$ExpiresAt,
  [string]$TailscaleHost = "",
  [string]$CredentialRoot = "",
  [switch]$TokenFromStdin,
  [switch]$ReplaceExisting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

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

function Read-WenmaiAgentToken {
  param([switch]$FromStdin)
  if ($FromStdin) {
    $value = [Console]::In.ReadToEnd().Trim()
    if ([string]::IsNullOrWhiteSpace($value)) { throw "Agent token is required on stdin." }
    return $value
  }
  $secure = Read-Host "粘贴文脉一次性 Agent Key（输入不会回显）" -AsSecureString
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    if ($null -ne $secure) { $secure.Dispose() }
  }
}

$normalizedProfileName = Resolve-WenmaiProfileName -Value $ProfileName
if ($ClientId -notmatch '^agent-client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
  throw "ClientId is not a Wenmai Agent client identifier."
}

$expiry = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse($ExpiresAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$expiry)) {
  throw "ExpiresAt must be an ISO-8601 timestamp."
}
if ($expiry.ToUniversalTime() -le [DateTimeOffset]::UtcNow) { throw "The Agent Key is already expired." }
if ($expiry.ToUniversalTime() -gt [DateTimeOffset]::UtcNow.AddDays(367)) { throw "The Agent Key expiry is outside the supported lifetime." }

$canonicalOrigin = "http://[::1]:3000"
$normalizedTailscaleHost = ""
if ($Transport -eq "tailscale") {
  $normalizedTailscaleHost = $TailscaleHost.Trim().ToLowerInvariant()
  if ($normalizedTailscaleHost -notmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net$') {
    throw "TailscaleHost must be an exact <machine>.<tailnet>.ts.net hostname."
  }
} elseif (-not [string]::IsNullOrWhiteSpace($TailscaleHost)) {
  throw "TailscaleHost is only valid for the tailscale transport."
}

$profileRoot = Resolve-WenmaiProfileRoot -RequestedRoot $CredentialRoot
[IO.Directory]::CreateDirectory($profileRoot) | Out-Null
$profilePath = [IO.Path]::GetFullPath((Join-Path $profileRoot "$normalizedProfileName.dpapi"))
$rootWithSeparator = $profileRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $profilePath.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The resolved profile path escaped the credential root."
}
if ([IO.File]::Exists($profilePath) -and -not $ReplaceExisting) {
  throw "Profile '$normalizedProfileName' already exists. Use -ReplaceExisting only after issuing and verifying a replacement Key."
}

$token = Read-WenmaiAgentToken -FromStdin:$TokenFromStdin
if ($token -notmatch '^wenmai_agent_[a-f0-9]{32}_[a-f0-9]{32}$') {
  throw "The supplied value is not a Wenmai Agent Key."
}

$savedAt = [DateTimeOffset]::UtcNow.ToString("o")
$profile = [ordered]@{
  schemaVersion = 1
  profileName = $normalizedProfileName
  transport = $Transport
  canonicalOrigin = $canonicalOrigin
  tailscaleHost = if ($Transport -eq "tailscale") { $normalizedTailscaleHost } else { $null }
  clientId = $ClientId
  expiresAt = $expiry.ToUniversalTime().ToString("o")
  savedAt = $savedAt
  token = $token
}

$utf8NoBom = New-Object Text.UTF8Encoding($false)
$plainBytes = $null
$protectedBytes = $null
$temporaryPath = Join-Path $profileRoot (".$normalizedProfileName." + [Guid]::NewGuid().ToString("N") + ".tmp")
$backupPath = Join-Path $profileRoot (".$normalizedProfileName." + [Guid]::NewGuid().ToString("N") + ".bak")
try {
  $profileJson = $profile | ConvertTo-Json -Compress
  $plainBytes = $utf8NoBom.GetBytes($profileJson)
  $entropy = $utf8NoBom.GetBytes("wenmai.agent.profile.v1:$normalizedProfileName")
  try {
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
  } finally {
    [Array]::Clear($entropy, 0, $entropy.Length)
  }
  [IO.File]::WriteAllBytes($temporaryPath, $protectedBytes)
  if ([IO.File]::Exists($profilePath)) {
    [IO.File]::Replace($temporaryPath, $profilePath, $backupPath, $true)
  } else {
    [IO.File]::Move($temporaryPath, $profilePath)
  }
} finally {
  if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
  if ([IO.File]::Exists($backupPath)) { [IO.File]::Delete($backupPath) }
  if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  $token = $null
  $profile.token = $null
}

[pscustomobject][ordered]@{
  ok = $true
  schemaVersion = "wenmai-agent-profile-save/1.0"
  profileName = $normalizedProfileName
  transport = $Transport
  clientId = $ClientId
  expiresAt = $expiry.ToUniversalTime().ToString("o")
  credentialPath = $profilePath
  protectedBytes = $protectedBytes.Length
  secretReturned = $false
} | ConvertTo-Json -Compress
