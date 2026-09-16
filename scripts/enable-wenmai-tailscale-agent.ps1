[CmdletBinding()]
param(
  [switch]$LibraryOnly,
  [switch]$DescribeOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "status-wenmai-tailscale-agent.ps1") -LibraryOnly

function Get-NewWenmaiGatewayState {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$NodeExe
  )
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) { throw "The new gateway process exited before identity verification." }
  $executablePath = [string]$process.Path
  if ([string]::IsNullOrWhiteSpace($executablePath) `
      -or [IO.Path]::GetFullPath($executablePath) -cne [IO.Path]::GetFullPath($NodeExe)) {
    throw "The new process did not match the exact Node.js executable."
  }
  return [pscustomobject][ordered]@{
    schemaVersion = $script:WenmaiStateSchema
    owner = $script:WenmaiStateOwner
    projectRoot = $script:WenmaiProjectRoot
    gatewayScript = $script:WenmaiGatewayScript
    gatewayScriptSha256 = Get-WenmaiFileSha256 -Path $script:WenmaiGatewayScript
    nodeExe = $NodeExe
    pid = $ProcessId
    processCreationDate = Convert-WenmaiProcessCreationDate -Value $process.StartTime
    gatewayOrigin = $script:WenmaiGatewayOrigin
    healthUrl = $script:WenmaiGatewayHealthUrl
    serveTarget = $script:WenmaiServeTarget
    createdAt = [DateTime]::UtcNow.ToString("o")
  }
}

function Start-NewWenmaiGateway {
  param([Parameter(Mandatory = $true)][string]$NodeExe)
  if (-not (Test-Path -LiteralPath $script:WenmaiGatewayScript -PathType Leaf)) {
    throw "The Agent-only gateway script is missing: $($script:WenmaiGatewayScript)"
  }
  $listener = Get-NetTCPConnection -LocalAddress $script:WenmaiGatewayHost -LocalPort $script:WenmaiGatewayPort -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    throw "127.0.0.1:$($script:WenmaiGatewayPort) is already occupied and did not return the owned gateway health contract."
  }
  $argument = '"{0}"' -f $script:WenmaiGatewayScript.Replace('"', '\"')
  $started = Start-Process -FilePath $NodeExe -ArgumentList $argument -WorkingDirectory $script:WenmaiProjectRoot -WindowStyle Hidden -PassThru
  $health = $null
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    if ($started.HasExited) { throw "The Agent-only gateway exited before becoming healthy (exit code $($started.ExitCode))." }
    $health = Get-WenmaiGatewayHealth
    if ($health.Reachable) { break }
  }
  if ($null -eq $health -or -not $health.Valid) {
    $reason = if ($null -eq $health) { "health_probe_missing" } else { [string]$health.Reason }
    throw "The new gateway process did not produce the exact health contract ($reason). It was not stopped automatically because health identity could not be proven."
  }
  if ([int]$health.Data.pid -ne [int]$started.Id) {
    throw "The health endpoint PID does not match the process started by this script. No process was stopped."
  }
  $state = $null
  try {
    $state = Get-NewWenmaiGatewayState -ProcessId ([int]$started.Id) -NodeExe $NodeExe
    $owned = Test-WenmaiOwnedGateway -State $state -Health $health -ExpectedNodeExe $NodeExe
    if (-not $owned.Valid) {
      throw "The new gateway failed final ownership verification: $($owned.Reason)."
    }
    Write-WenmaiGatewayState -State $state
    return $state
  } catch {
    try {
      $candidate = Get-Process -Id ([int]$started.Id) -ErrorAction SilentlyContinue
      $sameProcess = $null -ne $candidate `
        -and [string]$candidate.Path -ceq [IO.Path]::GetFullPath($NodeExe) `
        -and $health.Valid `
        -and [int]$health.Data.pid -eq [int]$started.Id
      if ($sameProcess) {
        Stop-Process -Id ([int]$started.Id) -ErrorAction Stop
      }
    } catch {
      Write-Warning "The newly started gateway could not be rolled back after startup verification failed: $($_.Exception.Message)"
    }
    throw
  }
}

function Get-OrStartWenmaiGateway {
  param([Parameter(Mandatory = $true)][string]$NodeExe)
  $health = Get-WenmaiGatewayHealth
  $state = Read-WenmaiGatewayState
  if ($null -ne $state) {
    if (-not (Test-WenmaiGatewayStateContract -State $state)) {
      throw "The gateway state file exists but does not match the expected ownership contract. No process was started or stopped."
    }
    $processEvidence = Get-WenmaiGatewayProcessEvidence -State $state -ExpectedNodeExe $NodeExe
    if ($health.Valid) {
      $owned = Test-WenmaiOwnedGateway -State $state -Health $health -ExpectedNodeExe $NodeExe
      if (-not $owned.Valid) {
        throw "A gateway is healthy, but its PID or process identity does not match the recorded owned process. No changes were made."
      }
      return [pscustomobject]@{ State = $state; Started = $false }
    }
    if ($processEvidence.Exists) {
      throw "The recorded gateway process still exists but its health contract is unavailable or invalid. No process was stopped."
    }
    if ($health.Reachable) {
      throw "The gateway port responds with a foreign health contract. No process was started or stopped."
    }
    Remove-WenmaiGatewayState
  } elseif ($health.Reachable) {
    throw "A process is already serving the gateway port without a Wenmai ownership record. No process was started or stopped."
  }
  $newState = Start-NewWenmaiGateway -NodeExe $NodeExe
  return [pscustomobject]@{ State = $newState; Started = $true }
}

function Undo-NewWenmaiGateway {
  param(
    [Parameter(Mandatory = $true)]$GatewayResult,
    [Parameter(Mandatory = $true)][string]$NodeExe
  )
  if (-not $GatewayResult.Started) { return }
  try {
    Stop-WenmaiOwnedGatewayProcess -State $GatewayResult.State -ExpectedNodeExe $NodeExe
    Remove-WenmaiGatewayState
  } catch {
    Write-Warning "Automatic gateway rollback was blocked by ownership checks: $($_.Exception.Message)"
  }
}

function Enable-WenmaiTailscaleAgent {
  Assert-WenmaiAdministrator
  $tailscaleExe = Get-WenmaiTailscaleExe
  $nodeExe = Get-WenmaiNodeExe
  $tailscaleStatus = Get-WenmaiTailscaleStatus -TailscaleExe $tailscaleExe
  $beforeConfig = Get-WenmaiServeConfig -TailscaleExe $tailscaleExe
  $serveWasEmpty = Test-WenmaiServeConfigEmpty -Config $beforeConfig
  $serveWasExact = Test-WenmaiServeConfigExact -Config $beforeConfig
  if (-not $serveWasEmpty -and -not $serveWasExact) {
    throw "Existing Tailscale Serve configuration is non-empty and is not the exact Wenmai Agent-only gateway configuration. No changes were made."
  }

  $gatewayResult = Get-OrStartWenmaiGateway -NodeExe $nodeExe
  if (-not $serveWasExact) {
    try {
      Invoke-WenmaiExternal -FilePath $tailscaleExe -Arguments @(
        "serve", "--bg", "--https=443", $script:WenmaiServeTarget
      ) -LiveOutput | Out-Null
      $afterConfig = Get-WenmaiServeConfig -TailscaleExe $tailscaleExe
      if (-not (Test-WenmaiServeConfigExact -Config $afterConfig)) {
        throw "Tailscale Serve did not read back as the exact root proxy to the Agent-only gateway."
      }
    } catch {
      try {
        $rollbackConfig = Get-WenmaiServeConfig -TailscaleExe $tailscaleExe
        if (Test-WenmaiServeConfigExact -Config $rollbackConfig) {
          Invoke-WenmaiExternal -FilePath $tailscaleExe -Arguments @("serve", "--https=443", "off") -LiveOutput | Out-Null
          $rolledBack = Get-WenmaiServeConfig -TailscaleExe $tailscaleExe
          if (-not (Test-WenmaiServeConfigEmpty -Config $rolledBack)) {
            Write-Warning "Serve rollback did not return to the empty baseline. No broad configuration wipe was attempted."
          }
        } elseif (-not (Test-WenmaiServeConfigEmpty -Config $rollbackConfig)) {
          Write-Warning "Serve changed to an unknown non-empty state. No automatic removal or broad configuration wipe was attempted."
        }
      } catch {
        Write-Warning "Serve rollback status could not be proven: $($_.Exception.Message)"
      }
      Undo-NewWenmaiGateway -GatewayResult $gatewayResult -NodeExe $nodeExe
      throw
    }
  }

  $finalConfig = Get-WenmaiServeConfig -TailscaleExe $tailscaleExe
  if (-not (Test-WenmaiServeConfigExact -Config $finalConfig)) {
    throw "Final Serve status is not the exact Wenmai Agent-only gateway configuration."
  }
  $finalHealth = Get-WenmaiGatewayHealth
  $owned = Test-WenmaiOwnedGateway -State $gatewayResult.State -Health $finalHealth -ExpectedNodeExe $nodeExe
  if (-not $owned.Valid) {
    throw "Serve is configured, but the final gateway ownership check failed: $($owned.Reason)."
  }
  $dnsName = ([string]$tailscaleStatus.Self.DNSName).TrimEnd(".")
  Write-Host "Wenmai Tailscale Agent access is enabled."
  Write-Host "Remote base URL: https://$dnsName"
  Write-Host "Gateway PID: $([int]$gatewayResult.State.pid)"
  Write-Host "Management UI remains local-only; the gateway allowlist controls every remote path."
}

if ($LibraryOnly) {
  return
}

if ($DescribeOnly) {
  Get-WenmaiContract | ConvertTo-Json -Depth 5
  return
}

try {
  Enable-WenmaiTailscaleAgent
} catch {
  Write-Error "Wenmai Tailscale Agent enable failed: $($_.Exception.Message)"
  exit 1
}
