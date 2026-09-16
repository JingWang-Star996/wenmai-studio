import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const staticPath = path.join(projectRoot, "dist", "server", "_next", "static");
const canonicalOrigin = "http://[::1]:3000";

const administratorScopes = [
  "task.read",
  "context.read",
  "knowledge.read",
  "graph.read",
  "package.read",
  "task.manage",
];

const superAdminScopes = [
  ...administratorScopes,
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
];

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function agentToken() {
  return `wenmai_agent_${randomBytes(16).toString("hex")}_${randomBytes(16).toString("hex")}`;
}

function request(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "[::1]:3000");
  headers.set("x-forwarded-host", "[::1]:3000");
  return new MiniflareRequest(`${canonicalOrigin}${pathname}`, {
    redirect: "manual",
    ...init,
    headers,
  });
}

async function json(response) {
  return { response, payload: await response.json() };
}

let compiledModulesPromise;
async function compiledRouteModules() {
  if (compiledModulesPromise) return compiledModulesPromise;
  compiledModulesPromise = (async () => {
    const names = (await readdir(staticPath)).filter((name) => name.endsWith(".js"));
    const sources = await Promise.all(names.map(async (name) => ({
      name,
      contents: await readFile(path.join(staticPath, name), "utf8"),
    })));
    const route = (marker, label) => {
      const match = sources.find((source) => source.name.startsWith("route-")
        && source.contents.includes(marker));
      assert.ok(match, `没有在 production build 中找到 ${label} 路由`);
      return `./${match.name}`;
    };
    const agentRoute = route("Wenmai Agent Control Plane", "Agent API");
    const workspaceRoute = route("未知工作区动作", "workspace");
    const projectPackageRoute = route("未知文章工程动作", "project-package");
    const entry = `
      import * as agent from ${JSON.stringify(agentRoute)};
      import * as workspace from ${JSON.stringify(workspaceRoute)};
      import * as projectPackage from ${JSON.stringify(projectPackageRoute)};
      export default {
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          const route = pathname === "/api/agent/v1" ? agent
            : pathname === "/api/workspace" ? workspace
              : pathname === "/api/project-package/v1" ? projectPackage
                : null;
          const handler = route?.[request.method];
          const headers = new Headers(request.headers);
          headers.set("host", "[::1]:3000");
          headers.set("x-forwarded-host", "[::1]:3000");
          return handler
            ? handler(new Request(request, { headers }))
            : new Response("not found", { status: 404 });
        }
      };
    `;
    return [
      { type: "ESModule", path: "privileged-agent-routes-test-worker.mjs", contents: entry },
      ...sources.map((source) => ({
        type: "ESModule",
        path: source.name,
        contents: source.contents,
      })),
    ];
  })();
  return compiledModulesPromise;
}

async function insertPrivilegedClient(db, { id, role, token, scopes }) {
  const createdAt = new Date(Date.now() - 1_000);
  const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1_000);
  await db.prepare(`INSERT INTO agent_clients
    (id, label, client_kind, role, token_sha256, scopes_json, article_ids_json, task_ids_json,
     status, expires_at, last_seen_at, created_at)
    VALUES (?, ?, 'codex', ?, ?, ?, '["*"]', '[]', 'active', ?, NULL, ?)`)
    .bind(
      id,
      `${role} privileged route integration`,
      role,
      sha256(token),
      JSON.stringify(scopes),
      expiresAt.toISOString(),
      createdAt.toISOString(),
    )
    .run();
}

function workspacePost(token, action, commandId, payload = {}, extraHeaders = {}) {
  return request("/api/workspace", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "sec-fetch-site": "none",
      ...extraHeaders,
    },
    body: JSON.stringify({ action, ...(commandId ? { commandId } : {}), ...payload }),
  });
}

function packagePost(token, action, commandId, payload = {}, extraHeaders = {}) {
  return request("/api/project-package/v1", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "sec-fetch-site": "none",
      ...extraHeaders,
    },
    body: JSON.stringify({ action, ...(commandId ? { commandId } : {}), payload }),
  });
}

test("production routes 只让本机 super_admin 穿透 workspace/package 的精确特权动作", async (context) => {
  const mf = new Miniflare({
    modules: await compiledRouteModules(),
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    publicUrl: canonicalOrigin,
    d1Databases: { DB: `privileged-agent-routes-test-${randomUUID()}` },
    log: new NoOpLog(),
  });
  context.after(() => mf.dispose());

  // Agent API owns the agent_clients compatibility bootstrap. All three routes then share this D1.
  const initialized = await json(await mf.dispatchFetch(request("/api/agent/v1?view=health")));
  assert.equal(initialized.response.status, 401);
  const db = await mf.getD1Database("DB");

  const superAdminId = `agent-client-${randomUUID()}`;
  const superAdminToken = agentToken();
  const administratorId = `agent-client-${randomUUID()}`;
  const administratorToken = agentToken();
  await insertPrivilegedClient(db, {
    id: superAdminId,
    role: "super_admin",
    token: superAdminToken,
    scopes: superAdminScopes,
  });
  await insertPrivilegedClient(db, {
    id: administratorId,
    role: "administrator",
    token: administratorToken,
    scopes: administratorScopes,
  });

  const missingWorkspaceCommand = await json(await mf.dispatchFetch(workspacePost(
    superAdminToken,
    "prepare_merge",
    "",
  )));
  assert.equal(missingWorkspaceCommand.response.status, 400);
  assert.match(String(missingWorkspaceCommand.payload.error), /commandId/u);

  const missingPackageCommand = await json(await mf.dispatchFetch(packagePost(
    superAdminToken,
    "decide_patch",
    "",
  )));
  assert.equal(missingPackageCommand.response.status, 400);
  assert.equal(missingPackageCommand.payload.error.code, "MISSING_FIELD");
  assert.equal(missingPackageCommand.payload.error.details.field, "commandId");

  const workspaceActions = [
    ["create_publication_branch", /packageId/u],
    ["prepare_merge", /文章 ID/u],
    ["save_merge_resolution", /合并提案 ID/u],
    ["merge_revision", /合并提案 ID/u],
  ];
  for (const [action, businessError] of workspaceActions) {
    const reachedBusinessValidation = await json(await mf.dispatchFetch(workspacePost(
      superAdminToken,
      action,
      `super-admin-${action}-${randomUUID()}`,
    )));
    assert.equal(reachedBusinessValidation.response.status, 400, action);
    assert.match(String(reachedBusinessValidation.payload.error), businessError, action);

    const administratorDenied = await json(await mf.dispatchFetch(workspacePost(
      administratorToken,
      action,
      `administrator-${action}-${randomUUID()}`,
    )));
    assert.equal(administratorDenied.response.status, 403, action);

    const tailscaleDenied = await json(await mf.dispatchFetch(workspacePost(
      superAdminToken,
      action,
      `tailscale-${action}-${randomUUID()}`,
      {},
      { "x-wenmai-agent-transport": "tailscale-gateway" },
    )));
    assert.equal(tailscaleDenied.response.status, 421, action);
  }

  const packageActions = ["attach_branch", "register_publication_version", "decide_patch", "apply_patch"];
  for (const action of packageActions) {
    const reachedBusinessValidation = await json(await mf.dispatchFetch(packagePost(
      superAdminToken,
      action,
      `super-admin-${action}-${randomUUID()}`,
    )));
    assert.equal(reachedBusinessValidation.response.status, 400, action);
    assert.equal(reachedBusinessValidation.payload.error.code, "MISSING_FIELD", action);
    assert.notEqual(reachedBusinessValidation.payload.error.details.field, "commandId", action);

    const administratorDenied = await json(await mf.dispatchFetch(packagePost(
      administratorToken,
      action,
      `administrator-${action}-${randomUUID()}`,
    )));
    assert.equal(administratorDenied.response.status, 403, action);
    assert.equal(administratorDenied.payload.error.code, "PRIVILEGED_ROLE_DENIED", action);

    const tailscaleDenied = await json(await mf.dispatchFetch(packagePost(
      superAdminToken,
      action,
      `tailscale-${action}-${randomUUID()}`,
      {},
      { "x-wenmai-agent-transport": "tailscale-gateway" },
    )));
    assert.equal(tailscaleDenied.response.status, 421, action);
    assert.equal(tailscaleDenied.payload.error.code, "PRIVILEGED_TRANSPORT_REQUIRED", action);
  }

  const articleId = `article-${randomUUID()}`;
  const packageId = `pkg-${randomUUID()}`;
  const canonicalBranchId = `branch-${randomUUID()}`;
  const canonicalRevisionId = `revision-${randomUUID()}`;
  const canonicalCompositionId = `composition-${randomUUID()}`;
  const canonicalBody = "# Canonical baseline\n\nPublicationVersion branch integration.";
  const canonicalBodySha256 = sha256(canonicalBody);
  const canonicalCompositionSha256 = sha256("canonical-composition");
  const canonicalDocumentSha256 = sha256("canonical-document");
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO article_branches
      (id, article_id, name, slug, color, status, head_revision_id, base_revision_id, base_source_version_id, created_at, updated_at)
      VALUES (?, ?, 'canonical', 'canonical', 'blue', 'active', ?, ?, NULL, ?, ?)`)
      .bind(canonicalBranchId, articleId, canonicalRevisionId, canonicalRevisionId, now, now),
    db.prepare(`INSERT INTO article_revisions
      (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id,
       title, document_title, annotation, body_text, body_sha256, author_kind, created_at)
      VALUES (?, ?, ?, 1, NULL, NULL, NULL, 'canonical', 'Publication branch integration', '', ?, ?, 'user', ?)`)
      .bind(canonicalRevisionId, articleId, canonicalBranchId, canonicalBody, canonicalBodySha256, now),
    db.prepare(`INSERT INTO branch_working_copies
      (branch_id, article_id, base_revision_id, title, annotation, body_text, body_sha256, dirty, lock_version, updated_at)
      VALUES (?, ?, ?, 'Publication branch integration', '', ?, ?, 0, 1, ?)`)
      .bind(canonicalBranchId, articleId, canonicalRevisionId, canonicalBody, canonicalBodySha256, now),
    db.prepare(`INSERT INTO article_project_packages
      (id, project_id, article_id, title, schema_version, branch_model_version, primary_branch_id,
       main_composition_id, main_composition_sha256, status, lock_version, created_at, updated_at)
      VALUES (?, ?, ?, 'Publication branch integration', 'wenmai-package-v1', 2, ?, ?, ?, 'active', 1, ?, ?)`)
      .bind(packageId, `project-${randomUUID()}`, articleId, canonicalBranchId,
        canonicalCompositionId, canonicalCompositionSha256, now, now),
    db.prepare(`INSERT INTO package_branch_states
      (package_id, branch_id, head_composition_id, head_composition_sha256, head_revision_id,
       status, lock_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`)
      .bind(packageId, canonicalBranchId, canonicalCompositionId, canonicalCompositionSha256,
        canonicalRevisionId, now, now),
    db.prepare(`INSERT INTO package_branch_working_copies
      (package_id, branch_id, base_composition_id, base_revision_id, document_json,
       document_sha256, dirty, lock_version, updated_at)
      VALUES (?, ?, ?, ?, '{}', ?, 0, 1, ?)`)
      .bind(packageId, canonicalBranchId, canonicalCompositionId, canonicalRevisionId,
        canonicalDocumentSha256, now),
  ]);

  const publicationBranchCommandId = `super-admin-create-publication-branch-${randomUUID()}`;
  const publicationBranchPayload = {
    packageId,
    platform: "zhihu",
    name: "知乎发布版本",
    expectedPackageLockVersion: 1,
    expectedCanonicalBranchId: canonicalBranchId,
    expectedCanonicalBranchLockVersion: 1,
    expectedCanonicalRevisionId: canonicalRevisionId,
    expectedCanonicalBodySha256: canonicalBodySha256,
    expectedCanonicalCompositionId: canonicalCompositionId,
    expectedCanonicalCompositionSha256: canonicalCompositionSha256,
  };
  const publicationBranchCreated = await json(await mf.dispatchFetch(workspacePost(
    superAdminToken,
    "create_publication_branch",
    publicationBranchCommandId,
    publicationBranchPayload,
  )));
  assert.equal(publicationBranchCreated.response.status, 201);
  assert.equal(publicationBranchCreated.payload.packageId, packageId);
  assert.equal(publicationBranchCreated.payload.platform, "zhihu");
  assert.equal(publicationBranchCreated.payload.bodySha256, canonicalBodySha256);
  assert.equal(publicationBranchCreated.payload.boundary.externalActionPerformed, false);
  assert.equal(publicationBranchCreated.payload.boundary.publishClicked, false);

  const publicationBranchReplay = await json(await mf.dispatchFetch(workspacePost(
    superAdminToken,
    "create_publication_branch",
    publicationBranchCommandId,
    publicationBranchPayload,
  )));
  assert.equal(publicationBranchReplay.response.status, 201);
  assert.equal(publicationBranchReplay.payload.branchId, publicationBranchCreated.payload.branchId);
  assert.equal(publicationBranchReplay.payload.revisionId, publicationBranchCreated.payload.revisionId);
  assert.equal(publicationBranchReplay.payload.workItemId, publicationBranchCreated.payload.workItemId);
  assert.equal(publicationBranchReplay.payload.replayed, true);

  const publicationBranchChangedReplay = await json(await mf.dispatchFetch(workspacePost(
    superAdminToken,
    "create_publication_branch",
    publicationBranchCommandId,
    { ...publicationBranchPayload, name: "同一命令不能改名" },
  )));
  assert.equal(publicationBranchChangedReplay.response.status, 409);
  assert.match(String(publicationBranchChangedReplay.payload.error), /COMMAND_ID_REUSED/u);

  const branchRows = await db.prepare(`SELECT branch.id, revision.author_kind
    FROM article_branches branch JOIN article_revisions revision ON revision.id = branch.head_revision_id
    WHERE branch.article_id = ? AND revision.parent_revision_id = ?`).bind(articleId, canonicalRevisionId).all();
  assert.equal(branchRows.results.length, 1);
  assert.equal(branchRows.results[0].id, publicationBranchCreated.payload.branchId);
  assert.equal(branchRows.results[0].author_kind, "agent");
  const branchReceipt = await db.prepare(`SELECT actor_id, status_code FROM command_receipts
    WHERE id = ? LIMIT 1`).bind(publicationBranchCommandId).first();
  assert.equal(branchReceipt.actor_id, `agent-client:${superAdminId}`);
  assert.equal(Number(branchReceipt.status_code), 201);
  const branchEvent = await db.prepare(`SELECT payload_json FROM workspace_events
    WHERE event_type = 'publication.branch_created' AND subject_id = ? LIMIT 1`)
    .bind(publicationBranchCreated.payload.branchId).first();
  assert.equal(JSON.parse(branchEvent.payload_json).actorId, `agent-client:${superAdminId}`);

  const attachCommandId = `super-admin-attach-publication-branch-${randomUUID()}`;
  const attached = await json(await mf.dispatchFetch(packagePost(
    superAdminToken,
    "attach_branch",
    attachCommandId,
    {
      packageId,
      branchId: publicationBranchCreated.payload.branchId,
      expectedBranchHeadRevisionId: publicationBranchCreated.payload.revisionId,
      expectedBranchHeadBodySha256: canonicalBodySha256,
      expectedBranchWorkingLockVersion: 1,
    },
  )));
  assert.equal(attached.response.status, 201);
  assert.equal(attached.payload.ok, true);
  assert.equal(attached.payload.data.attached, true);
  assert.equal(attached.payload.data.created, true);
  assert.equal(attached.payload.data.boundary.articleBranchCreated, false);
  const attachReplay = await json(await mf.dispatchFetch(packagePost(
    superAdminToken,
    "attach_branch",
    attachCommandId,
    {
      packageId,
      branchId: publicationBranchCreated.payload.branchId,
      expectedBranchHeadRevisionId: publicationBranchCreated.payload.revisionId,
      expectedBranchHeadBodySha256: canonicalBodySha256,
      expectedBranchWorkingLockVersion: 1,
    },
  )));
  assert.equal(attachReplay.response.status, 201);
  assert.equal(attachReplay.payload.data.branchState.branchId, publicationBranchCreated.payload.branchId);

  const cookieMixed = await json(await mf.dispatchFetch(workspacePost(
    superAdminToken,
    "prepare_merge",
    `cookie-mixed-${randomUUID()}`,
    {},
    { cookie: "wenmai_management_session=ambiguous" },
  )));
  assert.equal(cookieMixed.response.status, 403);
  assert.match(String(cookieMixed.payload.error), /不能同时携带浏览器 Cookie/u);

  const browserMixed = await json(await mf.dispatchFetch(packagePost(
    superAdminToken,
    "decide_patch",
    `origin-mixed-${randomUUID()}`,
    {},
    { origin: canonicalOrigin, "sec-fetch-site": "same-origin" },
  )));
  assert.equal(browserMixed.response.status, 403);
  assert.equal(browserMixed.payload.error.code, "BROWSER_REQUEST_FORBIDDEN");

  const workspaceOwnerOnly = await json(await mf.dispatchFetch(workspacePost(
    superAdminToken,
    "create_branch",
    `owner-only-workspace-${randomUUID()}`,
  )));
  assert.equal(workspaceOwnerOnly.response.status, 403);
  assert.match(String(workspaceOwnerOnly.payload.error), /owner-only/u);

  const packageOwnerOnly = await json(await mf.dispatchFetch(packagePost(
    superAdminToken,
    "create_slice",
    `owner-only-package-${randomUUID()}`,
  )));
  assert.equal(packageOwnerOnly.response.status, 403);
  assert.equal(packageOwnerOnly.payload.error.code, "AMBIGUOUS_AUTH_FORBIDDEN");

  const seen = await db.prepare("SELECT last_seen_at FROM agent_clients WHERE id = ?")
    .bind(superAdminId)
    .first();
  assert.ok(seen.last_seen_at, "super_admin 通过认证后应更新 last_seen_at");
});
