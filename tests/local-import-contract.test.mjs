import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [route, projectRoute, launcher, writer, client, gateway, vite] = await Promise.all([
  readFile(new URL("../app/api/local-import/v1/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/project-package/v1/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../scripts/run-vinext.mjs", import.meta.url), "utf8"),
  readFile(new URL("../scripts/set-wenmai-local-import-credential.ps1", import.meta.url), "utf8"),
  readFile(new URL("../scripts/import-wenmai-local.ps1", import.meta.url), "utf8"),
  readFile(new URL("../scripts/wenmai-tailscale-agent-gateway.mjs", import.meta.url), "utf8"),
  readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
]);

test("local-import API 兼容旧五字段并只增加严格 intake，不接受服务端文件路径", () => {
  assert.match(route, /create_article_from_text/);
  assert.match(route, /assertExactKeys\(body\.payload, \["title", "bodyText", "bodySha256", "sourceName", "format", "intake"\]/);
  assert.match(route, /parseLocalImportIntakeDeclaration\(body\.payload\.intake\)/);
  assert.match(route, /view === "health" \|\| view === "contract"/);
  assert.match(route, /const articleId = requiredText\(url\.searchParams\.get\("articleId"\), "articleId", 160\)/);
  assert.match(route, /const bodySha256 = exactSha256\(url\.searchParams\.get\("bodySha256"\), "bodySha256"\)/);
  assert.match(route, /readLocalImportProjectPackage\(articleId, bodySha256\)/);
  assert.match(route, /SOURCE_NAME_ONLY/);
  assert.match(route, /canonicalProjectScalarText/);
  assert.match(route, /trim\(\)\.replace\(\/\\s\+\/gu, " "\)/);
  assert.match(route, /name\.includes\("\.\."\)/);
  assert.doesNotMatch(route, /payload\.(?:path|filePath|localPath)/);
  assert.match(route, /local-article-import-\$\{identity\}/);
  assert.match(route, /BODY_SHA256_MISMATCH/);
  assert.match(route, /EMPTY_DOCUMENT/);
  assert.match(route, /canonical_utf8_text_after_bom_removal_and_newline_normalization/);
});

test("local-import 复用 Package 原子物化并以 Agent 作者身份建立 clean/inSync 记录", () => {
  assert.match(projectRoute, /export async function createLocalImportProjectPackage/);
  assert.match(projectRoute, /authorKind: options\.authorKind \?\? "user"/);
  assert.match(projectRoute, /\{ authorKind: "agent", document \}/);
  assert.match(projectRoute, /LOCAL_IMPORT_RECORD_INCOMPLETE/);
  assert.match(projectRoute, /workingCopyDirty: workingCopy\.dirty/);
  assert.match(projectRoute, /branchBridgeInSync: branchBridge\.inSync/);
  assert.match(projectRoute, /buildLocalImportPackageDocument/);
  assert.match(projectRoute, /guidanceChecklist/);
  assert.match(projectRoute, /archiveRecordVerified: guidanceChecklist\.archiveReady/);
  assert.match(projectRoute, /guidedAgentWorkReady: guidanceChecklist\.editorialWorkReady/);
  assert.match(projectRoute, /persistedLocalImportIdentity/);
  assert.match(projectRoute, /verifyLocalImportStorage\(db/);
  assert.match(projectRoute, /export async function readLocalImportProjectPackage\(articleId: string, expectedBodySha256: string\)[\s\S]{0,220}localImportSnapshot\(db, articleId, null, expectedBodySha256\)/);
  assert.match(projectRoute, /storageProjectionVerified/);
  assert.match(projectRoute, /REVISION_CONTENT_SHA_MISMATCH/);
  assert.match(projectRoute, /BRANCH_WORKING_DOCUMENT_SHA_INVALID/);
  assert.match(projectRoute, /CommandReceipt 只证明历史命令结果/);
  assert.match(projectRoute, /commandReplay: receipt\.replayed === true/);
  assert.match(projectRoute, /readbackFresh: true/);
  assert.match(projectRoute, /LOCAL_IMPORT_DECLARATION_CONFLICT/);
  assert.doesNotMatch(projectRoute, /sourceName: input\.sourceName,[\s\S]{0,120}format: input\.format,[\s\S]{0,120}created:/);
  assert.match(projectRoute, /packageLockVersion: packageValue\.lockVersion/);
  assert.match(projectRoute, /branchLockVersion: Number\(packageBranchState\.lock_version\)/);
  assert.match(projectRoute, /workingCopyLockVersion: workingCopy\.lockVersion/);
  assert.match(projectRoute, /"local-import-operator"/);
});

test("启动凭据只存 SHA 到进程，明文通过 stdin 交给 DPAPI CurrentUser", () => {
  assert.match(launcher, /WENMAI_LOCAL_IMPORT_TOKEN_SHA256/);
  assert.match(launcher, /persistLocalImportCredentialImpl/);
  assert.match(launcher, /input:\s*JSON\.stringify\(credential\)/);
  assert.doesNotMatch(launcher, /stdout\.write\([^\n]*localImportToken/);
  assert.match(writer, /ProtectedData\]::Protect/);
  assert.match(writer, /DataProtectionScope\]::CurrentUser/);
  assert.match(vite, /WENMAI_LOCAL_IMPORT_CANONICAL_ORIGIN: process\.env\.WENMAI_LOCAL_IMPORT_CANONICAL_ORIGIN/);
  assert.match(vite, /WENMAI_LOCAL_IMPORT_BOOT_ID: process\.env\.WENMAI_LOCAL_IMPORT_BOOT_ID/);
  assert.match(vite, /WENMAI_LOCAL_IMPORT_TOKEN_SHA256: process\.env\.WENMAI_LOCAL_IMPORT_TOKEN_SHA256/);
  assert.match(client, /ProtectedData\]::Unprotect/);
  assert.match(client, /UseProxy = \$false/);
  assert.match(client, /branchBridgeInSync/);
  assert.match(client, /File\]::Replace\(\$temporaryReceipt, \$resolvedReceiptPath, \$backupReceipt, \$true\)/);
});

test("portable local-registrar 文件仅作为严格本地导入凭据来源", () => {
  assert.match(client, /\[string\]\$AccessFile = ''/);
  assert.match(client, /CredentialPath, ProfileName, and AccessFile are mutually exclusive/);
  assert.match(client, /FileAttributes\]::ReparsePoint/);
  assert.match(client, /\$accessInfo\.Length -gt 65536/);
  assert.match(client, /UTF8Encoding\(\$false, \$true\)/);
  assert.match(client, /ConvertFrom-Json -ErrorAction Stop/);
  assert.match(client, /function Assert-ExactJsonKeys/);
  assert.match(client, /wenmai\.agent-access-file\/1/);
  assert.match(client, /portable-role-grant/);
  assert.match(client, /wenmai\.role-grant\/1/);
  assert.match(client, /local-registrar/);
  assert.match(client, /article\.import\.new_root/);
  assert.match(client, /\$canonicalOrigin = 'http:\/\/\[::1\]:3000'/);
  assert.match(client, /\$endpoint = "\$canonicalOrigin\/api\/local-import\/v1"/);
  assert.match(client, /expiresAt\.ToUniversalTime\(\) -gt \$exportedAt\.ToUniversalTime\(\)\.AddDays\(1\)/);
  assert.match(client, /\^wenmai_agent_\[a-f0-9\]\{32\}_\[a-f0-9\]\{32\}\$/);
  assert.match(client, /serverStateAuthoritative -ne \$true/);
  assert.match(client, /gatewayActivationImplied -ne \$false/);
  assert.match(client, /revokeByClientId -cne \[string\]\$card\.client\.id/);
  assert.match(client, /\$credentialKind = 'portable-role-grant'/);
  assert.doesNotMatch(client, /throw[^\r\n]{0,160}\$token/);
});

test("Tailscale Agent 网关不转发本机建档动作", () => {
  assert.doesNotMatch(gateway, /create_article_from_text|local-import\/v1/);
});
