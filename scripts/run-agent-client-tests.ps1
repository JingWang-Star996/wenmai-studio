$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$candidates = @()
if ($env:WENMAI_PYTHON) {
  $candidates += $env:WENMAI_PYTHON
}
if ($env:USERPROFILE) {
  $candidates += (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe")
}
$pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
if ($pythonCommand) {
  $candidates += $pythonCommand.Source
}

$python = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $python) {
  throw "Python 3 was not found. Set WENMAI_PYTHON to python.exe."
}

Push-Location $projectRoot
try {
  & $python -B tests/test_wenmai_agent_client.py
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
