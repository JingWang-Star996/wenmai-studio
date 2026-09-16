import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(new URL("../app/ArticleProjectEditor.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../app/WorkbenchShell.tsx", import.meta.url), "utf8");
const types = readFileSync(new URL("../app/workbench-types.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const experience = readFileSync(new URL("../governance/article-editor-experience-contract.md", import.meta.url), "utf8");

test("文章工程是默认入口，正文编辑仍保留为独立写作工位", () => {
  assert.match(types, /\| "project"/);
  assert.match(shell, /useState<WorkspaceView>\("project"\)/);
  assert.match(shell, /id: "project", label: "文章工程"/);
  assert.match(shell, /id: "desk", label: "写作工位"/);
  assert.match(shell, /view === "project"[\s\S]*<ArticleProjectEditor/);
  assert.match(editor, /打开纯文本源码/);
});

test("已有文章先只读暂存和解包，确认前不改文章对象且不伪装 DOCX 支持", () => {
  assert.match(editor, /只读导入暂存/);
  assert.match(editor, /确认前不会创建或修改 Article、Revision、Composition 或 Package；推荐请求只保留防重放回执，原文件仍留在原处/);
  assert.match(editor, /推荐请求只保留防重放回执/);
  assert.match(editor, /原文件仍留在原处/);
  assert.match(editor, /accept="\.md,\.markdown,\.txt,\.json,\.wenmai"/);
  assert.doesNotMatch(editor, /accept="[^"]*\.docx/);
  assert.match(editor, /sourceFingerprintSha256: stagedImport\.sha256/);
  assert.match(editor, /parser: options\.parser \?\? "wenmai-client-markdown\/1\.0"/);
});

test("导入默认绑定当前 ArticleBranch 为候选，只有明确选择才建立独立 Article", () => {
  const start = editor.indexOf("const confirmImport = useCallback");
  const end = editor.indexOf("const moveModule = useCallback", start);
  assert.ok(start > 0 && end > start, "应能定位 confirmImport 写入边界");
  const confirmImport = editor.slice(start, end);
  const explicitMarker = confirmImport.indexOf("const identity = stagedImport.sha256.slice(0, 32)");
  assert.ok(explicitMarker > 0, "独立 Article 路径必须有显式、可复用的文件身份");
  const candidatePath = confirmImport.slice(0, explicitMarker);
  const newArticlePath = confirmImport.slice(explicitMarker);

  assert.match(editor, /useState<ImportDestination>\("candidate"\)/);
  assert.match(editor, /作为当前文章 \/ 当前分支的候选 Patch 导入 <em>推荐<\/em>/);
  assert.match(editor, /只创建可审查的候选 Patch；不会新建 Article，不会推进 Composition 或 Revision，也不会自动批准或应用/);
  assert.match(candidatePath, /postAction<\{ reused\?: boolean \}>\("create_import_candidate"/);
  assert.match(candidatePath, /packageId: detail\.package\.id,[\s\S]*branchId: detail\.selectedBranchId,[\s\S]*baseRevisionId: detail\.workingCopy\.baseRevisionId,[\s\S]*expectedBranchLockVersion: detail\.branchState\.lockVersion/);
  assert.doesNotMatch(candidatePath, /create_from_text/);
  assert.doesNotMatch(candidatePath, /local-article-/);
  assert.doesNotMatch(candidatePath, /apply_import_candidate|apply_patch/);
  assert.match(newArticlePath, /articleId = `local-article-import-\$\{identity\}`/);
  assert.match(newArticlePath, /"create_from_text"/);
});

test("导入候选保留文件证据、纯文本确定性解包，并且同文件重试不产生重复根", () => {
  assert.match(editor, /function candidateDocumentFromImport\(staged: StagedImport\): PackageDocument/);
  assert.match(editor, /documentFromMarkdown\(staged\.title, staged\.text, source, \{[\s\S]*stableKeySeed: staged\.sha256,[\s\S]*importedAt: null/);
  assert.match(editor, /sourceRef: stagedImport\.name/);
  assert.match(editor, /sourceFingerprintSha256: stagedImport\.sha256/);
  assert.match(editor, /importerVersion: BROWSER_IMPORTER_VERSION/);
  assert.match(editor, /`parser:\$\{candidateDocument\.metadata\.importParser \?\? candidateDocument\.metadata\.parser \?\? "unknown"\}`/);
  assert.match(editor, /candidate\.reused[\s\S]*已复用原候选/);
  assert.match(editor, /const identity = stagedImport\.sha256\.slice\(0, 32\)/);
  assert.match(editor, /projectId: `local-project-import-\$\{identity\}`/);
});

test("导入归属与处理成熟度是两个独立轴，处理建议只供人工确认", () => {
  assert.match(editor, /useState<ImportDestination>\("candidate"\)/);
  assert.match(editor, /useState<ImportProcessingProfile \| null>\(null\)/);
  assert.match(editor, /name="import-destination"/);
  assert.match(editor, /name="import-profile"/);
  assert.match(editor, /value="light_archive"/);
  assert.match(editor, /value="full_production"/);
  assert.match(editor, /profile === null/);
  assert.match(editor, /选择处理预设（必须人工确认）/);
  assert.match(editor, /进入深加工和交付门禁，不等于已经完成/);
  assert.match(editor, /不生成封面、DOCX 或平台物料，也不表示可发布/);

  const recommendationStart = editor.indexOf("const requestImportProfile = useCallback");
  const recommendationEnd = editor.indexOf("const closeImport = useCallback", recommendationStart);
  const recommendationPath = editor.slice(recommendationStart, recommendationEnd);
  assert.doesNotMatch(recommendationPath, /setImportProfile|confirmImport|create_from_text|create_import_candidate/);
  assert.doesNotMatch(recommendationPath, /setError|setStatus\("error"\)/);
  assert.match(recommendationPath, /result\.recommendation\.sourceSha256 !== staged\.sha256/);
  assert.match(editor, /正在生成处理预设建议/);
  assert.match(editor, /处理建议：/);
  assert.match(editor, /处理建议暂不可用/);
  assert.match(editor, /aria-live="polite"/);
});

test("轻量与完整选择连同推荐快照进入两条写入路径，人工覆盖单独留证", () => {
  const start = editor.indexOf("const confirmImport = useCallback");
  const end = editor.indexOf("const moveModule = useCallback", start);
  const confirmImport = editor.slice(start, end);
  assert.match(confirmImport, /buildImportWorkflowMetadata/);
  assert.match(confirmImport, /metadata: \{ \.\.\.importedDocument\.metadata, importWorkflow \}/);
  assert.match(confirmImport, /sourceFingerprintSha256: stagedImport\.sha256,[\s\S]*importWorkflow/);
  assert.match(confirmImport, /`selected-profile:\$\{importProfile\}`/);
  assert.match(confirmImport, /`recommended-profile:\$\{recommendation\.recommendedProfile\}`/);
  assert.match(confirmImport, /`human-override:\$\{String\(importProfile !== recommendation\.recommendedProfile\)\}`/);
  assert.match(editor, /你选择了与推荐不同的预设；将按人工选择执行，并记录覆盖证据/);
  assert.match(editor, /云端模型只接收格式、篇幅、结构和脱敏信号；不会接收正文、文件名、标题或 SHA/);
  assert.match(css, /\.import-profile-recommendation/);
  assert.match(css, /\.import-destination > label\.model-recommended:not\(\.selected\)/);
});

test("不可写工程仍可打开导入面板，但推荐候选被禁用并解释原因", () => {
  assert.match(editor, /const importCandidateDisabledReason = !detail/);
  assert.match(editor, /disabled=\{Boolean\(candidateDisabledReason\)\}/);
  assert.match(editor, /当前不能使用推荐方式/);
  assert.match(editor, /destination === "candidate" && Boolean\(candidateDisabledReason\)/);
  assert.match(editor, /<button onClick=\{openFilePicker\}>导入到暂存区<\/button>/);
  assert.doesNotMatch(editor, /<input ref=\{fileInputRef\} className="visually-hidden" disabled=\{editorReadOnly\}/);
});

test("工程提交与导入弹窗隔离背景、首焦、Escape，并在关闭后回到触发点", () => {
  assert.match(editor, /<dialog ref=\{commitDialogRef\}/);
  assert.match(editor, /<dialog ref=\{dialogRef\} className="project-dialog import-staging"/);
  assert.match(editor, /dialog\.showModal\(\)/);
  assert.match(editor, /commitTitleRef\.current\?\.focus\(\)/);
  assert.match(editor, /titleRef\.current\?\.focus\(\)/);
  assert.match(editor, /commitReturnFocusRef\.current\?\.focus\(\)/);
  assert.match(editor, /importReturnFocusRef\.current\?\.focus\(\)/);
  assert.match(editor, /onCancel=\{\(event\) => \{ event\.preventDefault\(\); setCommitOpen\(false\); \}\}/);
  assert.match(css, /\.project-dialog::backdrop/);
  assert.match(css, /:focus-visible/);
});

test("编辑器提供稳定模块、结构关系、撤销恢复、读者预览和可逆工程包", () => {
  assert.match(editor, /rootModuleKey/);
  assert.match(editor, /rootModuleKey: current\.rootModuleKey === selectedModule\.key/);
  assert.match(editor, /sourceModuleKey/);
  assert.match(editor, /targetModuleKey/);
  assert.match(editor, /undoStack/);
  assert.match(editor, /redoStack/);
  assert.match(editor, /event\.altKey/);
  assert.match(editor, /读者看到的成品/);
  assert.match(editor, /wenmai-project-package\/1\.0/);
  assert.match(editor, /diskWriteVerified: false/);
  assert.match(editor, /releaseCreated: false/);
});

test("诊断绑定不可变 Composition，并且修复必须先成为候选 Patch", () => {
  assert.match(editor, /run_builtin_diagnostics/);
  assert.match(editor, /expectedCompositionSha256/);
  assert.match(editor, /生成候选修复/);
  assert.match(editor, /decide_patch/);
  assert.match(editor, /apply_patch/);
  assert.match(editor, /诊断不会直接改文章/);
});

test("工作台把机器指导清单放在图编辑器前，历史缺口和完成边界持续可见", () => {
  assert.match(editor, /guidanceChecklist: ArticleGuidanceChecklist/);
  assert.match(editor, /文章工程响应缺少机器指导清单；已停止让 Agent 猜测下一步/);
  assert.match(editor, /指导检查表/);
  assert.match(editor, /重新导入原文件/);
  assert.match(editor, /Agent 只能逐模块处理并提交 candidate Patch（候选补丁）/);
  assert.match(editor, /建档不代表编辑完成、工件交付、平台提交或公开可见/);
  assert.match(css, /\.project-guidance-panel/);
  assert.match(css, /\.project-guidance-checks article\.human_required/);
});

test("浏览器重导入候选写入显式的未核验权利声明，不会生成永远无法过门禁的 SourceRef", () => {
  assert.match(editor, /basis: "user_supplied_local_file"/);
  assert.match(editor, /verificationStatus: "unverified_declaration"/);
});

test("工作台为待人工分流检查提供有锁绑定的可见决定面，并只接受服务端读回结果", () => {
  assert.match(editor, /check\.id === "triage\.profile\.human_decision" && check\.status === "human_required"/);
  assert.match(editor, /check\.status === "human_required" \|\| check\.status === "passed"/);
  assert.match(editor, /open=\{!detail\.guidanceChecklist\.archiveReady \|\| guidanceProfileDecisionRequired\}/);
  assert.match(editor, /决定说明（必填）/);
  assert.match(editor, /改为轻量建档/);
  assert.match(editor, /确认轻量建档/);
  assert.match(editor, /改为完整生产/);
  assert.match(editor, /确认进入完整生产/);
  assert.match(editor, /轻量建档 · 可审计升级/);
  assert.match(editor, /disabled=\{!guidanceDecisionNote\.trim\(\) \|\| editorReadOnly \|\| status === "saving"\}/);
  assert.match(editor, /postAction\("decide_guidance_profile", \{[\s\S]*packageId: detail\.package\.id,[\s\S]*branchId: detail\.selectedBranchId,[\s\S]*expectedChecklistSha256: detail\.guidanceChecklist\.checklistSha256,[\s\S]*expectedPackageLockVersion: detail\.package\.lockVersion,[\s\S]*expectedBranchLockVersion: detail\.branchState\.lockVersion,[\s\S]*expectedWorkingLockVersion: detail\.workingCopy\.lockVersion,[\s\S]*selectedProfile,[\s\S]*decisionNote,/);
  assert.match(editor, /setGuidanceDecisionNote\(""\);[\s\S]*await loadPackage\(detail\.package\.id, detail\.selectedBranchId\)/);
  assert.match(editor, /这个决定只解锁后续处理档位，不代表编辑完成、工件已交付、平台已提交或内容已经公开/);
  assert.match(editor, /工作台不会在本地推断决定已经生效/);
  assert.match(css, /\.project-guidance-triage/);
});

test("属性检查器显示可复制的完整 moduleKey，并明确元数据审阅标记不是批准", () => {
  assert.match(editor, /发送 Agent 任务时使用的 moduleKey/);
  assert.match(editor, /navigator\.clipboard\.writeText\(selectedModule\.key\)/);
  assert.match(editor, /人工审阅标记（仅元数据）/);
  assert.match(editor, /此标记不能代替服务端档位决定、批准 Patch 或完成回执/);
  assert.match(css, /\.project-module-key/);
});

test("文章切换和分支切换在保存失败时停留原处", () => {
  assert.match(shell, /当前工作副本尚未安全保存；已留在原分支/);
  assert.match(shell, /当前文章尚未安全保存；已取消切换/);
  assert.match(shell, /const saved = await saveWorkingCopy\(\)/);
  assert.match(shell, /if \(!saved\)/);
});

test("文章工程目录按当前文章隔离，不能回退显示另一篇文章的 Package", () => {
  assert.match(editor, /getData<\{ packages: PackageListItem\[\] \}>\("packages", \{ articleId: article\.id, limit: "100" \}\)/);
  assert.doesNotMatch(editor, /getData<\{ packages: PackageListItem\[\] \}>\("packages"\)/);
});

test("新文章导入成功后直接打开返回的 Package，不用旧 articleId 重新查询", () => {
  assert.match(editor, /setPackages\(\[created\.package as PackageListItem\]\)/);
  assert.match(editor, /setSelectedPackageId\(created\.package\.id\)/);
  assert.match(editor, /await loadPackage\(created\.package\.id, created\.package\.primaryBranchId \?\? undefined\)/);
  assert.doesNotMatch(editor, /await loadPackages\(created\.package\.id\)/);
});

test("本地文章导入回执写入指针目录，并立即切换 Article 与 Branch", () => {
  assert.match(types, /export interface LocalArticleDirectoryEntry/);
  const directoryType = types.match(/export interface LocalArticleDirectoryEntry \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(directoryType, /articleId: string/);
  assert.match(directoryType, /packageId: string/);
  assert.match(directoryType, /branchId: string/);
  assert.match(directoryType, /revisionId: string/);
  assert.match(directoryType, /bodySha256: string/);
  assert.doesNotMatch(directoryType, /bodyText/);
  assert.match(editor, /await onLocalArticleImported\(\{/);
  assert.match(editor, /revisionId: created\.branchBridge\.headRevisionId/);
  assert.match(editor, /bodySha256: created\.branchBridge\.headBodySha256/);
  assert.match(shell, /const LOCAL_ARTICLE_DIRECTORY_KEY = "wenmai:local-article-directory"/);
  assert.match(shell, /setSelectedArticleId\(entry\.articleId\)/);
  assert.match(shell, /setSelectedBranchId\(entry\.branchId\)/);
  assert.match(shell, /await loadWorkspace\(entry\.articleId, entry\.branchId\)/);
});

test("刷新后可从浏览器指针目录恢复本地 Article，正文仍只从 D1 工作区读取", () => {
  assert.match(shell, /parseLocalArticleDirectory\(window\.localStorage\.getItem\(LOCAL_ARTICLE_DIRECTORY_KEY\)\)/);
  assert.match(shell, /restoredLocalArticles\.some\(\(article\) => article\.articleId === storedArticle\)/);
  assert.match(shell, /const workspaceArticles = useMemo/);
  assert.match(shell, /<ArticlePreviewProvider articles=\{workspaceArticles\}/);
  assert.match(shell, /<AgentConsole articles=\{workspaceArticles\}/);
  assert.match(shell, /void loadWorkspace\(selectedArticleId/);
  assert.match(shell, /const \[workspaceRestored, setWorkspaceRestored\] = useState\(false\)/);
  assert.match(shell, /setWorkspaceRestored\(true\)/);
  assert.match(shell, /if \(!workspaceRestored \|\| !selectedArticleId\) return/);
  assert.doesNotMatch(shell, /localStorage\.setItem\([^\n]*bodyText/);
});

test("旧版本导入的本地 Article 由身份目录恢复，隐藏旧根不会滞留在 localStorage", () => {
  assert.match(shell, /const discoverLocalArticles = useCallback/);
  assert.match(shell, /article-identity\/v1\?view=catalog&limit=200/);
  assert.match(shell, /item\.articleId\.startsWith\("local-article-"\)/);
  assert.match(shell, /item\.catalogState === "active"/);
  assert.match(shell, /revisionId: item\.headRevisionId!/);
  assert.match(shell, /bodySha256: item\.headBodySha256!/);
  assert.match(shell, /canonicalRedirect\?\.articleId/);
  assert.match(shell, /const next = \[\.\.\.discovered\]/);
  assert.match(shell, /void discoverLocalArticles\(\)/);
});

test("资料库显式扫描 source-owner 错绑，并以可回滚计划修复而非原地改 ID", () => {
  assert.match(shell, /article-identity\/v1\?view=source_owner_mismatches/);
  assert.match(shell, /"plan_source_owner_repair", \{[\s\S]*sourceBranchId: mismatch\.sourceBranchId,[\s\S]*expectedSourceArticleId: mismatch\.sourceArticleId,[\s\S]*targetArticleId: mismatch\.currentOwnerArticleId,[\s\S]*expectedBodySha256: mismatch\.sourceBodySha256/);
  assert.match(shell, /"apply_source_owner_repair", \{[\s\S]*operationId: sourceOwnerPlan\.operationId,[\s\S]*expectedPlanSha256: sourceOwnerPlan\.planSha256/);
  assert.match(shell, /原 Revision 会原样保留/);
  assert.match(shell, /已修复语料归属：原 Revision 已保留，错绑 Branch 已归档/);
  assert.doesNotMatch(shell, /DELETE FROM article_(?:branches|revisions)/);
});

test("源码首条 H1 同步工程标题，导入框明确工程名称不改正文 H1", () => {
  assert.ok(editor.includes("const sourceTitle = sourceDraft.match(/^#\\s+(.+)$/m)?.[1]?.trim() || documentState.title;"));
  assert.match(editor, /第一条 H1 同步为工程标题/);
  assert.match(editor, /工程名称（不改正文 H1）/);
  assert.match(editor, /工程名称只用于管理；读者看到的正文标题仍取预览中的第一条 H1/);
});

test("桌面三栏、图形流程和窄屏分面都具有实际样式合同", () => {
  assert.match(css, /\.project-structure-layout\s*\{[\s\S]*grid-template-columns:/);
  assert.match(css, /\.project-flow-node/);
  assert.match(css, /\.node-flow-index i::after/);
  assert.match(css, /@media \(max-width: 980px\)[\s\S]*\.project-mobile-tabs/);
  assert.match(css, /\.article-project-editor\.mobile-outline/);
});

test("经验只按证据晋级，聊天与汇总不能覆盖 manifest 和机器报告", () => {
  assert.match(experience, /一篇文章既是可以直接阅读的成品，也是能够安全解包/);
  assert.match(experience, /MCP/);
});

test("0010 编辑器把 ArticleBranch 放在 Package 之前，并明确 Primary 只决定默认入口和发行镜像", () => {
  assert.match(editor, /getData<PackageBranchCatalog>\("branches", \{ packageId \}\)/);
  assert.match(editor, /当前制作分支/);
  assert.match(editor, /工程包（二级项目）/);
  assert.match(editor, /Primary（默认入口）决定默认打开位置与发行镜像，不是唯一分支/);
  assert.match(editor, /Primary（默认入口）只决定默认打开的分支与发行镜像。其他已接入分支各自保留模块图、可编辑工作副本、并发摘要锁和提交历史/);
  assert.match(editor, /project-branch-health/);
});

test("分支切换先保存浏览器脏文档，保存失败时停留在原分支", () => {
  assert.match(editor, /const switchBranch = useCallback/);
  assert.match(editor, /if \(dirty\) \{[\s\S]*const saved = await save\(\);[\s\S]*if \(!saved\)[\s\S]*已留在原分支/);
  assert.match(editor, /await loadPackage\(selectedPackageId, nextBranchId\)/);
  assert.match(editor, /setUndoStack\(\[\]\)/);
  assert.match(editor, /setRedoStack\(\[\]\)/);
  assert.match(editor, /setSelectedModuleKey\(""\)/);
});

test("未接入分支必须显式 attach，且使用冻结的 ArticleBranch CAS", () => {
  assert.match(editor, /"attach_branch"/);
  assert.match(editor, /expectedBranchHeadRevisionId: selectedBranchEntry\.headRevisionId/);
  assert.match(editor, /expectedBranchHeadBodySha256: selectedBranchEntry\.headBodySha256/);
  assert.match(editor, /expectedBranchWorkingLockVersion: selectedBranchEntry\.articleWorkingLockVersion/);
  assert.match(editor, /接入工程/);
  assert.match(editor, /它不会创建新的文章分支，也不会推进或覆盖源码分支/);
});

test("保存和提交都绑定当前分支的五重 CAS，不回退到单主线覆盖", () => {
  assert.match(editor, /"save_working_package", \{[\s\S]*branchId: detail\.selectedBranchId,[\s\S]*expectedBranchLockVersion:[\s\S]*expectedWorkingLockVersion:[\s\S]*expectedBaseCompositionId:[\s\S]*expectedBaseRevisionId:/);
  assert.match(editor, /"commit", \{[\s\S]*branchId: detail\.selectedBranchId,[\s\S]*expectedBranchLockVersion:[\s\S]*expectedWorkingLockVersion:[\s\S]*expectedBaseCompositionId:[\s\S]*expectedBaseRevisionId:/);
  assert.match(editor, /文章工程分支详情不完整；没有进入兼容单主线写入模式/);
  assert.match(editor, /返回了另一条分支，已阻止跨分支编辑/);
});

test("迁移阻断与分支桥接失步在界面上只读并说明恢复条件", () => {
  assert.match(editor, /migrationBlocked/);
  assert.match(editor, /editorReadOnly/);
  assert.match(editor, /project-editor-workarea" disabled=\{editorReadOnly\}/);
  assert.match(editor, /系统不会猜测旧内容版本的分支归属；请先处理迁移审计，再恢复写入/);
  assert.match(editor, /迁移审计阻断：先只读核对/);
  assert.match(css, /\.project-readonly-banner/);
  assert.match(css, /\.project-branch-entry-panel/);
});
