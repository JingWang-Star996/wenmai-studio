export const AGENT_PRIVILEGE_ROLES = ["administrator", "super_admin"] as const;

export type AgentPrivilegeRole = (typeof AGENT_PRIVILEGE_ROLES)[number];

/** 存量 v1 Key 的完整历史合同；仅用于认证，不用于新签发。 */
export const ADMINISTRATOR_LEGACY_SCOPES = [
  "task.read",
  "context.read",
  "knowledge.read",
  "graph.read",
  "package.read",
  "task.manage",
] as const;

/** 当前管理员合同；新签发显式包含共享来源元数据读取。 */
export const ADMINISTRATOR_SCOPES = [
  ...ADMINISTRATOR_LEGACY_SCOPES,
  "shared_source.read",
] as const;

/** 存量 v1 Key 的完整历史合同；仅用于认证，不用于新签发。 */
export const SUPER_ADMIN_LEGACY_SCOPES = [
  ...ADMINISTRATOR_LEGACY_SCOPES,
  "approval.decide",
  "graph.decide",
  "package.patch.decide",
  "package.patch.apply",
  "workspace.publication_branch.create",
  "package.branch.attach",
  "publication.version.register",
  "workspace.merge.prepare",
  "workspace.merge.resolve",
  "workspace.merge.apply",
  "publish.capability.consume",
] as const;

/** 历史 v2 兼容合同，仅用于认证；不包含 shared_source.read。 */
export const SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES = [
  ...SUPER_ADMIN_LEGACY_SCOPES,
  "workspace.branch.write",
  "package.working_copy.save",
  "package.revision.commit",
] as const;

/** 当前超级管理员合同；新签发显式包含共享来源元数据读取。 */
export const SUPER_ADMIN_SCOPES = [
  ...SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES,
  "shared_source.read",
] as const;

export const PRIVILEGED_AGENT_SCOPES = [
  "task.manage",
  "approval.decide",
  "graph.decide",
  "package.patch.decide",
  "package.patch.apply",
  "workspace.publication_branch.create",
  "package.branch.attach",
  "publication.version.register",
  "workspace.merge.prepare",
  "workspace.merge.resolve",
  "workspace.merge.apply",
  "publish.capability.consume",
  "workspace.branch.write",
  "package.working_copy.save",
  "package.revision.commit",
] as const;

export const WORKER_OR_CANDIDATE_AGENT_SCOPES = [
  "task.claim",
  "task.progress",
  "task.complete",
  "artifact.create",
  "approval.request",
  "graph.propose",
  "branch.agent_write",
  "package.patch.propose",
  "article.import.new_root",
] as const;

export const AGENT_ROLE_CONTRACTS = Object.freeze({
  administrator: Object.freeze({
    role: "administrator" as const,
    scopes: Object.freeze([...ADMINISTRATOR_SCOPES]),
    articleIds: Object.freeze(["*"] as const),
    taskIds: Object.freeze([] as const),
    maxLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  }),
  super_admin: Object.freeze({
    role: "super_admin" as const,
    scopes: Object.freeze([...SUPER_ADMIN_SCOPES]),
    articleIds: Object.freeze(["*"] as const),
    taskIds: Object.freeze([] as const),
    maxLifetimeMs: 7 * 24 * 60 * 60 * 1000,
  }),
});

export type AgentPrivilegeProfile = (typeof AGENT_ROLE_CONTRACTS)[AgentPrivilegeRole];

function exactStringSet(actual: readonly string[], expected: readonly string[]) {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  if (actualSet.size !== actual.length) return false;
  return expected.every((value) => actualSet.has(value));
}

export function isAgentPrivilegeRole(value: unknown): value is AgentPrivilegeRole {
  return typeof value === "string" && (AGENT_PRIVILEGE_ROLES as readonly string[]).includes(value);
}

export function classifyAgentPrivilegeProfile(
  scopes: readonly string[],
  articleIds: readonly string[],
  taskIds: readonly string[],
): AgentPrivilegeRole | null {
  if (!exactStringSet(articleIds, ["*"]) || !exactStringSet(taskIds, [])) return null;
  if (superAdminProfileVersion(scopes) !== null) return "super_admin";
  if (administratorProfileVersion(scopes) !== null) return "administrator";
  return null;
}

export function administratorProfileVersion(scopes: readonly string[]) {
  if (exactStringSet(scopes, ADMINISTRATOR_SCOPES)) return "administrator_v2" as const;
  if (exactStringSet(scopes, ADMINISTRATOR_LEGACY_SCOPES)) return "administrator_v1" as const;
  return null;
}

export function superAdminProfileVersion(scopes: readonly string[]) {
  if (exactStringSet(scopes, SUPER_ADMIN_SCOPES)) return "super_admin_internal_v3" as const;
  if (exactStringSet(scopes, SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES)) return "super_admin_internal_v2" as const;
  if (exactStringSet(scopes, SUPER_ADMIN_LEGACY_SCOPES)) return "super_admin_internal_v1" as const;
  return null;
}

export function hasPrivilegedAgentScope(scopes: readonly string[]) {
  const privileged = new Set<string>(PRIVILEGED_AGENT_SCOPES);
  return scopes.some((scope) => privileged.has(scope));
}

export function hasWorkerOrCandidateAgentScope(scopes: readonly string[]) {
  const workerOrCandidate = new Set<string>(WORKER_OR_CANDIDATE_AGENT_SCOPES);
  return scopes.some((scope) => workerOrCandidate.has(scope));
}

export function validateAgentPrivilegeIssuance(input: {
  role: unknown;
  scopes: readonly string[];
  articleIds: readonly string[];
  taskIds: readonly string[];
  expiresAtMs: number;
  nowMs?: number;
}) {
  const role = isAgentPrivilegeRole(input.role) ? input.role : null;
  const privilegedRequested = hasPrivilegedAgentScope(input.scopes);
  if (!role && !privilegedRequested) {
    return { privileged: false as const, role: null, errors: [] as string[] };
  }
  if (!role) {
    return {
      privileged: true as const,
      role: null,
      errors: ["privileged Agent scopes require an explicit administrator or super_admin role"],
    };
  }
  const contract = AGENT_ROLE_CONTRACTS[role];
  const errors: string[] = [];
  if (!exactStringSet(input.scopes, contract.scopes)) errors.push(`${role} scopes must match the exact role contract`);
  if (!exactStringSet(input.articleIds, contract.articleIds)) errors.push(`${role} articleIds must be exactly ['*']`);
  if (!exactStringSet(input.taskIds, contract.taskIds)) errors.push(`${role} taskIds must be empty`);
  if (hasWorkerOrCandidateAgentScope(input.scopes)) errors.push(`${role} cannot mix worker, candidate, or local-import scopes`);
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(input.expiresAtMs) || input.expiresAtMs <= nowMs) errors.push(`${role} expiresAt must be in the future`);
  if (input.expiresAtMs > nowMs + contract.maxLifetimeMs) {
    errors.push(`${role} lifetime exceeds ${role === "super_admin" ? 7 : 30} days`);
  }
  return { privileged: true as const, role, errors };
}
