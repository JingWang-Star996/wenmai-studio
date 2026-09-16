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

# Keep both the unittest process and the factory_runner.py subprocesses it
# launches on a deterministic UTF-8 stdio contract on Windows.
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

Push-Location $projectRoot
try {
  & $python -B -m unittest discover -s tests -p test_runner_scripts.py -v
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
