[CmdletBinding()]
param(
  [switch]$DescribeOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "status-wenmai-tailscale-agent.ps1") -LibraryOnly

function Disable-WenmaiTailscaleAgent {
  Assert-WenmaiAdministrator
  $tailscaleExe = Get-WenmaiTailscaleExe
  $nodeExe = Get-WenmaiNodeExe
  Get-WenmaiTailscaleStatus -TailscaleExe $tailscaleExe | Out-Null
  $serveConfig = Get-WenmaiServeConfig -TailscaleExe $tailscaleExe
  $serveIsEmpty = Test-WenmaiServeConfigEmpty -Config $serveConfig
  $serveIsExact = Test-WenmaiServeConfigExact -Config $serveConfig
  if (-not $serveIsEmpty -and -not $serveIsExact) {
    throw "Existing Tailscale Serve configuration is non-empty and is not the exact Wenmai Agent-only gateway configuration. Nothing was removed."
  }

  if ($serveIsExact) {
    Invoke-WenmaiExternal -FilePath $tailscaleExe -Arguments @("serve", "--https=443", "off") -LiveOutput | Out-Null
    $afterConfig = Get-WenmaiServeConfig -TailscaleExe $tailscaleExe
    if (-not (Test-WenmaiServeConfigEmpty -Config $afterConfig)) {
      throw "The exact Wenmai Serve route was not removed cleanly. No broad configuration wipe was attempted, and the gateway process was left running."
    }
    Write-Host "The exact Wenmai Tailscale Serve route was removed."
  } else {
    Write-Host "Tailscale Serve was already disabled."
  }

  $state = Read-WenmaiGatewayState
  if ($null -eq $state) {
    $health = Get-WenmaiGatewayHealth
    if ($health.Reachable) {
      throw "The remote Serve route is closed, but a process still serves the gateway port without an ownership record. It was not stopped."
    }
    Write-Host "No owned gateway process was recorded."
    return
  }
  if (-not (Test-WenmaiGatewayStateContract -State $state)) {
    throw "The remote Serve route is closed, but the local gateway state file is invalid. No process was stopped."
  }
  $health = Get-WenmaiGatewayHealth
  $processEvidence = Get-WenmaiGatewayProcessEvidence -State $state -ExpectedNodeExe $nodeExe
  if (-not $processEvidence.Exists -and -not $health.Reachable) {
    Remove-WenmaiGatewayState
    Write-Host "A stale gateway state record was removed; no process was stopped."
    return
  }
  $owned = Test-WenmaiOwnedGateway -State $state -Health $health -ExpectedNodeExe $nodeExe
  if (-not $owned.Valid) {
    throw "The remote Serve route is closed, but gateway ownership evidence failed ($($owned.Reason)). No process was stopped and state was preserved."
  }
  Stop-WenmaiOwnedGatewayProcess -State $state -ExpectedNodeExe $nodeExe
  Remove-WenmaiGatewayState
  Write-Host "The recorded and health-matched gateway process was stopped."
  Write-Host "Wenmai Tailscale Agent access is disabled."
}

if ($DescribeOnly) {
  Get-WenmaiContract | ConvertTo-Json -Depth 5
  return
}

try {
  Disable-WenmaiTailscaleAgent
} catch {
  Write-Error $_
  exit 1
}
