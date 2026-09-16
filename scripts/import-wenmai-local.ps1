param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [string]$Title,

  [Parameter(Mandatory = $true)]
  [string]$ReceiptPath,

  [string]$CredentialPath = '',

  [string]$ProfileName = '',

  [string]$ProfileCredentialRoot = '',

  [string]$AccessFile = '',

  [ValidateSet('article', 'source_material', 'research_notes', 'platform_copy', 'other')]
  [string]$ContentKind = 'article',

  [ValidateSet('unknown', 'raw', 'draft', 'reviewed_claim', 'final_claim')]
  [string]$EditorialStage = 'unknown',

  [string]$Goal = '保存当前正文并等待人工分流',

  [string]$Audience = '未声明',

  [string[]]$Constraints = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$canonicalOrigin = 'http://[::1]:3000'
$endpoint = "$canonicalOrigin/api/local-import/v1"
$resolvedSourcePath = [System.IO.Path]::GetFullPath($SourcePath)
if (-not [System.IO.File]::Exists($resolvedSourcePath)) { throw "Source file does not exist: $resolvedSourcePath" }
$extension = [System.IO.Path]::GetExtension($resolvedSourcePath).ToLowerInvariant()
if ($extension -notin @('.md', '.txt')) { throw 'Local import accepts only .md or .txt source files.' }
if ([string]::IsNullOrWhiteSpace($Title) -or $Title.Length -gt 300 -or $Title -match "[\r\n]") {
  throw 'Title must be one non-empty line no longer than 300 characters.'
}
if ([string]::IsNullOrWhiteSpace($Goal) -or $Goal.Length -gt 500 -or $Goal -match "[\r\n]") {
  throw 'Goal must be one non-empty line no longer than 500 characters.'
}
if ([string]::IsNullOrWhiteSpace($Audience) -or $Audience.Length -gt 300 -or $Audience -match "[\r\n]") {
  throw 'Audience must be one non-empty line no longer than 300 characters.'
}
if ($Constraints.Count -gt 12 -or @($Constraints | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_.Length -gt 240 -or $_ -match "[\r\n]" }).Count -gt 0) {
  throw 'Constraints must contain at most 12 non-empty single-line values no longer than 240 characters.'
}
$useAgentProfile = -not [string]::IsNullOrWhiteSpace($ProfileName)
$useAccessFile = -not [string]::IsNullOrWhiteSpace($AccessFile)
if (($useAgentProfile -and -not [string]::IsNullOrWhiteSpace($CredentialPath)) -or
  ($useAccessFile -and ($useAgentProfile -or -not [string]::IsNullOrWhiteSpace($CredentialPath)))) {
  throw 'CredentialPath, ProfileName, and AccessFile are mutually exclusive.'
}
if ($useAccessFile) {
  $resolvedAccessFile = [System.IO.Path]::GetFullPath($AccessFile)
  if (-not [System.IO.File]::Exists($resolvedAccessFile)) { throw 'Access file is unavailable.' }
  $accessAttributes = [System.IO.File]::GetAttributes($resolvedAccessFile)
  if (($accessAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Access file is invalid.' }
  $accessInfo = New-Object System.IO.FileInfo($resolvedAccessFile)
  if ($accessInfo.Length -gt 65536) { throw 'Access file is invalid.' }
} elseif ($useAgentProfile) {
  $ProfileName = $ProfileName.Trim().ToLowerInvariant()
  if ($ProfileName -notmatch '^[a-z0-9][a-z0-9._-]{0,31}$') { throw 'ProfileName is invalid.' }
  if ([string]::IsNullOrWhiteSpace($ProfileCredentialRoot)) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable.' }
    $ProfileCredentialRoot = Join-Path $env:LOCALAPPDATA 'WenmaiStudio\agent-profiles'
  }
  $resolvedProfileRoot = [System.IO.Path]::GetFullPath($ProfileCredentialRoot)
  $resolvedCredentialPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedProfileRoot "$ProfileName.dpapi"))
  $rootWithSeparator = $resolvedProfileRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedCredentialPath.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The resolved Agent profile path escaped the credential root.'
  }
  if (-not [System.IO.File]::Exists($resolvedCredentialPath)) {
    throw "Wenmai Agent profile '$ProfileName' is unavailable."
  }
} else {
  if (-not $CredentialPath) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable.' }
    $CredentialPath = Join-Path $env:LOCALAPPDATA 'WenmaiStudio\local-import-operator.dpapi'
  }
  $resolvedCredentialPath = [System.IO.Path]::GetFullPath($CredentialPath)
  if (-not [System.IO.File]::Exists($resolvedCredentialPath)) {
    throw 'Local import credential is unavailable; restart Wenmai once to initialize it.'
  }
}

$utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$bodyText = [System.IO.File]::ReadAllText($resolvedSourcePath, $utf8Strict)
$bodyText = $bodyText.TrimStart([char]0xFEFF).Replace("`r`n", "`n").Replace("`r", "`n")
if ([string]::IsNullOrEmpty($bodyText)) { throw 'Source body is empty.' }
$bodyBytes = $utf8NoBom.GetBytes($bodyText)
if ($bodyBytes.Length -gt 2000000) { throw 'Source body exceeds 2 MB.' }
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $bodySha256 = ([System.BitConverter]::ToString($sha256.ComputeHash($bodyBytes))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
}

function Assert-ExactJsonKeys {
  param([object]$Value, [string[]]$Expected)
  if ($null -eq $Value -or $Value -isnot [pscustomobject]) { throw 'Access file is invalid.' }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $required = @($Expected | Sort-Object)
  if ($actual.Count -ne $required.Count -or (Compare-Object -ReferenceObject $required -DifferenceObject $actual)) {
    throw 'Access file is invalid.'
  }
}

function Read-AccessFileCredential {
  param([string]$Path)
  try {
    $attributes = [System.IO.File]::GetAttributes($Path)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid' }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -gt 65536) { throw 'invalid' }
    $document = $utf8Strict.GetString($bytes) | ConvertFrom-Json -ErrorAction Stop
    Assert-ExactJsonKeys $document @('schemaVersion', 'kind', 'secret', 'possessionIsAuthority', 'exportedAt', 'connectionCard', 'credential', 'handling')
    if ([string]$document.schemaVersion -cne 'wenmai.agent-access-file/1' -or [string]$document.kind -cne 'portable-role-grant' -or
      $document.secret -isnot [bool] -or $document.secret -ne $true -or $document.possessionIsAuthority -isnot [bool] -or $document.possessionIsAuthority -ne $true) { throw 'invalid' }
    $exportedAt = [DateTimeOffset]::MinValue
    if ([string]$document.exportedAt -notmatch '(?:Z|[+-][0-9]{2}:[0-9]{2})$' -or -not [DateTimeOffset]::TryParse([string]$document.exportedAt, [ref]$exportedAt)) { throw 'invalid' }
    $card = $document.connectionCard
    Assert-ExactJsonKeys $card @('schemaVersion', 'label', 'origin', 'client', 'endpoints', 'authentication', 'networkPrerequisite', 'grant', 'allowedOperations', 'ownerOnlyBoundary')
    if ([string]$card.schemaVersion -cne 'wenmai.role-grant/1' -or [string]$card.origin -cne $canonicalOrigin -or [string]::IsNullOrWhiteSpace([string]$card.label)) { throw 'invalid' }
    Assert-ExactJsonKeys $card.client @('id', 'kind', 'profileName')
    if ([string]$card.client.id -notmatch '^agent-client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
      [string]::IsNullOrWhiteSpace([string]$card.client.kind) -or ($null -ne $card.client.profileName -and $card.client.profileName -isnot [string])) { throw 'invalid' }
    Assert-ExactJsonKeys $card.endpoints @('discovery', 'api', 'health', 'mcpManifest', 'localImport')
    if ([string]$card.endpoints.discovery -cne "$canonicalOrigin/.well-known/wenmai-agent.json" -or
      [string]$card.endpoints.api -cne "$canonicalOrigin/api/agent/v1" -or
      [string]$card.endpoints.health -cne "$canonicalOrigin/api/agent/v1?view=health" -or
      [string]$card.endpoints.mcpManifest -cne "$canonicalOrigin/agent/mcp.json" -or
      [string]$card.endpoints.localImport -cne $endpoint) { throw 'invalid' }
    Assert-ExactJsonKeys $card.authentication @('header', 'credentialInUrl', 'note')
    if ([string]$card.authentication.header -cne 'Authorization: Bearer <Role Grant>' -or
      $card.authentication.credentialInUrl -isnot [bool] -or $card.authentication.credentialInUrl -ne $false -or
      [string]::IsNullOrWhiteSpace([string]$card.authentication.note)) { throw 'invalid' }
    Assert-ExactJsonKeys $card.networkPrerequisite @('transport', 'gatewayActivationImplied', 'note')
    if ([string]$card.networkPrerequisite.transport -cne 'local-loopback' -or
      $card.networkPrerequisite.gatewayActivationImplied -isnot [bool] -or $card.networkPrerequisite.gatewayActivationImplied -ne $false -or
      [string]::IsNullOrWhiteSpace([string]$card.networkPrerequisite.note)) { throw 'invalid' }
    Assert-ExactJsonKeys $card.grant @('roleId', 'serverRole', 'permissionPresetId', 'articleScope', 'taskIds', 'expiresAt')
    if ([string]$card.grant.roleId -cne 'local-registrar' -or [string]$card.grant.serverRole -cne 'agent' -or $null -ne $card.grant.permissionPresetId) { throw 'invalid' }
    Assert-ExactJsonKeys $card.grant.articleScope @('mode', 'articleIds', 'includesFutureArticles')
    if ([string]$card.grant.articleScope.mode -cne 'all_articles' -or $card.grant.articleScope.articleIds -isnot [array] -or @($card.grant.articleScope.articleIds).Count -ne 1 -or
      [string]@($card.grant.articleScope.articleIds)[0] -cne '*' -or $card.grant.articleScope.includesFutureArticles -isnot [bool] -or $card.grant.articleScope.includesFutureArticles -ne $true -or
      $card.grant.taskIds -isnot [array] -or @($card.grant.taskIds).Count -ne 0) { throw 'invalid' }
    Assert-ExactJsonKeys $card.allowedOperations @('scopes', 'actionIds')
    if ($card.allowedOperations.scopes -isnot [array] -or @($card.allowedOperations.scopes).Count -ne 1 -or [string]@($card.allowedOperations.scopes)[0] -cne 'article.import.new_root' -or
      $card.allowedOperations.actionIds -isnot [array] -or @($card.allowedOperations.actionIds).Count -ne 0) { throw 'invalid' }
    Assert-ExactJsonKeys $card.ownerOnlyBoundary @('enforced', 'forbiddenCapabilities', 'note')
    if ($card.ownerOnlyBoundary.enforced -isnot [bool] -or $card.ownerOnlyBoundary.enforced -ne $true -or
      $card.ownerOnlyBoundary.forbiddenCapabilities -isnot [array] -or @($card.ownerOnlyBoundary.forbiddenCapabilities).Count -eq 0 -or
      [string]::IsNullOrWhiteSpace([string]$card.ownerOnlyBoundary.note)) { throw 'invalid' }
    $expiresAt = [DateTimeOffset]::MinValue
    if ([string]$card.grant.expiresAt -notmatch '(?:Z|[+-][0-9]{2}:[0-9]{2})$' -or -not [DateTimeOffset]::TryParse([string]$card.grant.expiresAt, [ref]$expiresAt) -or $expiresAt.ToUniversalTime() -le [DateTimeOffset]::UtcNow -or
      $expiresAt.ToUniversalTime() -le $exportedAt.ToUniversalTime() -or $expiresAt.ToUniversalTime() -gt $exportedAt.ToUniversalTime().AddDays(1)) { throw 'invalid' }
    Assert-ExactJsonKeys $document.credential @('type', 'header', 'scheme', 'token')
    $token = [string]$document.credential.token
    if ([string]$document.credential.type -cne 'bearer' -or [string]$document.credential.header -cne 'Authorization' -or
      [string]$document.credential.scheme -cne 'Bearer' -or $token -notmatch '^wenmai_agent_[a-f0-9]{32}_[a-f0-9]{32}$') { throw 'invalid' }
    Assert-ExactJsonKeys $document.handling @('recommendedUnixMode', 'serverStateAuthoritative', 'gatewayActivationImplied', 'revokeByClientId', 'note')
    if ([string]$document.handling.recommendedUnixMode -cne '0600' -or
      $document.handling.serverStateAuthoritative -isnot [bool] -or $document.handling.serverStateAuthoritative -ne $true -or $document.handling.gatewayActivationImplied -isnot [bool] -or $document.handling.gatewayActivationImplied -ne $false -or
      [string]$document.handling.revokeByClientId -cne [string]$card.client.id -or [string]::IsNullOrWhiteSpace([string]$document.handling.note)) { throw 'invalid' }
    return [pscustomobject]@{ token = $token; clientId = [string]$card.client.id }
  } catch {
    throw 'Access file is invalid.'
  }
}

$credential = $null
if ($useAccessFile) {
  $accessCredential = Read-AccessFileCredential $resolvedAccessFile
  $authorizationToken = [string]$accessCredential.token
  $credentialActor = [string]$accessCredential.clientId
  $credentialKind = 'portable-role-grant'
  $localImportBootId = ''
} else {
  $protectedBytes = [System.IO.File]::ReadAllBytes($resolvedCredentialPath)
  $entropyLabel = if ($useAgentProfile) { "wenmai.agent.profile.v1:$ProfileName" } else { 'wenmai.local-import.operator.v1' }
  $entropy = $utf8NoBom.GetBytes($entropyLabel)
  $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protectedBytes,
    $entropy,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try {
    $credentialJson = $utf8Strict.GetString($plainBytes)
    $credential = $credentialJson | ConvertFrom-Json
  } finally {
    [System.Array]::Clear($plainBytes, 0, $plainBytes.Length)
    [System.Array]::Clear($entropy, 0, $entropy.Length)
  }
if ($useAgentProfile) {
  if ($credential.schemaVersion -ne 1 -or [string]$credential.profileName -cne $ProfileName -or [string]$credential.transport -cne 'local' -or [string]$credential.canonicalOrigin -cne $canonicalOrigin) {
    throw 'Wenmai Agent profile is not a local profile for this client.'
  }
  if ([string]$credential.clientId -notmatch '^agent-client-[0-9a-f-]{36}$') { throw 'Wenmai Agent profile client id is invalid.' }
  if ([string]$credential.token -notmatch '^wenmai_agent_[a-f0-9]{32}_[a-f0-9]{32}$') { throw 'Wenmai Agent profile Key is invalid.' }
  $profileExpiry = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$credential.expiresAt, [ref]$profileExpiry) -or $profileExpiry.ToUniversalTime() -le [DateTimeOffset]::UtcNow) {
    throw 'Wenmai Agent profile is expired or has an invalid expiry.'
  }
  $authorizationToken = [string]$credential.token
  $credentialActor = [string]$credential.clientId
  $credentialKind = 'agent-key'
  $localImportBootId = ''
} else {
  if ($credential.schemaVersion -ne 1 -or [string]$credential.endpoint -ne $endpoint) { throw 'Local import credential does not match this client.' }
  if ([string]$credential.bootId -notmatch '^local-import-boot-[A-Za-z0-9_-]{22}$') { throw 'Local import credential boot id is invalid.' }
  if ([string]$credential.token -notmatch '^wenmai_local_import_[A-Za-z0-9_-]{43}$') { throw 'Local import credential token is invalid.' }
  $authorizationToken = [string]$credential.token
  $credentialActor = 'local-import-operator'
  $credentialKind = 'boot-operator'
  $localImportBootId = [string]$credential.bootId
}
}

$commandId = if ($useAgentProfile -or $useAccessFile) { "local-import-$credentialActor-$bodySha256" } else { "local-import-$bodySha256" }
$format = if ($extension -eq '.md') { 'markdown' } else { 'text' }
$requestObject = [ordered]@{
  action = 'create_article_from_text'
  commandId = $commandId
  payload = [ordered]@{
    title = $Title
    bodyText = $bodyText
    bodySha256 = $bodySha256
    sourceName = [System.IO.Path]::GetFileName($resolvedSourcePath)
    format = $format
    intake = [ordered]@{
      schemaVersion = 'wenmai-local-import-declaration/1.0.0'
      contentKind = $ContentKind
      editorialStage = $EditorialStage
      goal = $Goal
      audience = $Audience
      constraints = @($Constraints)
    }
  }
}
$requestJson = $requestObject | ConvertTo-Json -Depth 8 -Compress

Add-Type -AssemblyName System.Net.Http
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.UseProxy = $false
$handler.AllowAutoRedirect = $false
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(60)
$client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $authorizationToken)
if (-not [string]::IsNullOrWhiteSpace($localImportBootId)) {
  $client.DefaultRequestHeaders.Add('X-Wenmai-Local-Import-Boot', $localImportBootId)
}
$client.DefaultRequestHeaders.Accept.Add((New-Object System.Net.Http.Headers.MediaTypeWithQualityHeaderValue('application/json')))

function Read-WenmaiResponse {
  param([System.Net.Http.HttpResponseMessage]$Response)
  $text = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  try { $payload = $text | ConvertFrom-Json } catch { throw "Wenmai returned invalid JSON (HTTP $([int]$Response.StatusCode))." }
  if (-not $Response.IsSuccessStatusCode -or -not $payload.ok) {
    $code = if ($payload.error.code) { [string]$payload.error.code } else { 'LOCAL_IMPORT_REQUEST_FAILED' }
    $message = if ($payload.error.message) { [string]$payload.error.message } else { "HTTP $([int]$Response.StatusCode)" }
    $details = if ($payload.error.details) { " " + ($payload.error.details | ConvertTo-Json -Depth 6 -Compress) } else { "" }
    throw "$code`: $message$details"
  }
  return $payload
}

try {
  $content = New-Object System.Net.Http.StringContent($requestJson, $utf8NoBom, 'application/json')
  $postResponse = $client.PostAsync($endpoint, $content).GetAwaiter().GetResult()
  $postEnvelope = Read-WenmaiResponse $postResponse
  $articleId = [string]$postEnvelope.data.articleId
  $readbackUrl = "${endpoint}?articleId=$([Uri]::EscapeDataString($articleId))&bodySha256=$bodySha256"
  $getResponse = $client.GetAsync($readbackUrl).GetAwaiter().GetResult()
  $readbackEnvelope = Read-WenmaiResponse $getResponse
} finally {
  $client.Dispose()
  $handler.Dispose()
}

foreach ($field in @('articleId', 'packageId', 'branchId', 'revisionId', 'compositionId', 'bodySha256', 'compositionSha256', 'documentSha256')) {
  if ([string]$postEnvelope.data.$field -ne [string]$readbackEnvelope.data.$field) {
    throw "Local import readback mismatch: $field"
  }
}
if ([string]$postEnvelope.data.guidanceChecklist.checklistSha256 -ne [string]$readbackEnvelope.data.guidanceChecklist.checklistSha256) {
  throw 'Local import readback mismatch: guidanceChecklist.checklistSha256'
}
if (([string]$readbackEnvelope.data.packageStatus -ne 'active') -or
  ([string]$readbackEnvelope.data.branchStatus -ne 'active') -or
  ([bool]$readbackEnvelope.data.workingCopyDirty) -or
  (-not [bool]$readbackEnvelope.data.branchBridgeInSync) -or
  ([string]$readbackEnvelope.data.bodySha256 -ne $bodySha256)) {
  throw 'Local import readback did not pass active/clean/inSync/body SHA gates.'
}

$receipt = [ordered]@{
  schemaVersion = 1
  observedAt = (Get-Date).ToUniversalTime().ToString('o')
  source = [ordered]@{
    name = [System.IO.Path]::GetFileName($resolvedSourcePath)
    format = $format
    bodySha256 = $bodySha256
    bytes = $bodyBytes.Length
  }
  submission = [ordered]@{
    httpStatus = [int]$postResponse.StatusCode
    requestId = [string]$postEnvelope.requestId
    commandId = $commandId
    created = [bool]$postEnvelope.data.created
    reused = [bool]$postEnvelope.data.reused
    authorizationKind = $credentialKind
    actorId = $credentialActor
  }
  readback = $readbackEnvelope.data
  gates = [ordered]@{
    localImportRequestAccepted = $true
    internalDestinationRecordVerified = $true
    identityMatch = $true
    unique = $true
    packageActive = $true
    branchActive = $true
    workingCopyClean = $true
    branchBridgeInSync = $true
    bodySha256Match = $true
    archiveRecordVerified = [bool]$readbackEnvelope.data.archiveRecordVerified
    guidedAgentWorkReady = [bool]$readbackEnvelope.data.guidedAgentWorkReady
    editorialComplete = $false
    artifactDelivered = $false
    externalSubmissionAccepted = $false
    publicAccessVerified = $false
    outcomeVerified = $false
  }
}
$resolvedReceiptPath = [System.IO.Path]::GetFullPath($ReceiptPath)
$receiptParent = [System.IO.Path]::GetDirectoryName($resolvedReceiptPath)
if ($receiptParent) { [System.IO.Directory]::CreateDirectory($receiptParent) | Out-Null }
$temporaryReceipt = $resolvedReceiptPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
$backupReceipt = $resolvedReceiptPath + '.' + [guid]::NewGuid().ToString('N') + '.bak'
try {
  [System.IO.File]::WriteAllText($temporaryReceipt, ($receipt | ConvertTo-Json -Depth 20), $utf8NoBom)
  if ([System.IO.File]::Exists($resolvedReceiptPath)) {
    [System.IO.File]::Replace($temporaryReceipt, $resolvedReceiptPath, $backupReceipt, $true)
  } else {
    [System.IO.File]::Move($temporaryReceipt, $resolvedReceiptPath)
  }
} finally {
  if ([System.IO.File]::Exists($temporaryReceipt)) { [System.IO.File]::Delete($temporaryReceipt) }
  if ([System.IO.File]::Exists($backupReceipt)) { [System.IO.File]::Delete($backupReceipt) }
}

$authorizationToken = $null
if ($credential) { $credential.token = $null }

[pscustomobject]@{
  ok = $true
  articleId = [string]$readbackEnvelope.data.articleId
  packageId = [string]$readbackEnvelope.data.packageId
  branchId = [string]$readbackEnvelope.data.branchId
  revisionId = [string]$readbackEnvelope.data.revisionId
  compositionId = [string]$readbackEnvelope.data.compositionId
  bodySha256 = $bodySha256
  created = [bool]$postEnvelope.data.created
  reused = [bool]$postEnvelope.data.reused
  archiveRecordVerified = [bool]$readbackEnvelope.data.archiveRecordVerified
  guidedAgentWorkReady = [bool]$readbackEnvelope.data.guidedAgentWorkReady
  archiveState = [string]$readbackEnvelope.data.guidanceChecklist.archiveState
  nextAction = [string]$readbackEnvelope.data.guidanceChecklist.nextAction.instruction
} | ConvertTo-Json -Compress
