Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:RefreshFiles = @('README.md','article-id-map.json','corpus.generated.json','version-text.generated.json','corpus-validation.json','capabilities.generated.json')
function Get-RefreshFullPath([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd([char]92,[char]47) }
function Get-RefreshSha256([string]$Path) {$stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try {(([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create().ComputeHash($stream)))).Replace('-','')).ToLowerInvariant()} finally {$stream.Dispose()}}
function Get-RefreshManifest([string]$Directory) {
  if (!(Test-Path -LiteralPath $Directory -PathType Container)) {throw "directory missing: $Directory"}
  $actual=@(Get-ChildItem -LiteralPath $Directory -Force | ForEach-Object Name | Sort-Object);$expected=@($script:RefreshFiles | Sort-Object)
  if (($actual -join "`n") -ne ($expected -join "`n")) {throw 'data directory must contain exactly six fixed files'}
  $result=[ordered]@{};foreach($name in $script:RefreshFiles) {$path=Join-Path $Directory $name;if (!(Test-Path -LiteralPath $path -PathType Leaf)) {throw "data member is not a regular file: $name"};$result[$name]=Get-RefreshSha256 $path};$result
}
function Get-RefreshManifestHash($Manifest) { $json=$Manifest|ConvertTo-Json -Compress;[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($json))).Replace('-','').ToLowerInvariant() }
function Get-RefreshSourceInventory([string]$Root,[string]$ExcludedRoot) {
  if (!(Test-Path -LiteralPath $Root -PathType Container)) {throw "source directory missing: $Root"}
  $rootPath=Get-RefreshFullPath $Root;$excludedPath=(Get-RefreshFullPath $ExcludedRoot)+[IO.Path]::DirectorySeparatorChar;$excludedNames=@('node_modules','.git','.next','dist','build','data','coverage','__pycache__')
  $files=[Collections.Generic.List[IO.FileInfo]]::new();$pending=[Collections.Generic.Stack[IO.DirectoryInfo]]::new();$pending.Push([IO.DirectoryInfo]::new($rootPath))
  while($pending.Count){$directory=$pending.Pop();foreach($item in $directory.GetFileSystemInfos()){if($item -is [IO.DirectoryInfo]){if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-or$item.Name.StartsWith('.')-or$item.Name -in $excludedNames-or($item.FullName+[IO.Path]::DirectorySeparatorChar).StartsWith($excludedPath,[StringComparison]::OrdinalIgnoreCase)){continue};$pending.Push($item)}elseif($item.Extension.ToLowerInvariant() -in @('.md','.txt','.docx','.json')){$files.Add($item)}}}
  $records=foreach($item in $files|Sort-Object FullName){$relative=$item.FullName.Substring($rootPath.Length).TrimStart([char]92,[char]47);"$relative`t$((Get-RefreshSha256 $item.FullName))"}
  [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes(($records -join "`n")))).Replace('-','').ToLowerInvariant()
}
function Test-WenmaiRunning {try {$client=[Net.Sockets.TcpClient]::new();$task=$client.ConnectAsync('::1',3000);if (!$task.Wait(250)) {$client.Dispose();return $false};$client.Dispose();return $task.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion} catch {return $false}}
function Invoke-RefreshDataTransaction {
  param([Parameter(Mandatory)][string]$ProjectRoot,[Parameter(Mandatory)][string]$ExpectedSourceRoot,[Parameter(Mandatory)][scriptblock]$Generator,[Parameter(Mandatory)][scriptblock]$Validator)
  $root=Get-RefreshFullPath $ProjectRoot;$source=Get-RefreshFullPath $ExpectedSourceRoot;$data=Join-Path $root 'data';$lock=Join-Path $root '.wenmai-runtime-maintenance.lock';$stage=Join-Path $root ('.wenmai-refresh-stage-'+[guid]::NewGuid().ToString('N'));$backup=Join-Path $root ('.wenmai-refresh-backup-'+[guid]::NewGuid().ToString('N'));$lockStream=$null;$swapped=$false
  try {
    try {$lockStream=[IO.FileStream]::new($lock,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None,4096,[IO.FileOptions]::DeleteOnClose)} catch {throw 'refresh maintenance lock is active'}
    if (Test-WenmaiRunning) {throw 'local Wenmai is running; refresh rejected'}
    $liveBefore=Get-RefreshManifest $data;$liveHash=Get-RefreshManifestHash $liveBefore;$sourceBefore=Get-RefreshSourceInventory $source $root;[IO.Directory]::CreateDirectory($stage)|Out-Null
    $context=[pscustomobject]@{projectRoot=$root;sourceRoot=$source;dataRoot=$data;prior=$liveBefore;sourceInventorySha256=$sourceBefore}
    & $Generator $stage $context;& $Validator $stage $context;$null=Get-RefreshManifest $stage
    if ((Get-RefreshSourceInventory $source $root) -cne $sourceBefore) {throw 'source inventory drift; commit rejected'}
    if ((Get-RefreshManifestHash (Get-RefreshManifest $data)) -cne $liveHash) {throw 'live data manifest drift; CAS commit rejected'}
    Move-Item -LiteralPath $data -Destination $backup -ErrorAction Stop
    try {Move-Item -LiteralPath $stage -Destination $data -ErrorAction Stop;$swapped=$true} catch {Move-Item -LiteralPath $backup -Destination $data -ErrorAction Stop;throw}
    [pscustomobject]@{status='committed';backup=$backup;sourceInventorySha256=$sourceBefore;manifest=(Get-RefreshManifest $data)}
  } finally {if (!$swapped -and (Test-Path -LiteralPath $stage)) {Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue};if ($lockStream) {$lockStream.Dispose()}}
}
