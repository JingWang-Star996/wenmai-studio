[CmdletBinding()]
param(
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$authUrl = "http://[::1]:3000/api/auth"
$canonicalOrigin = "http://[::1]:3000"

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Get-WenmaiAuthState {
  $curlOutput = @(& curl.exe --noproxy "*" --silent --show-error --fail --max-time 3 --header "Accept: application/json" $authUrl 2>&1)
  $curlExitCode = $LASTEXITCODE
  if ($curlExitCode -eq 7) {
    return $null
  }
  if ($curlExitCode -ne 0) {
    throw "文脉健康检查失败，curl 退出码为 $curlExitCode；不会停止任何进程。"
  }
  $payload = (($curlOutput -join "`n") | ConvertFrom-Json)
  if (-not $payload.ok -or $payload.data.canonicalOrigin -ne $canonicalOrigin -or -not $payload.data.bootId) {
    throw "本机 3000 端口不是可验证的文脉服务，不会停止该进程。"
  }
  return $payload.data
}

function Stop-VerifiedWenmaiListener {
  param(
    [switch]$InspectOnly
  )

  $listener = Get-NetTCPConnection -LocalAddress "::1" -LocalPort 3000 -State Listen -ErrorAction Stop |
    Select-Object -First 1
  if (-not $listener) {
    throw "未找到文脉监听进程。"
  }

  $listenerPid = [int]$listener.OwningProcess
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerPid" -ErrorAction Stop
  $commandLine = [string]$process.CommandLine
  $isProjectProcess = $commandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $isVinextListener = $commandLine -match "vinext[\\/]dist[\\/]cli\.js.+(?:dev|start).+--hostname\s+::1.+--port\s+3000"
  if (-not $isProjectProcess -or -not $isVinextListener) {
    throw "3000 端口进程未通过文脉目录与 Vinext 命令校验，不会停止它。"
  }

  if ($InspectOnly) {
    return $listenerPid
  }

  Write-Host "已确认 PID $listenerPid 是当前文脉监听进程，正在停止这一棵服务子树。"
  & taskkill.exe /PID $listenerPid /T /F | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "无法停止当前文脉监听进程，taskkill 退出码为 $LASTEXITCODE。"
  }

  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    $remaining = Get-NetTCPConnection -LocalAddress "::1" -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if (-not $remaining) { return }
  }
  throw "旧文脉进程停止后，3000 端口仍未释放；没有启动第二个实例。"
}

try {
  $state = Get-WenmaiAuthState
  if ($state) {
    if ($CheckOnly) {
      $verifiedPid = Stop-VerifiedWenmaiListener -InspectOnly
      Write-Host "检查通过：当前服务是文脉，监听 PID 为 $verifiedPid；CheckOnly 没有停止或启动任何进程。"
      return
    }
    Write-Host "当前文脉仍在运行。旧配对码不会保存明文，因此只能通过重启生成新码。"
    Write-Host "这会让现有管理会话失效，但不会删除文章、任务或 D1 数据。"
    $answer = Read-Host "按 Enter 继续；输入 N 取消"
    if ($answer -match "^(?:n|no)$") {
      Write-Host "已取消，没有停止任何进程。"
      return
    }
    Stop-VerifiedWenmaiListener
  } else {
    if ($CheckOnly) {
      Write-Host "检查通过：当前没有文脉服务；CheckOnly 没有启动任何进程。"
      return
    }
    Write-Host "当前没有文脉服务，将直接启动并生成新配对码。"
  }

  Write-Host ""
  Write-Host "正在启动新文脉。请复制稍后显示的完整 wenmai1. 开头配对码。"
  & (Join-Path $PSScriptRoot "start-wenmai.ps1")
} catch {
  Write-Error $_
  exit 1
}
