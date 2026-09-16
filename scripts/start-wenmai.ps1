[CmdletBinding()]
param([switch]$NoOpen,[string]$PersistStatePath,[switch]$NoProviderCredentialDiscovery)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot;Set-Location -LiteralPath $projectRoot
if (Test-Path -LiteralPath (Join-Path $projectRoot '.wenmai-runtime-maintenance.lock')) {throw '刷新维护锁仍在；拒绝启动文脉服务'}
if ($PSBoundParameters.ContainsKey('PersistStatePath')) {
  if ([string]::IsNullOrWhiteSpace($PersistStatePath) -or -not [IO.Path]::IsPathRooted($PersistStatePath)) {throw '-PersistStatePath 必须是绝对状态根目录。'}
  $normalized=[IO.Path]::GetFullPath($PersistStatePath);$leaf=[IO.Path]::GetFileName($normalized.TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)).ToLowerInvariant()
  if (@('v3','sqlite','file') -contains $leaf) {throw '-PersistStatePath 必须指向状态根目录，末段不能是 v3、sqlite 或 file。'}
  [Environment]::SetEnvironmentVariable('WENMAI_PERSIST_STATE_PATH',$normalized,[EnvironmentVariableTarget]::Process)
} else {Remove-Item Env:WENMAI_PERSIST_STATE_PATH -ErrorAction SilentlyContinue}
$env:WENMAI_RELEASE_CONTROL_V2_ENABLED='true';$env:WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED='false'
if ($NoProviderCredentialDiscovery) {Get-ChildItem Env: | Where-Object {$_.Name -match '(?i)(?:API[_-]?KEY|API[_-]?URL|BASE[_-]?URL|ENDPOINT|MODEL|ALLOWED_HOSTS)$'} | ForEach-Object {[Environment]::SetEnvironmentVariable($_.Name,$null,[EnvironmentVariableTarget]::Process)}}
$node=(Get-Command node.exe -ErrorAction Stop).Source;$args=@((Join-Path $PSScriptRoot 'run-vinext.mjs'),'dev');if (!$NoOpen) {$args+='--open'}
& $node @args
