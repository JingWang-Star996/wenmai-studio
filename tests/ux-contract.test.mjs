import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const agentUi = readFileSync(new URL("../app/AgentConsole.tsx", import.meta.url), "utf8");
const distributionUi = readFileSync(new URL("../app/DistributionHub.tsx", import.meta.url), "utf8");
const platformCapabilityFilter = readFileSync(new URL("../app/platform-capability-filter.ts", import.meta.url), "utf8");
const shellUi = readFileSync(new URL("../app/WorkbenchShell.tsx", import.meta.url), "utf8");
const previewUi = readFileSync(new URL("../app/ArticlePreview.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const lifecycleRoute = readFileSync(new URL("../app/api/lifecycle/route.ts", import.meta.url), "utf8");

test("Agent 面板使用当前上下文与最新事件，不把最旧记录当实时状态", () => {
  assert.match(agentUi, /context\.id === selectedTask\?\.currentContextSnapshotId/);
  assert.match(agentUi, /const latestDetailEvent = detail\?\.events\[0\]/);
  assert.match(agentUi, /detail\.events\.slice\(0, 60\)\.reverse\(\)/);
  assert.doesNotMatch(agentUi, /detail\.events\.at\(-1\)/);
});

test("Agent 权限和专属分支写入使用实际网关字段", () => {
  assert.match(agentUi, /baseBranchId: taskBranchId \|\| null/);
  assert.match(agentUi, /permissionCeiling: \{ allow: scopes/);
  assert.match(agentUi, /branch\.agent_write/);
  assert.match(agentUi, /不能写 main 或自行合并/);
  assert.match(agentUi, /复制连通测试/);
  assert.match(agentUi, /Agent 以后只引用档案名，不把明文 Key 写进命令或配置/);
  assert.match(agentUi, /命令本身不含秘密/);
  assert.match(agentUi, /\/\.well-known\/wenmai-agent\.json/);
  assert.match(agentUi, /\/agent\/api\/v1\.json/);
});

test("发行轨道逐轴读取证据，并使用最新门禁", () => {
  assert.match(distributionUi, /snapshot\.buildGates\.find\(/);
  assert.match(distributionUi, /approvalState === "approved"/);
  assert.match(distributionUi, /submissionState === "submission_accepted"/);
  assert.match(distributionUi, /destinationState === "backend_verified"/);
  assert.match(distributionUi, /publicState === "public_verified"/);
  assert.match(distributionUi, /metric\.releaseId === release\.id/);
  assert.doesNotMatch(distributionUi, /index\s*<=\s*stage\.level/);
});

test("平台画像改版显示历史绑定影响并要求确认", () => {
  assert.match(distributionUi, /selectedTargetImpact/);
  assert.match(distributionUi, /确认平台画像版本影响/);
  assert.match(distributionUi, /新发行需重新建立合同与构建工件/);
});

test("平台 Skill 候选来自动态能力阶段与维度，不在网站复制 Skill 名单", () => {
  assert.doesNotMatch(distributionUi, /COMMON_RELEASE_SKILLS/);
  assert.match(platformCapabilityFilter, /capability\.stages\.some/);
  assert.match(platformCapabilityFilter, /capability\.dimension/);
  assert.match(distributionUi, /平台直接命中/);
  assert.match(distributionUi, /通用发行能力/);
  assert.match(distributionUi, /skillQuery/);
  assert.match(platformCapabilityFilter, /belongsToAnotherPlatform/);
  assert.match(platformCapabilityFilter, /GENERIC_TOOL_EXCLUSION/);
  assert.match(distributionUi, /可找到不代表已经验证/);
});

test("六类移植规则逐条启停，并随现有平台画像 JSON 保存", () => {
  for (const key of ["title", "intro", "cover", "body", "topics", "disclosure"]) {
    assert.match(distributionUi, new RegExp(`\\["${key}",`));
  }
  assert.match(distributionUi, /type PlatformRuleDraft = \{ enabled: boolean; text: string \}/);
  assert.match(distributionUi, /role="switch"[\s\S]*aria-checked=\{draft\.enabled\}/);
  assert.match(distributionUi, /profile: \{[\s\S]*rules,/);
  assert.match(distributionUi, /readRuleDraft\(profileRules\[key\]\)/);
  assert.match(distributionUi, /Object\.values\(targetRules\)\.filter\(ruleIsActive\)/);
  assert.match(distributionUi, /不会运行自动检查、提交内容或证明适配已经完成/);
});

test("平台注册表允许直接登记环境，但不把登记冒充为登录或发布授权", () => {
  assert.match(distributionUi, /＋ 登记平台/);
  assert.match(distributionUi, /新平台已登记/);
  assert.match(distributionUi, /登记不会登录平台，也不会授予发布权限/);
  assert.match(distributionUi, /connectionStatus: "not_connected"/);
  assert.match(distributionUi, /skillIds: \[\]/);
  assert.match(distributionUi, /newPlatformError && <div className="distribution-dialog-error" role="alert">/);
  assert.match(distributionUi, /if \(result\.platformTarget\) setSelectedTargetId\(result\.platformTarget\.id\)/);
  assert.match(distributionUi, /event\.key === "Escape"/);
  assert.match(distributionUi, /newPlatformKeyRef\.current\?\.focus\(\)/);
  assert.match(distributionUi, /event\.key !== "Tab"/);
  assert.match(distributionUi, /newPlatformDialogRef\.current\?\.querySelectorAll/);
});

test("资料库分类、队列筛选和能力详情都作用于真实结果", () => {
  assert.match(shellUi, /libraryBucketFilter/);
  assert.match(shellUi, /aria-pressed=\{libraryBucketFilter === bucket\}/);
  assert.match(shellUi, /queuePlatform/);
  assert.match(shellUi, /queueTag/);
  assert.match(shellUi, /filteredCapabilities\.find\(/);
  assert.match(shellUi, /阶段图只按关键词和目录关系导航/);
});

test("图书馆以证据分类成七个书架，并按需读取局部文章开发树", () => {
  for (const shelf of ["已发布文章", "平台成品", "创作草稿", "来源素材", "研究与质检", "能力与工具", "证据与目录"]) {
    assert.match(shellUi, new RegExp(shelf));
  }
  assert.match(shellUi, /article\.classification\.class/);
  assert.match(shellUi, /setLibraryMode\("lineage"\)/);
  assert.match(shellUi, /view: "lineage"/);
  assert.match(shellUi, /\/api\/corpus\/v1\?/);
  assert.match(shellUi, /artifact_of/);
  assert.match(shellUi, /edge\.status === "confirmed"/);
  assert.match(shellUi, /evidenceRefs/);
});

test("能力页默认是阶段流程图，表格与流程图都保留", () => {
  assert.match(shellUi, /useState<"table" \| "flow">\("flow"\)/);
  assert.match(shellUi, /capability-flow-overview/);
  assert.match(shellUi, /aria-label="八阶段能力全景"/);
  assert.match(shellUi, /capability-flow-rail/);
  assert.match(shellUi, /STAGES\.map/);
  assert.match(shellUi, />按阶段查看<\/button>/);
  assert.match(shellUi, />查看元素表<\/button>/);
});

test("宽屏总览与窄屏纵向模式不再只依赖横向滚动", () => {
  assert.match(css, /\.capability-flow-overview\s*\{[\s\S]*grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.capability-flow-rail\s*\{[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(css, /\.release-flow-map\s*\{[\s\S]*grid-template-columns:\s*repeat\(9, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.release-flow-map\s*\{[\s\S]*grid-template-columns:\s*1fr/);
  assert.doesNotMatch(css, /\.release-flow-map\s*\{[^}]*min-width:\s*1320px/);
  assert.doesNotMatch(css, /\.release-checklist\s*\{[^}]*min-width:\s*1080px/);
});

test("窄屏主导航明确提示横向浏览，并把十二个入口锁在同一行", () => {
  const navItems = shellUi.match(/const NAV_ITEMS:[\s\S]*?\];/)?.[0] ?? "";
  assert.equal((navItems.match(/\{ id: "/g) ?? []).length, 12);
  assert.match(shellUi, /左右滑动 · 12 个工作区/);
  assert.match(css, /\.factory-sidebar nav\s*\{[\s\S]*grid-template-columns:\s*repeat\(12, 74px\)[\s\S]*grid-auto-flow:\s*column/);
  assert.doesNotMatch(css, /\.factory-sidebar nav\s*\{[^}]*repeat\(7,/);
});

test("证据页先解释用途与下一步，技术事件和原始 JSON 后置", () => {
  assert.match(shellUi, /选择要确认的对象和证据/);
  assert.match(shellUi, /检查这篇文章能否进入下一步/);
  assert.match(shellUi, /变更记录/);
  assert.match(shellUi, /检查结果/);
  assert.match(shellUi, /数据来源/);
  assert.match(shellUi, /<details><summary>技术详情<\/summary>/);
});

test("文章快链按需读取正文，并覆盖队列、资料库与当前文章", () => {
  assert.match(previewUi, /\/api\/version-text/);
  assert.match(previewUi, /version\.storage === "d1"[\s\S]*\/api\/workspace\?articleId=/);
  assert.match(shellUi, /revisionCount: item\.revisionCount/);
  assert.match(shellUi, /versions: revisions/);
  assert.match(shellUi, /item\.status === "active"/);
  assert.match(previewUi, /aria-modal="true"/);
  assert.match(shellUi, /article-queue-preview/);
  assert.match(shellUi, /预览全文/);
  assert.match(shellUi, /sidebar-current[\s\S]*ArticleQuickLink/);
  assert.match(agentUi, /ArticleQuickLink articleId=\{task\.articleId\} className="agent-task-preview"/);
  assert.match(distributionUi, /ArticleQuickLink articleId=\{article\.id\}/);
  assert.match(shellUi, /选择基线[\s\S]*ArticleQuickLink articleId=\{selectedArticle\.id\} versionId=\{version\.id\}>预览全文/);
  assert.match(shellUi, /setRevisionPreviewId\(revision\.id\)[\s\S]*预览修订/);
  assert.match(shellUi, /RevisionPreviewDialog revision=\{previewRevision\}/);
  assert.match(agentUi, /ArticleQuickLink articleId=\{taskArticleId\}>预览全文与版本/);
  assert.doesNotMatch(agentUi, /articles\.filter\(\(article\) => article\.kind === "文章"\)/);
});

test("资料库把相似关系放入待整理队列，确认前不自动合并", () => {
  assert.match(shellUi, /待整理 · 相似与血缘候选/);
  assert.match(shellUi, /不会自动合并/);
  assert.match(shellUi, /relation\.status === "suggested"/);
  assert.match(shellUi, /setLineageSeed\(source\.id\)/);
  assert.match(css, /\.lineage-candidate-queue > div\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
});

test("资料库把语料归属错绑独立呈现，并绑定 exact-hash 与 clean-copy 门禁", () => {
  assert.match(shellUi, /语料归属错绑/);
  assert.match(shellUi, /mismatch\.evidence\.bodyShaMatchesOwnerTextHash/);
  assert.match(shellUi, /mismatch\.lock\.workingCopyDirty === true/);
  assert.match(shellUi, /生成可回滚归属修复计划/);
  assert.match(css, /\.source-owner-mismatch-list > article/);
});

test("DeepSeek 只审阅冻结候选，出网前显示预算且不会自动决定文章身份", () => {
  assert.match(shellUi, /article-lineage-ai\/v1\?view=status/);
  assert.match(shellUi, /"prepare_review"/);
  assert.match(shellUi, /候选输入已冻结在本地；尚未调用模型，也尚未产生费用/);
  assert.match(shellUi, /本次本地费用硬上限/);
  assert.match(shellUi, /只会给出候选建议，不会合并、归档或修改正文/);
  assert.match(shellUi, /candidateOnly: true/);
  assert.doesNotMatch(shellUi, /prepareLineageAiReview\([\s\S]{0,120}applyIdentityPlan/);
});

test("被后续事实击穿的 planned 操作只做非删除式 supersede 收口", () => {
  assert.match(shellUi, /article-identity\/v1\?view=integrity/);
  assert.match(shellUi, /stalePlannedOperations/);
  assert.match(shellUi, /"supersede_stale_operation"/);
  assert.match(shellUi, /计划、摘要与审计行会完整保留/);
  assert.match(shellUi, /不会再次合并、归档或删除任何文章/);
});

test("选题与系列建议把真实文章 ID 渲染成可预览快链", () => {
  assert.match(shellUi, /opportunity\.relatedArticleIds\.map/);
  assert.match(shellUi, /series\.articleIds\.map/);
  assert.match(shellUi, /形成这个判断的已有文章/);
  assert.match(shellUi, /系列中的真实文章/);
  assert.match(shellUi, /<ArticleQuickLink key=\{article\.id\} articleId=\{article\.id\}>\{article\.title\}<\/ArticleQuickLink>/);
});

test("Agent 自定义面板使用原生模态层并恢复触发焦点", () => {
  assert.match(agentUi, /<dialog ref=\{composerDialogRef\}/);
  assert.match(agentUi, /<dialog ref=\{clientDialogRef\}/);
  assert.match(agentUi, /dialog\.showModal\(\)/);
  assert.match(agentUi, /composerInitialFocusRef\.current\?\.focus\(\)/);
  assert.match(agentUi, /clientInitialFocusRef\.current\?\.focus\(\)/);
  assert.match(agentUi, /composerReturnFocusRef\.current\?\.focus\(\)/);
  assert.match(agentUi, /clientReturnFocusRef\.current\?\.focus\(\)/);
  assert.match(agentUi, /onCancel=\{\(event\) => \{ event\.preventDefault\(\); setComposerOpen\(false\); \}\}/);
  assert.match(agentUi, /onKeyDown=\{\(event\) => \{ if \(event\.key === "Escape"\) \{ event\.preventDefault\(\); setComposerOpen\(false\); \} \}\}/);
  assert.match(css, /\.agent-modal::backdrop/);
});

test("只读辅助资产可以快览，但不会被误送入文章工程", () => {
  assert.match(previewUi, /canOpenWorkspace\?: \(article: WorkbenchArticle\) => boolean/);
  assert.match(previewUi, /canOpenWorkspace \? <button type="button" className="article-preview-primary" onClick=\{openWorkspace\}>进入文章工程继续制作<\/button> : null/);
  assert.match(shellUi, /canOpenWorkspace=\{\(article\) => articleWorks\.some/);
});

test("平台停用会阻断新合同、Build 和发行主链", () => {
  assert.match(lifecycleRoute, /profile\.enabled/);
  assert.match(lifecycleRoute, /平台画像已停用/);
  assert.match(lifecycleRoute, /json_extract\([^\n]+enabled/);
});

test("系统事件先显示人话摘要，原始 JSON 收进技术详情", () => {
  assert.match(shellUi, /function workspaceEventSummary/);
  assert.match(shellUi, /<summary>技术详情<\/summary>/);
  assert.match(shellUi, /本地系统或操作者/);
});
