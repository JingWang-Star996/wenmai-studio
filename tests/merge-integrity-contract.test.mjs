import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8");
const shell = await readFile(new URL("../app/WorkbenchShell.tsx", import.meta.url), "utf8");
const permissionCatalog = await readFile(new URL("../app/agent-permission-catalog.ts", import.meta.url), "utf8");

test("prepare/save merge commands bind canonical authorized-actor receipts", () => {
  assert.match(route, /requireManagementSession\(request, \{ mutation: true, scope: "workspace\.branch\.write" \}\)/);
  assert.match(route, /requireManagementOrPrivilegedAgent\(request, database\(\), \{/);
  assert.match(route, /import \{ agentActionAuthorization \} from "\.\.\/\.\.\/agent-permission-catalog"/);
  assert.match(route, /const agentAuthorization = agentActionAuthorization\("workspace", action\)/);
  assert.match(route, /if \(agentRequest && !agentAuthorization\) \{\s*throw new ApiError\("owner-only 工作区动作不能携带 Agent Bearer Key", 403\)/);
  assert.match(route, /agentScope: agentAuthorization\?\.scope \?\? "__owner_only__"/);
  assert.match(route, /agentActionId: agentAuthorization\?\.actionId/);
  assert.match(route, /localOnly: agentAuthorization\?\.localOnly \?\? true/);
  assert.match(route, /allowedRoles: agentAuthorization\?\.allowedRoles \?\? \[\]/);
  for (const [scope, action] of [
    ["workspace.merge.prepare", "prepare_merge"],
    ["workspace.merge.resolve", "save_merge_resolution"],
    ["workspace.merge.apply", "merge_revision"],
  ]) {
    assert.match(permissionCatalog, new RegExp(`(?:historical|highRisk)\\("${scope}",[^\\n]+\\[action\\("workspace", "workspace\\.${action}", "${action}"\\)\\]`));
  }
  assert.match(route, /actorId = principal\.actorId/);
  assert.match(route, /actorId = managementActorId\(managementPrincipal\)/);
  assert.match(route, /prepare_merge:\s*\{\s*managementScope: "workspace\.merge\.apply"/);
  assert.match(route, /save_merge_resolution:\s*\{\s*managementScope: "workspace\.merge\.apply"/);
  assert.match(route, /merge_revision:\s*\{\s*managementScope: "workspace\.merge\.apply"/);
  assert.match(route, /const action = "prepare_merge"/);
  assert.match(route, /const action = "save_merge_resolution"/);
  assert.match(route, /canonicalJson\(\{ action, actorId, payload: receiptPayload \}\)/);
  assert.match(route, /workspace\.prepare_merge/);
  assert.match(route, /workspace\.save_merge_resolution/);
  assert.match(route, /COMMAND_ID_REUSED/);
  assert.match(route, /COMMAND_IN_PROGRESS/);
  assert.doesNotMatch(route, /DELETE FROM command_receipts/);
});

test("prepare/save freeze both heads and both clean copy locks inside the write batch", () => {
  for (const coordinate of [
    "expectedSourceHeadRevisionId",
    "expectedTargetHeadRevisionId",
    "expectedSourceCopyLockVersion",
    "expectedTargetCopyLockVersion",
  ]) {
    assert.match(route, new RegExp(coordinate));
    assert.match(shell, new RegExp(coordinate));
  }
  assert.match(route, /source_copy\.base_revision_id = source\.head_revision_id AND source_copy\.dirty = 0 AND source_copy\.lock_version = \?/);
  assert.match(route, /target_copy\.base_revision_id = target\.head_revision_id AND target_copy\.dirty = 0 AND target_copy\.lock_version = \?/);
  assert.match(route, /CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_proposals_active_heads/);
  assert.match(route, /ON merge_proposals\(source_branch_id, target_branch_id, source_head_revision_id, target_head_revision_id\)/);
  assert.match(route, /WHERE status IN \('prepared', 'resolving', 'ready'\)/);
});

test("resolution audit id is deterministic and merge_revision remains receipt guarded", () => {
  assert.match(route, /const eventId = `event-merge-resolution-\$\{proposalId\}-\$\{nextLockVersion\}`/);
  assert.match(route, /event_type, subject_type, subject_id, article_id, payload_json, input_sha256/);
  assert.match(route, /if \(action === "merge_revision"\) return await mergeRevision\(db, payload, actorId, agentRequest\)/);
  assert.match(shell, /commandId: `workspace-prepare-merge:\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(shell, /commandId: `workspace-save-merge-resolution:\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(shell, /commandId: `workspace-merge:\$\{crypto\.randomUUID\(\)\}`/);
});

test("merge stages persist actor identity and Agent authority lineage enforces separation while owner can take over", () => {
  assert.match(route, /prepare_actor_id TEXT/);
  assert.match(route, /resolution_actor_id TEXT/);
  assert.match(route, /apply_actor_id TEXT/);
  assert.match(route, /ALTER TABLE merge_proposals ADD COLUMN \$\{column\} TEXT/);
  assert.match(route, /prepare_actor_id, unresolved_count, status/);
  assert.match(route, /resolution_actor_id = \?/);
  assert.match(route, /apply_actor_id = \?/);
  assert.match(route, /import \{ sameAgentAuthorityLineage \} from "\.\.\/\.\.\/site-full-control-auth"/);
  assert.match(route, /AGENT_ACTOR_ID_PATTERN = \/\^agent-client:\(agent-client-/);
  assert.match(route, /actorId\.startsWith\("management-session:"\)\) return null/);
  assert.match(route, /assertDistinctAgentAuthorityLineage\(db, actorId, currentProposal\.prepare_actor_id, "准备"\)/);
  assert.match(route, /assertDistinctAgentAuthorityLineage\(db, actorId, proposal\.prepare_actor_id, "准备"\)/);
  assert.match(route, /assertDistinctAgentAuthorityLineage\(db, actorId, proposal\.resolution_actor_id, "解决"\)/);
  assert.match(route, /sameAgentAuthorityLineage\(db, currentClientId, recordedClientId\)/);
  assert.match(route, /MERGE_AGENT_ACTOR_BINDING_MISSING/);
  assert.match(route, /\(\? = 0 OR \(p\.prepare_actor_id IS NOT NULL AND p\.prepare_actor_id <> \?\)\)/);
  assert.match(route, /\(\? = 0 OR \(p\.prepare_actor_id IS NOT NULL AND p\.prepare_actor_id <> \?\s*\n\s*AND p\.resolution_actor_id IS NOT NULL AND p\.resolution_actor_id <> \?\)\)/);
  assert.match(route, /agentRequest \? 1 : 0/);
});
