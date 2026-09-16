$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $projectRoot 'data\capabilities.generated.json'
$temp = "$output.$([guid]::NewGuid().ToString('N')).tmp"
try {
  $python = (Get-Command python -ErrorAction Stop).Source
  & $python (Join-Path $PSScriptRoot 'index_capabilities.py') --output $temp
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $python (Join-Path $PSScriptRoot 'validate_capabilities.py') --input $temp
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Move-Item -LiteralPath $temp -Destination $output -Force
} finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
& $python (Join-Path $PSScriptRoot 'validate_capabilities.py') --input $output
exit $LASTEXITCODE
