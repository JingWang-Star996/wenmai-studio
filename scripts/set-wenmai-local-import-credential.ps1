param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$credentialJson = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($credentialJson)) {
  throw 'Local import credential JSON is required on stdin.'
}
$credential = $credentialJson | ConvertFrom-Json
if ($credential.schemaVersion -ne 1) { throw 'Unsupported local import credential schema.' }
if ([string]$credential.canonicalOrigin -ne 'http://[::1]:3000') { throw 'Local import origin must be canonical IPv6 loopback.' }
if ([string]$credential.endpoint -ne 'http://[::1]:3000/api/local-import/v1') { throw 'Local import endpoint is invalid.' }
if ([string]$credential.bootId -notmatch '^local-import-boot-[A-Za-z0-9_-]{22}$') { throw 'Local import boot id is invalid.' }
if ([string]$credential.token -notmatch '^wenmai_local_import_[A-Za-z0-9_-]{43}$') { throw 'Local import token is invalid.' }

$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$parent = [System.IO.Path]::GetDirectoryName($resolvedOutputPath)
if (-not $parent) { throw 'Local import credential path must have a parent directory.' }
[System.IO.Directory]::CreateDirectory($parent) | Out-Null

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$plainBytes = $utf8NoBom.GetBytes($credentialJson)
$entropy = $utf8NoBom.GetBytes('wenmai.local-import.operator.v1')
$protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
  $plainBytes,
  $entropy,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$temporaryPath = Join-Path $parent ('.local-import-operator.' + [guid]::NewGuid().ToString('N') + '.tmp')
$backupPath = Join-Path $parent ('.local-import-operator.' + [guid]::NewGuid().ToString('N') + '.bak')
try {
  [System.IO.File]::WriteAllBytes($temporaryPath, $protectedBytes)
  if ([System.IO.File]::Exists($resolvedOutputPath)) {
    [System.IO.File]::Replace($temporaryPath, $resolvedOutputPath, $backupPath, $true)
  } else {
    [System.IO.File]::Move($temporaryPath, $resolvedOutputPath)
  }
} finally {
  if ([System.IO.File]::Exists($temporaryPath)) { [System.IO.File]::Delete($temporaryPath) }
  if ([System.IO.File]::Exists($backupPath)) { [System.IO.File]::Delete($backupPath) }
  [System.Array]::Clear($plainBytes, 0, $plainBytes.Length)
}

[pscustomobject]@{
  ok = $true
  schemaVersion = 1
  protectedBytes = $protectedBytes.Length
} | ConvertTo-Json -Compress
