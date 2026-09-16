[CmdletBinding()]
param(
  [switch]$LibraryOnly,
  [switch]$DescribeOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:WenmaiGatewayService = "wenmai-tailscale-agent-gateway"
$script:WenmaiGatewayHost = "127.0.0.1"
$script:WenmaiGatewayPort = 43180
$script:WenmaiGatewayOrigin = "http://127.0.0.1:43180"
$script:WenmaiGatewayHealthPath = "/_wenmai/agent-gateway/health"
$script:WenmaiGatewayHealthUrl = "$($script:WenmaiGatewayOrigin)$($script:WenmaiGatewayHealthPath)"
$script:WenmaiAgentPath = "/api/agent/v1"
$script:WenmaiUpstreamOrigin = "http://[::1]:3000"
$script:WenmaiServeTarget = $script:WenmaiGatewayOrigin
$script:WenmaiServeHttpsPort = 443
$script:WenmaiProjectRoot = Split-Path -Parent $PSScriptRoot
$script:WenmaiGatewayScript = Join-Path $PSScriptRoot "wenmai-tailscale-agent-gateway.mjs"
$script:WenmaiStateSchema = "wenmai-tailscale-agent-state/1.0"
$script:WenmaiStateOwner = "enable-wenmai-tailscale-agent.ps1"
$script:WenmaiLocalAppData = [Environment]::GetFolderPath("LocalApplicationData")
if ([string]::IsNullOrWhiteSpace($script:WenmaiLocalAppData)) {
  throw "LOCALAPPDATA is unavailable."
}
$script:WenmaiStateDirectory = Join-Path $script:WenmaiLocalAppData "Wenmai"
$script:WenmaiStatePath = Join-Path $script:WenmaiStateDirectory "tailscale-agent-gateway-state.json"

function Get-WenmaiContract {
  return [ordered]@{
    schemaVersion = "wenmai-tailscale-agent-ops/1.0"
    gatewayOrigin = $script:WenmaiGatewayOrigin
    gatewayHealthUrl = $script:WenmaiGatewayHealthUrl
    gatewayScript = $script:WenmaiGatewayScript
    agentPath = $script:WenmaiAgentPath
    upstreamOrigin = $script:WenmaiUpstreamOrigin
    serveTarget = $script:WenmaiServeTarget
    serveHttpsPort = $script:WenmaiServeHttpsPort
    statePath = $script:WenmaiStatePath
    managementExposed = $false
    resetAllowed = $false
  }
}

function Test-WenmaiAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-WenmaiAdministrator {
  if (-not (Test-WenmaiAdministrator)) {
    throw "Administrator rights are required because this Tailscale installation protects its local API. Re-run the CMD with Run as administrator."
  }
}

function Get-WenmaiPropertyNames {
  param([Parameter(Mandatory = $true)]$InputObject)
  if ($null -eq $InputObject) { return @() }
  return @($InputObject.PSObject.Properties | ForEach-Object { $_.Name })
}

function Get-WenmaiPropertyValue {
  param(
    [Parameter(Mandatory = $true)]$InputObject,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ($null -eq $InputObject) { return $null }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Test-WenmaiExactPropertySet {
  param(
    [Parameter(Mandatory = $true)]$InputObject,
    [Parameter(Mandatory = $true)][string[]]$Expected
  )
  $actual = @(Get-WenmaiPropertyNames -InputObject $InputObject | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count) { return $false }
  for ($index = 0; $index -lt $wanted.Count; $index += 1) {
    if ($actual[$index] -cne $wanted[$index]) { return $false }
  }
  return $true
}

function Get-WenmaiTailscaleExe {
  $programFiles = [Environment]::GetFolderPath("ProgramFiles")
  if ([string]::IsNullOrWhiteSpace($programFiles)) {
    throw "Program Files is unavailable."
  }
  $expectedPath = [IO.Path]::GetFullPath((Join-Path $programFiles "Tailscale\tailscale.exe"))
  if (-not (Test-Path -LiteralPath $expectedPath -PathType Leaf)) {
    throw "The exact Tailscale CLI was not found at $expectedPath."
  }
  $item = Get-Item -LiteralPath $expectedPath -ErrorAction Stop
  if ([IO.Path]::GetFullPath($item.FullName) -cne $expectedPath) {
    throw "The Tailscale CLI path did not resolve to the expected installation path."
  }
  $version = $item.VersionInfo
  if ($version.CompanyName -cne "Tailscale Inc." -or $version.ProductName -cne "Tailscale" -or $version.OriginalFilename -cne "tailscale.exe") {
    throw "The executable at the expected path does not identify itself as the Tailscale CLI."
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $expectedPath
  $subject = if ($null -eq $signature.SignerCertificate) { "" } else { [string]$signature.SignerCertificate.Subject }
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $subject -notmatch "(?:^|, )O=Tailscale Inc\.(?:,|$)") {
    throw "The Tailscale CLI signature is not valid for Tailscale Inc."
  }
  return $expectedPath
}

function Get-WenmaiNodeExe {
  $programFiles = [Environment]::GetFolderPath("ProgramFiles")
  $expectedPath = [IO.Path]::GetFullPath((Join-Path $programFiles "nodejs\node.exe"))
  if (-not (Test-Path -LiteralPath $expectedPath -PathType Leaf)) {
    throw "The exact Node.js executable was not found at $expectedPath."
  }
  $item = Get-Item -LiteralPath $expectedPath -ErrorAction Stop
  if ([IO.Path]::GetFullPath($item.FullName) -cne $expectedPath -or $item.VersionInfo.OriginalFilename -cne "node.exe") {
    throw "The Node.js executable path or identity is unexpected."
  }
  return $expectedPath
}

function Invoke-WenmaiExternal {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$AllowFailure,
    [switch]$LiveOutput
  )
  if ($LiveOutput) {
    & $FilePath @Arguments 2>&1 | Out-Host
    $exitCode = [int]$LASTEXITCODE
    if (-not $AllowFailure -and $exitCode -ne 0) {
      throw "External command failed with exit code $exitCode."
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Text = "" }
  }
  $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { [string]$_ })
  $exitCode = [int]$LASTEXITCODE
  $text = ($output -join "`n").Trim()
  if (-not $AllowFailure -and $exitCode -ne 0) {
    if ($text.Length -gt 1200) { $text = $text.Substring(0, 1200) }
    throw "External command failed with exit code $exitCode. $text"
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Text = $text }
}

function Invoke-WenmaiTailscaleJson {
  param(
    [Parameter(Mandatory = $true)][string]$TailscaleExe,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $result = Invoke-WenmaiExternal -FilePath $TailscaleExe -Arguments $Arguments
  if ([string]::IsNullOrWhiteSpace($result.Text)) {
    throw "Tailscale returned an empty JSON response."
  }
  try {
    return $result.Text | ConvertFrom-Json
  } catch {
    throw "Tailscale returned invalid JSON."
  }
}

function Get-WenmaiTailscaleStatus {
  param([Parameter(Mandatory = $true)][string]$TailscaleExe)
  $status = Invoke-WenmaiTailscaleJson -TailscaleExe $TailscaleExe -Arguments @("status", "--json")
  if ([string]$status.BackendState -cne "Running" -or $status.TUN -ne $true) {
    throw "Tailscale is not in the required Running/TUN state."
  }
  $dnsName = [string]$status.Self.DNSName
  if ([string]::IsNullOrWhiteSpace($dnsName) -or $dnsName -notmatch "^[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net\.$") {
    throw "Tailscale status does not contain a valid MagicDNS name."
  }
  return $status
}

function Get-WenmaiServeConfig {
  param([Parameter(Mandatory = $true)][string]$TailscaleExe)
  return Invoke-WenmaiTailscaleJson -TailscaleExe $TailscaleExe -Arguments @("serve", "status", "--json")
}

function Test-WenmaiServeConfigEmpty {
  param([Parameter(Mandatory = $true)]$Config)
  return @(Get-WenmaiPropertyNames -InputObject $Config).Count -eq 0
}

function Test-WenmaiServeConfigExact {
  param([Parameter(Mandatory = $true)]$Config)
  $topNames = @(Get-WenmaiPropertyNames -InputObject $Config)
  $allowedTop = @("TCP", "Web", "AllowFunnel")
  foreach ($name in $topNames) {
    if ($allowedTop -cnotcontains $name) { return $false }
  }
  if ($topNames -cnotcontains "TCP" -or $topNames -cnotcontains "Web") { return $false }

  $tcp = Get-WenmaiPropertyValue -InputObject $Config -Name "TCP"
  if (-not (Test-WenmaiExactPropertySet -InputObject $tcp -Expected @("443"))) { return $false }
  $tcp443 = Get-WenmaiPropertyValue -InputObject $tcp -Name "443"
  if (-not (Test-WenmaiExactPropertySet -InputObject $tcp443 -Expected @("HTTPS"))) { return $false }
  if ((Get-WenmaiPropertyValue -InputObject $tcp443 -Name "HTTPS") -ne $true) { return $false }

  $web = Get-WenmaiPropertyValue -InputObject $Config -Name "Web"
  $webNames = @(Get-WenmaiPropertyNames -InputObject $web)
  if ($webNames.Count -ne 1 -or $webNames[0] -notmatch "^[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net:443$") { return $false }
  $webKey = $webNames[0]
  $webEntry = Get-WenmaiPropertyValue -InputObject $web -Name $webKey
  if (-not (Test-WenmaiExactPropertySet -InputObject $webEntry -Expected @("Handlers"))) { return $false }
  $handlers = Get-WenmaiPropertyValue -InputObject $webEntry -Name "Handlers"
  if (-not (Test-WenmaiExactPropertySet -InputObject $handlers -Expected @("/"))) { return $false }
  $rootHandler = Get-WenmaiPropertyValue -InputObject $handlers -Name "/"
  if (-not (Test-WenmaiExactPropertySet -InputObject $rootHandler -Expected @("Proxy"))) { return $false }
  if ([string](Get-WenmaiPropertyValue -InputObject $rootHandler -Name "Proxy") -cne $script:WenmaiServeTarget) { return $false }

  if ($topNames -ccontains "AllowFunnel") {
    $allowFunnel = Get-WenmaiPropertyValue -InputObject $Config -Name "AllowFunnel"
    $funnelNames = @(Get-WenmaiPropertyNames -InputObject $allowFunnel)
    if ($funnelNames.Count -gt 1) { return $false }
    if ($funnelNames.Count -eq 1) {
      if ($funnelNames[0] -cne $webKey) { return $false }
      if ((Get-WenmaiPropertyValue -InputObject $allowFunnel -Name $webKey) -ne $false) { return $false }
    }
  }
  return $true
}

function Test-WenmaiGatewayTcpReachable {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect($script:WenmaiGatewayHost, $script:WenmaiGatewayPort, $null, $null)
    try {
      if (-not $pending.AsyncWaitHandle.WaitOne([TimeSpan]::FromMilliseconds(300))) {
        return $false
      }
    } finally {
      $pending.AsyncWaitHandle.Close()
    }
    $client.EndConnect($pending)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-WenmaiGatewayHealth {
  if (-not (Test-WenmaiGatewayTcpReachable)) {
    return [pscustomobject]@{ Reachable = $false; Valid = $false; Data = $null; Reason = "tcp_unreachable" }
  }
  $curlExe = Join-Path ([Environment]::GetFolderPath("System")) "curl.exe"
  if (-not (Test-Path -LiteralPath $curlExe -PathType Leaf)) {
    throw "The Windows curl.exe executable is unavailable."
  }
  $result = Invoke-WenmaiExternal -FilePath $curlExe -Arguments @(
    "--noproxy", "*", "--silent", "--show-error", "--connect-timeout", "1", "--max-time", "2",
    "--header", "Accept: application/json", $script:WenmaiGatewayHealthUrl
  ) -AllowFailure
  if ($result.ExitCode -ne 0) {
    return [pscustomobject]@{ Reachable = $false; Valid = $false; Data = $null; Reason = "curl_exit_$($result.ExitCode)" }
  }
  try {
    $data = $result.Text | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{ Reachable = $true; Valid = $false; Data = $null; Reason = "invalid_json" }
  }
  $pidValue = 0
  $pidRaw = Get-WenmaiPropertyValue -InputObject $data -Name "pid"
  $pidValid = [int]::TryParse([string]$pidRaw, [ref]$pidValue) -and $pidValue -gt 0
  $valid = (Get-WenmaiPropertyValue -InputObject $data -Name "ok") -eq $true `
    -and [string](Get-WenmaiPropertyValue -InputObject $data -Name "service") -ceq $script:WenmaiGatewayService `
    -and $pidValid `
    -and [string](Get-WenmaiPropertyValue -InputObject $data -Name "listenHost") -ceq $script:WenmaiGatewayHost `
    -and [int](Get-WenmaiPropertyValue -InputObject $data -Name "listenPort") -eq $script:WenmaiGatewayPort `
    -and [string](Get-WenmaiPropertyValue -InputObject $data -Name "upstreamOrigin") -ceq $script:WenmaiUpstreamOrigin `
    -and [string](Get-WenmaiPropertyValue -InputObject $data -Name "agentPath") -ceq $script:WenmaiAgentPath
  return [pscustomobject]@{
    Reachable = $true
    Valid = [bool]$valid
    Data = $data
    Reason = if ($valid) { "ok" } else { "contract_mismatch" }
  }
}

function Get-WenmaiFileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Convert-WenmaiProcessCreationDate {
  param($Value)
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime().ToString("o") }
  $parsed = [DateTime]::MinValue
  if ([DateTime]::TryParse([string]$Value, [ref]$parsed)) { return $parsed.ToUniversalTime().ToString("o") }
  return [string]$Value
}

function Read-WenmaiGatewayState {
  if (-not (Test-Path -LiteralPath $script:WenmaiStatePath -PathType Leaf)) { return $null }
  try {
    return (Get-Content -Raw -LiteralPath $script:WenmaiStatePath) | ConvertFrom-Json
  } catch {
    throw "The gateway state file exists but is invalid JSON: $($script:WenmaiStatePath)"
  }
}

function Test-WenmaiGatewayStateContract {
  param([Parameter(Mandatory = $true)]$State)
  if ([string]$State.schemaVersion -cne $script:WenmaiStateSchema) { return $false }
  if ([string]$State.owner -cne $script:WenmaiStateOwner) { return $false }
  if ([string]$State.projectRoot -cne $script:WenmaiProjectRoot) { return $false }
  if ([string]$State.gatewayScript -cne $script:WenmaiGatewayScript) { return $false }
  if ([string]$State.gatewayOrigin -cne $script:WenmaiGatewayOrigin) { return $false }
  if ([string]$State.healthUrl -cne $script:WenmaiGatewayHealthUrl) { return $false }
  if ([string]$State.serveTarget -cne $script:WenmaiServeTarget) { return $false }
  $pidValue = 0
  if (-not [int]::TryParse([string]$State.pid, [ref]$pidValue) -or $pidValue -le 0) { return $false }
  if ([string]$State.gatewayScriptSha256 -notmatch "^[a-f0-9]{64}$") { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$State.processCreationDate)) { return $false }
  return $true
}

function Get-WenmaiGatewayProcessEvidence {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$ExpectedNodeExe
  )
  if (-not (Test-WenmaiGatewayStateContract -State $State)) {
    return [pscustomobject]@{ Exists = $false; Valid = $false; Process = $null; Reason = "state_contract_mismatch" }
  }
  $pidValue = [int]$State.pid
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return [pscustomobject]@{ Exists = $false; Valid = $false; Process = $null; Reason = "process_missing" }
  }
  $executablePath = [string]$process.Path
  $creationDate = Convert-WenmaiProcessCreationDate -Value $process.StartTime
  $currentScriptSha256 = if (Test-Path -LiteralPath $script:WenmaiGatewayScript -PathType Leaf) {
    Get-WenmaiFileSha256 -Path $script:WenmaiGatewayScript
  } else { "" }
  $valid = -not [string]::IsNullOrWhiteSpace($executablePath) `
    -and [IO.Path]::GetFullPath($executablePath) -ceq [IO.Path]::GetFullPath($ExpectedNodeExe) `
    -and $creationDate -ceq [string]$State.processCreationDate `
    -and $currentScriptSha256 -ceq [string]$State.gatewayScriptSha256
  return [pscustomobject]@{
    Exists = $true
    Valid = [bool]$valid
    Process = $process
    Reason = if ($valid) { "ok" } else { "process_identity_mismatch" }
  }
}

function Write-WenmaiGatewayState {
  param([Parameter(Mandatory = $true)]$State)
  if (-not (Test-Path -LiteralPath $script:WenmaiStateDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $script:WenmaiStateDirectory -Force | Out-Null
  }
  $temporaryPath = "$($script:WenmaiStatePath).$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $State | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporaryPath, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporaryPath -Destination $script:WenmaiStatePath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force }
  }
}

function Remove-WenmaiGatewayState {
  if (Test-Path -LiteralPath $script:WenmaiStatePath -PathType Leaf) {
    Remove-Item -LiteralPath $script:WenmaiStatePath -Force
  }
}

function Test-WenmaiOwnedGateway {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)]$Health,
    [Parameter(Mandatory = $true)][string]$ExpectedNodeExe
  )
  $processEvidence = Get-WenmaiGatewayProcessEvidence -State $State -ExpectedNodeExe $ExpectedNodeExe
  $healthPid = if ($Health.Valid) { [int]$Health.Data.pid } else { 0 }
  $valid = $Health.Valid -and $processEvidence.Valid -and $healthPid -eq [int]$State.pid
  return [pscustomobject]@{
    Valid = [bool]$valid
    ProcessEvidence = $processEvidence
    Reason = if ($valid) { "ok" } elseif (-not $Health.Valid) { "health_$($Health.Reason)" } elseif (-not $processEvidence.Valid) { $processEvidence.Reason } else { "pid_mismatch" }
  }
}

function Stop-WenmaiOwnedGatewayProcess {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$ExpectedNodeExe
  )
  $health = Get-WenmaiGatewayHealth
  $owned = Test-WenmaiOwnedGateway -State $State -Health $health -ExpectedNodeExe $ExpectedNodeExe
  if (-not $owned.Valid) {
    throw "Gateway process was not stopped because ownership evidence failed: $($owned.Reason)."
  }
  $pidValue = [int]$State.pid
  Stop-Process -Id $pidValue -ErrorAction Stop
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    $remaining = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($null -eq $remaining) {
      $afterHealth = Get-WenmaiGatewayHealth
      if ($afterHealth.Reachable) {
        throw "The recorded process exited, but the gateway port is still served by another process. State was preserved."
      }
      return
    }
  }
  throw "The verified gateway process did not exit within 10 seconds. State was preserved."
}

function Invoke-WenmaiStatus {
  Assert-WenmaiAdministrator
  $tailscaleExe = Get-WenmaiTailscaleExe
  $tailscaleStatus = Get-WenmaiTailscaleStatus -TailscaleExe $tailscaleExe
  $serveConfig = Get-WenmaiServeConfig -TailscaleExe $tailscaleExe
  $serveState = if (Test-WenmaiServeConfigEmpty -Config $serveConfig) { "disabled" } elseif (Test-WenmaiServeConfigExact -Config $serveConfig) { "enabled_exact" } else { "conflict" }
  $health = Get-WenmaiGatewayHealth
  $state = Read-WenmaiGatewayState
  $stateState = if ($null -eq $state) { "absent" } elseif (Test-WenmaiGatewayStateContract -State $state) { "present" } else { "invalid" }
  $dnsName = ([string]$tailscaleStatus.Self.DNSName).TrimEnd(".")
  Write-Host "Tailscale: running ($dnsName)"
  Write-Host "Serve: $serveState"
  Write-Host "Gateway health: $(if ($health.Valid) { 'valid' } elseif ($health.Reachable) { 'invalid' } else { 'unreachable' })"
  Write-Host "Owned state: $stateState"
  if ($serveState -eq "enabled_exact") { Write-Host "Remote base URL: https://$dnsName" }
  if ($serveState -eq "conflict") { throw "Existing Tailscale Serve configuration is non-empty and is not the exact Wenmai gateway configuration. No changes were made." }
}

if ($DescribeOnly) {
  Get-WenmaiContract | ConvertTo-Json -Depth 5
  return
}

if (-not $LibraryOnly) {
  try {
    Invoke-WenmaiStatus
  } catch {
    Write-Error $_
    exit 1
  }
}
