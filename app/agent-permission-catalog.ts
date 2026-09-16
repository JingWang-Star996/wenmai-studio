/** 服务端权限目录：签发、认证和管理界面必须共用此唯一事实源。 */
import {
  ADMINISTRATOR_LEGACY_SCOPES,
  SUPER_ADMIN_LEGACY_SCOPES,
  SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES,
} from "./agent-role-contract.ts";

export const AGENT_PERMISSION_CATALOG_SCHEMA_VERSION = "wenmai.agent-permission-catalog/3" as const;
export const AGENT_PERMISSION_CATALOG_VERSION = "2026-09-10.1" as const;
export const HIGH_RISK_NEW_ISSUANCE_AUTHORIZED = true as const;

export type CatalogAction = Readonly<{ actionId: string; wireAction: string; route: string; method: "POST"; stableCommandId: true; cas: true }>;
export type CatalogScope = Readonly<{ scope: string; label: string; description: string; category: string; risk: "read" | "controlled_write" | "high_risk" | "historical" | "reserved"; allowedRoles: readonly ("administrator" | "super_admin")[]; transport: "local/tailscale" | "local" | "owner"; localOnly: boolean; delegable: boolean; newIssuance: boolean; conflictsWith: readonly string[]; actions: readonly CatalogAction[] }>;
const action = (route: string, actionId: string, wireAction: string): CatalogAction => ({ actionId, wireAction, route, method: "POST", stableCommandId: true, cas: true });
const safe = (scope: string, label: string, actions: readonly CatalogAction[] = [], allowedRoles: readonly ("administrator" | "super_admin")[] = ["administrator", "super_admin"], localOnly = false, description = "输入精确 scope 与动作快照，由所有者签发；只允许目录列出的动作，输出仍须按证据核验"): CatalogScope => ({ scope, label, description, category: actions.length ? "受控工作流" : "只读", risk: actions.length ? "controlled_write" : "read", allowedRoles, transport: localOnly ? "local" : "local/tailscale", localOnly, delegable: true, newIssuance: true, conflictsWith: [], actions });
const highRisk = (scope: string, label: string, actions: readonly CatalogAction[] = [], conflictsWith: readonly string[] = []): CatalogScope => ({ scope, label, description: "输入精确 scope、动作快照和文章边界后，才可在本机执行受控动作；同一权限谱系不能审批或应用自己发起的候选", category: "高风险本机受控", risk: "high_risk", allowedRoles: ["super_admin"], transport: "local", localOnly: true, delegable: HIGH_RISK_NEW_ISSUANCE_AUTHORIZED, newIssuance: HIGH_RISK_NEW_ISSUANCE_AUTHORIZED, conflictsWith, actions });
const publishCapabilityConsume = (): CatalogScope => ({
  ...highRisk("publish.capability.consume", "消费发布能力票据", [action("publish-capability-v1", "publish-capability.v1.consume", "consume")], ["__any_other_mutable_scope__"]),
  description: "发布能力票据只能按当前批次单独签发并单次消费；site.full_control 或普通长期 Agent Key 均不能获得此项",
  delegable: false,
  newIssuance: false,
});
const reserved = (scope: string): CatalogScope => ({ scope, label: "所有者保留权限", description: "此 scope 只接受所有者或用户根权限操作；Agent 不可申请、委派、批准或执行", category: "所有者保留", risk: "reserved", allowedRoles: [], transport: "owner", localOnly: false, delegable: false, newIssuance: false, conflictsWith: [], actions: [] });
const siteFullControl = (): CatalogScope => ({
  scope: "site.full_control",
  label: "网站根完整控制（仅本机）",
  description: "仅本机、最长 7 天的站点根完整控制 Key；可直接调用受签名管理范围约束的 Agent/管理 API，也可兑换管理会话。不能替代外部平台登录、验证码或每批次最终公开授权。",
  category: "根权限",
  risk: "high_risk",
  allowedRoles: ["super_admin"],
  transport: "local",
  localOnly: true,
  delegable: true,
  newIssuance: true,
  conflictsWith: ["__all_other_scopes__"],
  actions: [action("auth", "auth.site_full_control.direct", "site_full_control.direct"), action("auth", "auth.site_full_control.exchange", "site_full_control.exchange")],
});

const BASE_READ_SCOPES = ["task.read", "context.read", "knowledge.read", "graph.read", "package.read", "shared_source.read"] as const;
const SAFE_INTERNAL_ALL_SCOPES = [...BASE_READ_SCOPES, "task.manage", "workspace.branch.write", "workspace.publication_branch.create", "package.branch.attach", "publication.version.register"] as const;

export type PermissionScopeCombinationValidation = Readonly<{ valid: boolean; code: "PERMISSION_SCOPE_COMBINATION_CONFLICT" | null; conflicts: readonly string[]; message: string | null }>;

/** 供未来签发 route 与当前管理 UI 共用的纯组合门禁。 */
export function validatePermissionScopeCombination(scopes: readonly string[]): PermissionScopeCombinationValidation {
  const selected = new Set(scopes);
  if (selected.has("site.full_control") && selected.size !== 1) {
    return { valid: false, code: "PERMISSION_SCOPE_COMBINATION_CONFLICT", conflicts: [...selected].filter((scope) => scope !== "site.full_control").sort(), message: "Agent 站内全权（本机）必须独占，不能与其他 scope 同时签发。" };
  }
  const mutableScopes = new Set(AGENT_PERMISSION_CATALOG.filter((entry) => entry.actions.length > 0).map((entry) => entry.scope));
  if (selected.has("publish.capability.consume") && [...selected].some((scope) => scope !== "publish.capability.consume" && mutableScopes.has(scope))) {
    return { valid: false, code: "PERMISSION_SCOPE_COMBINATION_CONFLICT", conflicts: ["publish.capability.consume"], message: "消费发布能力票据不能与任何其他可变更 scope 同时签发。" };
  }
  const patchConflicts = ["package.patch.decide", "package.patch.apply"].filter((scope) => selected.has(scope));
  if (patchConflicts.length > 1) return { valid: false, code: "PERMISSION_SCOPE_COMBINATION_CONFLICT", conflicts: patchConflicts, message: "Package Patch 决定与应用权限必须分开签发。" };
  const mergeConflicts = ["workspace.merge.prepare", "workspace.merge.resolve", "workspace.merge.apply"].filter((scope) => selected.has(scope));
  if (mergeConflicts.length > 1) return { valid: false, code: "PERMISSION_SCOPE_COMBINATION_CONFLICT", conflicts: mergeConflicts, message: "合并准备、解决和应用必须按单阶段分开签发。" };
  return { valid: true, code: null, conflicts: [], message: null };
}

export const AGENT_PERMISSION_CATALOG = Object.freeze([
  siteFullControl(),
  safe("task.read", "读取任务"), safe("context.read", "读取上下文"), safe("knowledge.read", "读取知识"), safe("graph.read", "读取图谱"), safe("package.read", "读取文章包"), safe("shared_source.read", "读取共享来源元数据", [], ["administrator", "super_admin"], false, "只读返回经来源、绑定、权利与访问快照共同允许的共享来源元数据；不返回正文、摘录、content_ref 或提供方原始标识"),
  safe("task.manage", "管理任务", [action("agent-v1", "agent.v1.create_task", "create_task"), action("agent-v1", "agent.v1.update_task", "update_task"), action("agent-v1", "agent.v1.cancel_task", "cancel_task")], ["administrator", "super_admin"], false, "输入任务范围后，可创建、更新或取消任务专属 Agent 分支、Revision 或 WorkingCopy；不能改主分支、发布分支或代替人工决定"),
  safe("workspace.branch.write", "写入工作区分支", [action("workspace", "workspace.save_working_copy", "save_working_copy"), action("workspace", "workspace.commit_revision", "commit_revision")], ["super_admin"], true),
  highRisk("package.working_copy.save", "保存文章包工作副本", [action("project-package", "project-package.save_working_package", "save_working_package")]),
  highRisk("package.revision.commit", "提交文章包修订", [action("project-package", "project-package.commit", "commit")]),
  safe("workspace.publication_branch.create", "创建发布分支", [action("workspace", "workspace.create_publication_branch", "create_publication_branch")], ["super_admin"], true),
  safe("package.branch.attach", "附接文章包分支", [action("project-package", "project-package.attach_branch", "attach_branch")], ["super_admin"], true),
  safe("publication.version.register", "登记发布版本", [action("project-package", "project-package.register_publication_version", "register_publication_version")], ["super_admin"], true),
  highRisk("approval.decide", "决定审批", [action("agent-v1", "agent.v1.decide_approval", "decide_approval")]), highRisk("graph.decide", "决定图谱提案", [action("agent-v1", "agent.v1.decide_graph_proposal", "decide_graph_proposal")]),
  highRisk("package.patch.decide", "决定文章包补丁", [action("project-package", "project-package.decide_patch", "decide_patch")], ["package.patch.apply"]), highRisk("package.patch.apply", "应用文章包补丁", [action("project-package", "project-package.apply_patch", "apply_patch")], ["package.patch.decide"]),
  highRisk("workspace.merge.prepare", "准备合并", [action("workspace", "workspace.prepare_merge", "prepare_merge")], ["workspace.merge.resolve", "workspace.merge.apply"]), highRisk("workspace.merge.resolve", "解决合并", [action("workspace", "workspace.save_merge_resolution", "save_merge_resolution")], ["workspace.merge.prepare", "workspace.merge.apply"]), highRisk("workspace.merge.apply", "应用合并", [action("workspace", "workspace.merge_revision", "merge_revision")], ["workspace.merge.prepare", "workspace.merge.resolve"]), publishCapabilityConsume(),
  // 以下条目只供 UI 解释边界；never delegable。
  ...["identity.login","identity.2fa","identity.account.switch","agent_key.issue","agent_key.revoke","runner_token.issue","runner_token.revoke","publish.capability.issue","publish.external.click","release.approve","release.submission.claim","release.destination.claim","release.public.claim","release.outcome.claim","model.paid.invoke","rule.verified","rule.adopted","skill.verified","skill.adopted","processing.profile.approve","editorial.approve","package.write","lifecycle.write","identity.decide","runner.manage","release.record"].map(reserved),
] satisfies readonly CatalogScope[]);

export const AGENT_PERMISSION_PRESETS = Object.freeze({
  site_full_control: { label: "Agent 站内全权（本机）", description: "仅本机、最长 7 天；同一 Key 可直接调用受签名管理范围约束的 API，也可兑换管理会话。外部平台登录、验证码与最终公开动作仍须当前批次的一次性授权。", scopes: ["site.full_control"] },
  read_admin: { label: "只读管理员", description: "读取内部任务与文章工程上下文", scopes: BASE_READ_SCOPES },
  task_admin: { label: "任务管理员", description: "读取并管理任务专属 Agent 分支", scopes: [...BASE_READ_SCOPES, "task.manage"] },
  content_editor_admin: { label: "内容编辑管理员", description: "读取并写入 Agent 专属工作分支", scopes: [...BASE_READ_SCOPES, "workspace.branch.write"] },
  release_prep_admin: { label: "发布准备管理员", description: "创建发布分支、附接工程分支并登记版本", scopes: [...BASE_READ_SCOPES, "workspace.publication_branch.create", "package.branch.attach", "publication.version.register"] },
  all_delegable_internal: { label: "Agent 文章工作全权（直接使用）", description: "可直接交给 Codex、QwenPaw 或 MCP；包含任务读取/管理、工作区分支写入、发布分支创建、文章包分支附接和版本登记；不含外部登录、验证码或最终公开点击。", scopes: SAFE_INTERNAL_ALL_SCOPES },
  package_revision_operator: { label: "文章包修订操作员", description: "本机保存和提交文章包修订", scopes: [...BASE_READ_SCOPES, "package.working_copy.save", "package.revision.commit"] },
  internal_candidate_reviewer: { label: "内部候选审阅员", description: "本机决定审批、图谱提案和 Package Patch 候选", scopes: [...BASE_READ_SCOPES, "approval.decide", "graph.decide", "package.patch.decide"] },
  package_patch_applier: { label: "文章包补丁应用员", description: "本机应用已获准的单一 Package Patch", scopes: [...BASE_READ_SCOPES, "package.patch.apply"] },
  merge_preparer: { label: "合并准备员", description: "本机仅准备合并", scopes: [...BASE_READ_SCOPES, "workspace.merge.prepare"] },
  merge_resolver: { label: "合并解决员", description: "本机仅保存合并解决方案", scopes: [...BASE_READ_SCOPES, "workspace.merge.resolve"] },
  merge_applier: { label: "合并应用员", description: "本机仅应用已准备的合并", scopes: [...BASE_READ_SCOPES, "workspace.merge.apply"] },
  publish_ticket_consumer: { label: "发布票据消费者", description: "本机仅消费所有者签发的一次性发布能力票据", scopes: [...BASE_READ_SCOPES, "publish.capability.consume"] },
});

export const HISTORICAL_PRIVILEGE_PROFILES = Object.freeze({
  // 历史 Key 兼容解释专用；v3 新签发只以 catalog snapshot 为准。
  administrator_v1: [...ADMINISTRATOR_LEGACY_SCOPES],
  super_admin_internal_v1: [...SUPER_ADMIN_LEGACY_SCOPES],
  super_admin_internal_v2: [...SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES],
});

export function agentActionAuthorization(routeId: string, wireAction: string) {
  for (const entry of AGENT_PERMISSION_CATALOG) for (const item of entry.actions) {
    if (item.route === routeId && item.wireAction === wireAction) return { actionId: item.actionId, scope: entry.scope, allowedRoles: entry.allowedRoles, localOnly: entry.localOnly };
  }
  return null;
}
export function derivePrivilegeRoleForScopes(scopes: readonly string[]) {
  if (scopes.length === 1 && scopes[0] === "site.full_control") return "super_admin" as const;
  const admin = new Set(["task.read", "context.read", "knowledge.read", "graph.read", "package.read", "shared_source.read", "task.manage"]);
  return scopes.every((scope) => admin.has(scope)) ? "administrator" as const : "super_admin" as const;
}
export function expandPermissionPreset(presetId: string) { const preset = (AGENT_PERMISSION_PRESETS as Record<string, { scopes: readonly string[] }>)[presetId]; return preset ? [...preset.scopes] : null; }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") { const item = value as Record<string, unknown>; return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`; }
  return JSON.stringify(value);
}

export function canonicalAgentPermissionCatalog() {
  return {
    schemaVersion: AGENT_PERMISSION_CATALOG_SCHEMA_VERSION, catalogVersion: AGENT_PERMISSION_CATALOG_VERSION,
    scopes: [...AGENT_PERMISSION_CATALOG].sort((a, b) => a.scope.localeCompare(b.scope)).map((entry) => ({
      scope: entry.scope, label: entry.label, description: entry.description, category: entry.category, risk: entry.risk,
      allowedRoles: [...entry.allowedRoles].sort(), transport: entry.transport, localOnly: entry.localOnly, delegable: entry.delegable, newIssuance: entry.newIssuance, conflictsWith: [...entry.conflictsWith].sort(),
      actions: [...entry.actions].sort((a, b) => a.actionId.localeCompare(b.actionId)).map((item) => ({ actionId: item.actionId, wireAction: item.wireAction, route: item.route, method: item.method, stableCommandId: item.stableCommandId, cas: item.cas })),
    })),
    presets: Object.entries(AGENT_PERMISSION_PRESETS).sort(([a], [b]) => a.localeCompare(b)).map(([presetId, preset]) => ({ presetId, label: preset.label, description: preset.description, scopes: [...preset.scopes].sort() })),
  };
}
export async function agentPermissionCatalogSha256() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(canonicalAgentPermissionCatalog())));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function actionIdsForPermissionScopes(scopes: readonly string[]) {
  const entries = new Map(AGENT_PERMISSION_CATALOG.map((entry) => [entry.scope, entry]));
  return [...new Set(scopes.flatMap((scope) => entries.get(scope)?.actions.map((item) => item.actionId) ?? []))].sort();
}
export function publicAgentPermissionCatalog() {
  return canonicalAgentPermissionCatalog();
}
