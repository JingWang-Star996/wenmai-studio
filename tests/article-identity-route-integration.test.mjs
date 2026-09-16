import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverPath = path.join(root, "dist", "server");
const staticPath = path.join(serverPath, "_next", "static");
const canonicalOrigin = "http://[::1]:3000";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function request(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "[::1]:3000");
  headers.set("x-forwarded-host", "[::1]:3000");
  return new MiniflareRequest(`${canonicalOrigin}${pathname}`, { redirect: "manual", ...init, headers });
}

async function compiledModules() {
  const names = (await readdir(staticPath)).filter((name) => name.endsWith(".js"));
  const sources = await Promise.all(names.map(async (name) => ({ name, contents: await readFile(path.join(staticPath, name), "utf8") })));
  const route = (marker) => {
    const match = sources.find((source) => source.name.startsWith("route-") && source.contents.includes(marker));
    assert.ok(match, `production build 缺少 ${marker}`);
    return `./${match.name}`;
  };
  const auth = route("PAIRING_CODE_REQUIRED");
  const identity = route("wenmai-article-identity-v1");
  const entry = `
    import * as auth from ${JSON.stringify(auth)};
    import * as identity from ${JSON.stringify(identity)};
    export default { async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const route = pathname === "/api/auth" ? auth : pathname === "/api/article-identity/v1" ? identity : null;
      const handler = route?.[request.method];
      const headers = new Headers(request.headers); headers.set("host", "[::1]:3000");
      return handler ? handler(new Request(request, { headers })) : new Response("not found", { status: 404 });
    }};
  `;
  return [
    { type: "ESModule", path: "article-identity-test-worker.mjs", contents: entry },
    ...sources.map((source) => ({ type: "ESModule", path: source.name, contents: source.contents })),
  ];
}

async function createHarness() {
  const pairingSelector = randomBytes(16).toString("base64url");
  const pairingCode = `wenmai1.${pairingSelector}.${randomBytes(16).toString("base64url")}`;
  const browserBinding = randomBytes(32).toString("base64url");
  const now = new Date();
  const mf = new Miniflare({
    modules: await compiledModules(), compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat"],
    publicUrl: canonicalOrigin, d1Databases: { DB: `identity-route-${randomUUID()}` }, log: new NoOpLog(),
    bindings: {
      WENMAI_AUTH_CANONICAL_ORIGIN: canonicalOrigin,
      WENMAI_AUTH_BOOT_ID: `management-boot-${randomBytes(16).toString("base64url")}`,
      WENMAI_AUTH_CHALLENGE_ID: `management-challenge-${pairingSelector}`,
      WENMAI_AUTH_PAIRING_SHA256: sha256(pairingCode),
      WENMAI_AUTH_CHALLENGE_CREATED_AT: now.toISOString(),
      WENMAI_AUTH_CHALLENGE_EXPIRES_AT: new Date(now.getTime() + 300_000).toISOString(),
      WENMAI_AUTH_CSRF_HMAC_KEY: randomBytes(32).toString("base64url"),
    },
  });
  return { mf, pairingCode, browserBinding };
}

async function initializeMigrations(mf) {
  const db = await mf.getD1Database("DB");
  const migrations = (await readdir(path.join(root, "drizzle"))).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  for (const name of migrations) {
    const sql = await readFile(path.join(root, "drizzle", name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  return db;
}

async function bootstrap(harness) {
  const bindingHeaders = { "X-Wenmai-Browser-Binding": harness.browserBinding };
  let response = await harness.mf.dispatchFetch(request("/api/auth", { headers: bindingHeaders }));
  assert.equal(response.status, 200, await response.text());
  response = await harness.mf.dispatchFetch(request("/api/auth", {
    method: "POST",
    headers: { ...bindingHeaders, "content-type": "application/json", origin: canonicalOrigin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ action: "bootstrap", pairingCode: harness.pairingCode, browserBindingSha256: sha256(harness.browserBinding) }),
  }));
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";", 1)[0], csrf: payload.data.csrfToken };
}

async function identityPost(harness, session, action, commandId, payload) {
  const response = await harness.mf.dispatchFetch(request("/api/article-identity/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: canonicalOrigin, "sec-fetch-site": "same-origin",
      cookie: session.cookie, "X-Wenmai-CSRF": session.csrf, "X-Wenmai-Browser-Binding": harness.browserBinding,
    },
    body: JSON.stringify({ action, commandId, payload }),
  }));
  return { response, payload: await response.json() };
}

async function identityGet(harness, session, query) {
  const response = await harness.mf.dispatchFetch(request(`/api/article-identity/v1?${query}`, {
    headers: { cookie: session.cookie, "X-Wenmai-Browser-Binding": harness.browserBinding },
  }));
  return { response, payload: await response.json() };
}

async function seedRsiFixture(db) {
  const oldArticle = "local-article-old-rsi";
  const newArticle = "local-article-new-rsi";
  const oldBranch = "branch-old-rsi";
  const newBranch = "branch-new-rsi";
  const oldRevision = "revision-old-rsi";
  const newRevision = "revision-new-rsi";
  const oldPackage = "pkg-old-rsi";
  const newPackage = "pkg-new-rsi";
  const oldSha = "a".repeat(64);
  const newSha = "b".repeat(64);
  const shared = ["## 发生了什么", "RSI 不是魔法。", "## 证据", "我们需要分开能力与证据。", "## 普通人怎么办", "保留基线。", "记录结果。", "复盘规则。", "不要自动合并。"].join("\n");
  const oldBody = `# RSI 火了：AI 真的开始改进自己了吗？\n${shared}`;
  const newBody = `# RSI 调研：AI 自我改进走到哪一步\n${shared}`;
  const now = "2026-08-18T12:00:00.000Z";
  await db.batch([
    db.prepare(`INSERT INTO article_revisions
      (id,article_id,branch_id,sequence,title,document_title,annotation,body_text,body_sha256,author_kind,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(oldRevision, oldArticle, oldBranch, 1, "RSI 火了", "RSI 火了", "", oldBody, oldSha, "import", now),
    db.prepare(`INSERT INTO article_revisions
      (id,article_id,branch_id,sequence,title,document_title,annotation,body_text,body_sha256,author_kind,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(newRevision, newArticle, newBranch, 1, "RSI 调研", "RSI 调研", "", newBody, newSha, "import", now),
    db.prepare(`INSERT INTO article_branches
      (id,article_id,name,slug,color,status,head_revision_id,base_revision_id,created_at,updated_at)
      VALUES (?,?,?,?,?,'active',?,?,?,?)`).bind(oldBranch, oldArticle, "main", "main", "blue", oldRevision, oldRevision, now, now),
    db.prepare(`INSERT INTO article_branches
      (id,article_id,name,slug,color,status,head_revision_id,base_revision_id,created_at,updated_at)
      VALUES (?,?,?,?,?,'active',?,?,?,?)`).bind(newBranch, newArticle, "main", "main", "blue", newRevision, newRevision, now, now),
    db.prepare(`INSERT INTO branch_working_copies
      (branch_id,article_id,base_revision_id,title,annotation,body_text,body_sha256,dirty,lock_version,updated_at)
      VALUES (?,?,?,?,?,?,?,0,1,?)`).bind(oldBranch, oldArticle, oldRevision, "RSI 火了", "", oldBody, oldSha, now),
    db.prepare(`INSERT INTO branch_working_copies
      (branch_id,article_id,base_revision_id,title,annotation,body_text,body_sha256,dirty,lock_version,updated_at)
      VALUES (?,?,?,?,?,?,?,0,1,?)`).bind(newBranch, newArticle, newRevision, "RSI 调研", "", newBody, newSha, now),
    db.prepare(`INSERT INTO article_project_packages
      (id,article_id,title,main_composition_id,main_composition_sha256,status,lock_version,primary_branch_id,branch_model_version,created_at,updated_at)
      VALUES (?,?,?,?,?,'active',1,?,1,?,?)`).bind(oldPackage, oldArticle, "RSI 火了", "composition-old", oldSha, oldBranch, now, now),
    db.prepare(`INSERT INTO article_project_packages
      (id,article_id,title,main_composition_id,main_composition_sha256,status,lock_version,primary_branch_id,branch_model_version,created_at,updated_at)
      VALUES (?,?,?,?,?,'active',1,?,1,?,?)`).bind(newPackage, newArticle, "RSI 调研", "composition-new", newSha, newBranch, now, now),
    db.prepare(`INSERT INTO package_branch_states
      (package_id,branch_id,head_composition_id,head_composition_sha256,head_revision_id,status,lock_version,created_at,updated_at)
      VALUES (?,?,?,?,?,'active',1,?,?)`).bind(oldPackage, oldBranch, "composition-old", oldSha, oldRevision, now, now),
    db.prepare(`INSERT INTO package_branch_states
      (package_id,branch_id,head_composition_id,head_composition_sha256,head_revision_id,status,lock_version,created_at,updated_at)
      VALUES (?,?,?,?,?,'active',1,?,?)`).bind(newPackage, newBranch, "composition-new", newSha, newRevision, now, now),
    db.prepare(`INSERT INTO lifecycle_article_projects
      (id,article_id,title,intent,owner,phase,execution_state,lock_version,created_at,updated_at)
      VALUES (?,?,?,?,?,'operate','active',1,?,?)`).bind("lifecycle-new-rsi", newArticle, "RSI", "published lineage", "我", now, now),
  ]);
  return { oldArticle, newArticle, oldBranch, newBranch, oldRevision, newRevision, oldPackage, newPackage, oldSha, newSha };
}

test("built article identity route scans, plans, applies, projects and rolls back RSI without touching canonical lifecycle", async () => {
  const harness = await createHarness();
  try {
    const db = await initializeMigrations(harness.mf);
    const session = await bootstrap(harness);
    const fixture = await seedRsiFixture(db);
    const scan = await identityPost(harness, session, "scan_candidates", "identity.scan.rsi", {
      articleIds: [fixture.oldArticle, fixture.newArticle], threshold: 0.7,
    });
    assert.equal(scan.response.status, 201, JSON.stringify(scan.payload));
    assert.equal(scan.payload.data.autoApplied, false);
    assert.equal(scan.payload.data.candidateCount, 1);
    assert.equal(scan.payload.data.candidates[0].proposedRelation, "superseded_by");
    const replay = await identityPost(harness, session, "scan_candidates", "identity.scan.rsi", {
      articleIds: [fixture.oldArticle, fixture.newArticle], threshold: 0.7,
    });
    assert.equal(replay.response.status, 201, JSON.stringify(replay.payload));
    assert.equal(replay.payload.data.operationId, scan.payload.data.operationId);
    const reused = await identityPost(harness, session, "scan_candidates", "identity.scan.rsi", {
      articleIds: [fixture.oldArticle, fixture.newArticle], threshold: 0.75,
    });
    assert.equal(reused.response.status, 409, JSON.stringify(reused.payload));
    assert.equal(reused.payload.error.code, "COMMAND_ID_REUSED");

    const candidateView = await identityGet(harness, session, "view=candidates");
    assert.equal(candidateView.response.status, 200, JSON.stringify(candidateView.payload));
    const candidate = candidateView.payload.data.candidates[0];
    assert.equal(candidate.source_article_id, fixture.oldArticle);
    assert.equal(candidate.target_article_id, fixture.newArticle);

    const plan = await identityPost(harness, session, "plan_consolidation", "identity.plan.rsi", {
      candidateId: candidate.id,
      canonicalArticleId: fixture.newArticle, legacyArticleId: fixture.oldArticle,
      canonicalPackageId: fixture.newPackage, legacyPackageId: fixture.oldPackage,
      canonicalBranchId: fixture.newBranch, legacyBranchId: fixture.oldBranch,
      canonicalRevisionId: fixture.newRevision, legacyRevisionId: fixture.oldRevision,
      expectedCanonicalBodySha256: fixture.newSha, expectedLegacyBodySha256: fixture.oldSha,
      title: "RSI 调研", evidence: ["fixture:rsi-same-work"],
    });
    assert.equal(plan.response.status, 201, JSON.stringify(plan.payload));
    assert.equal(plan.payload.data.autoApplied, false);
    assert.equal(plan.payload.data.reusedPlan, false);
    const reusedPlan = await identityPost(harness, session, "plan_consolidation", "identity.plan.rsi.reuse", {
      candidateId: candidate.id,
      canonicalArticleId: fixture.newArticle, legacyArticleId: fixture.oldArticle,
      canonicalPackageId: fixture.newPackage, legacyPackageId: fixture.oldPackage,
      canonicalBranchId: fixture.newBranch, legacyBranchId: fixture.oldBranch,
      canonicalRevisionId: fixture.newRevision, legacyRevisionId: fixture.oldRevision,
      expectedCanonicalBodySha256: fixture.newSha, expectedLegacyBodySha256: fixture.oldSha,
      title: "RSI 调研的不同请求标题不会制造重复计划", evidence: ["fixture:second-request"],
    });
    assert.equal(reusedPlan.response.status, 200, JSON.stringify(reusedPlan.payload));
    assert.equal(reusedPlan.payload.data.reusedPlan, true);
    assert.equal(reusedPlan.payload.data.operationId, plan.payload.data.operationId);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM article_identity_operations WHERE operation_kind='consolidation' AND status='planned'").first()).count, 1);

    const plannedRow = await db.prepare("SELECT * FROM article_identity_operations WHERE id=?").bind(plan.payload.data.operationId).first();
    const duplicateOperationId = "identity-op-historical-duplicate";
    await db.prepare(`INSERT INTO article_identity_operations
      (id,operation_kind,status,identity_id,command_id,actor_id,plan_json,plan_sha256,preconditions_json,
       preconditions_sha256,inverse_json,result_json,sentinel,lock_version,planned_at,updated_at)
      VALUES (?,'consolidation','planned',?,?,?,?,?,?,?,?,'{}',?,1,?,?)`).bind(
      duplicateOperationId, plannedRow.identity_id, "historical.duplicate.command", plannedRow.actor_id,
      plannedRow.plan_json, plannedRow.plan_sha256, plannedRow.preconditions_json, plannedRow.preconditions_sha256,
      plannedRow.inverse_json, "historical-duplicate-sentinel", plannedRow.planned_at, plannedRow.updated_at,
    ).run();
    const prematureIntegrity = await identityGet(harness, session, "view=integrity");
    assert.equal(prematureIntegrity.response.status, 200, JSON.stringify(prematureIntegrity.payload));
    assert.deepEqual(prematureIntegrity.payload.data.stalePlannedOperations, []);
    assert.equal(prematureIntegrity.payload.data.stalePlannedOperationCount, 0);
    const prematureSupersession = await identityPost(harness, session, "supersede_stale_operation",
      "identity.supersede.premature", {
        operationId: duplicateOperationId,
        expectedPlanSha256: plannedRow.plan_sha256,
        expectedLockVersion: 1,
        evidence: ["candidate 尚未决定且没有 applied 证明，必须 fail-closed"],
      });
    assert.equal(prematureSupersession.response.status, 409, JSON.stringify(prematureSupersession.payload));
    assert.equal(prematureSupersession.payload.error.code, "SUPERSESSION_NOT_PROVEN");
    assert.equal((await db.prepare("SELECT status FROM article_identity_operations WHERE id=?")
      .bind(duplicateOperationId).first()).status, "planned");

    const apply = await identityPost(harness, session, "apply_consolidation", "identity.apply.rsi", {
      operationId: plan.payload.data.operationId, expectedPlanSha256: plan.payload.data.planSha256,
    });
    assert.equal(apply.response.status, 200, JSON.stringify(apply.payload));
    assert.equal(apply.payload.data.result.publicationReferencesMutated, false);
    assert.deepEqual(apply.payload.data.result.supersededPlannedOperationIds, [duplicateOperationId]);
    const autoSuperseded = await db.prepare("SELECT status,result_json FROM article_identity_operations WHERE id=?")
      .bind(duplicateOperationId).first();
    assert.equal(autoSuperseded.status, "rolled_back");
    assert.equal(JSON.parse(autoSuperseded.result_json).terminalDisposition, "superseded");
    const autoSupersededView = await identityGet(harness, session, `view=operation&operationId=${duplicateOperationId}`);
    assert.equal(autoSupersededView.response.status, 200, JSON.stringify(autoSupersededView.payload));
    assert.equal(autoSupersededView.payload.data.operation.effectiveStatus, "superseded");
    assert.equal((await db.prepare("SELECT status FROM article_project_packages WHERE id=?").bind(fixture.oldPackage).first()).status, "archived");
    assert.equal((await db.prepare("SELECT status FROM article_project_packages WHERE id=?").bind(fixture.newPackage).first()).status, "active");
    assert.equal((await db.prepare("SELECT execution_state FROM lifecycle_article_projects WHERE article_id=?").bind(fixture.newArticle).first()).execution_state, "active");

    const catalog = await identityGet(harness, session, "view=catalog");
    assert.equal(catalog.response.status, 200, JSON.stringify(catalog.payload));
    assert.ok(Array.isArray(catalog.payload.data.localArticles));
    const legacy = catalog.payload.data.localArticles.find((item) => item.articleId === fixture.oldArticle);
    assert.equal(legacy.catalogState, "hidden");
    assert.equal(legacy.canonicalArticleId, fixture.newArticle);
    assert.equal(legacy.revisionCount, 1);
    assert.equal(legacy.revisions[0].bodySha256, fixture.oldSha);

    const residualOperationId = "identity-op-historical-residual";
    await db.prepare(`INSERT INTO article_identity_operations
      (id,operation_kind,status,identity_id,command_id,actor_id,plan_json,plan_sha256,preconditions_json,
       preconditions_sha256,inverse_json,result_json,sentinel,lock_version,planned_at,updated_at)
      VALUES (?,'consolidation','planned',?,?,?,?,?,?,?,?,'{}',?,1,?,?)`).bind(
      residualOperationId, plannedRow.identity_id, "historical.residual.command", plannedRow.actor_id,
      plannedRow.plan_json, plannedRow.plan_sha256, plannedRow.preconditions_json, plannedRow.preconditions_sha256,
      plannedRow.inverse_json, "historical-residual-sentinel", plannedRow.planned_at, plannedRow.updated_at,
    ).run();
    const residualIntegrity = await identityGet(harness, session, "view=integrity");
    assert.equal(residualIntegrity.response.status, 200, JSON.stringify(residualIntegrity.payload));
    assert.equal(residualIntegrity.payload.data.stalePlannedOperationCount, 1);
    assert.equal(residualIntegrity.payload.data.stalePlannedOperations[0].operationId, residualOperationId);
    assert.equal(residualIntegrity.payload.data.stalePlannedOperations[0].planSha256, plannedRow.plan_sha256);
    assert.equal(residualIntegrity.payload.data.stalePlannedOperations[0].lockVersion, 1);
    assert.equal(residualIntegrity.payload.data.stalePlannedOperations[0].candidateId, candidate.id);
    assert.equal(residualIntegrity.payload.data.stalePlannedOperations[0].terminalProof.candidate.status, "confirmed");
    assert.equal(residualIntegrity.payload.data.stalePlannedOperations[0].terminalProof.appliedOperation.operationId,
      plan.payload.data.operationId);
    const reconcile = await identityPost(harness, session, "supersede_stale_operation", "identity.supersede.residual", {
      operationId: residualOperationId,
      expectedPlanSha256: plannedRow.plan_sha256,
      expectedLockVersion: 1,
      evidence: ["真实 candidate 已由另一 consolidation applied；该 planned 从未执行"],
    });
    assert.equal(reconcile.response.status, 200, JSON.stringify(reconcile.payload));
    assert.equal(reconcile.payload.data.status, "superseded");
    assert.equal(reconcile.payload.data.storageStatus, "rolled_back");
    assert.equal(reconcile.payload.data.autoApplied, false);
    assert.equal(reconcile.payload.data.deleted, false);
    const residualRow = await db.prepare("SELECT status,lock_version,result_json FROM article_identity_operations WHERE id=?")
      .bind(residualOperationId).first();
    assert.equal(residualRow.status, "rolled_back");
    assert.equal(residualRow.lock_version, 2);
    assert.equal(JSON.parse(residualRow.result_json).terminalDisposition, "superseded");
    const reconciledIntegrity = await identityGet(harness, session, "view=integrity");
    assert.equal(reconciledIntegrity.response.status, 200, JSON.stringify(reconciledIntegrity.payload));
    assert.equal(reconciledIntegrity.payload.data.stalePlannedOperationCount, 0);

    const rollback = await identityPost(harness, session, "rollback_operation", "identity.rollback.rsi", {
      operationId: plan.payload.data.operationId, expectedPlanSha256: plan.payload.data.planSha256,
    });
    assert.equal(rollback.response.status, 200, JSON.stringify(rollback.payload));
    assert.equal((await db.prepare("SELECT status FROM article_project_packages WHERE id=?").bind(fixture.oldPackage).first()).status, "active");
    assert.equal((await db.prepare("SELECT status FROM article_branches WHERE id=?").bind(fixture.oldBranch).first()).status, "active");
  } finally {
    await harness.mf.dispose();
  }
});

test("built source-owner repair copies to the corpus owner and fail-closed rollback retains immutable revision", async () => {
  const harness = await createHarness();
  try {
    const db = await initializeMigrations(harness.mf);
    const session = await bootstrap(harness);
    const sourceArticle = "art-10730a8d39";
    const sourceBranch = "branch-owner-fixture";
    const sourceRevision = "revision-owner-fixture";
    const sourceVersion = "ver-1869ae566e0c";
    const bodySha = "e342f3b526d23312b27fd30de5e491b4230d677701e7bcb73ae574f345e0d038";
    const now = "2026-08-18T13:00:00.000Z";
    await db.batch([
      db.prepare(`INSERT INTO article_revisions
        (id,article_id,branch_id,sequence,source_version_id,title,document_title,annotation,body_text,body_sha256,author_kind,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(sourceRevision, sourceArticle, sourceBranch, 1, sourceVersion,
        "内容与实验卡", "内容与实验卡", "", "# 内容与实验卡\n正文", bodySha, "import", now),
      db.prepare(`INSERT INTO article_branches
        (id,article_id,name,slug,color,status,head_revision_id,base_revision_id,base_source_version_id,created_at,updated_at)
        VALUES (?,?,?,?,?,'active',?,?,?,?,?)`).bind(sourceBranch, sourceArticle, "main", "main", "blue",
        sourceRevision, sourceRevision, sourceVersion, now, now),
      db.prepare(`INSERT INTO branch_working_copies
        (branch_id,article_id,base_revision_id,title,annotation,body_text,body_sha256,dirty,lock_version,updated_at)
        VALUES (?,?,?,?,?,?,?,0,1,?)`).bind(sourceBranch, sourceArticle, sourceRevision,
        "内容与实验卡", "", "# 内容与实验卡\n正文", bodySha, now),
      db.prepare(`INSERT INTO work_items
        (id,article_id,branch_id,title,kind,stage,state,priority,owner,next_action,blocker,sort_order,created_at,updated_at)
        VALUES (?,?,?,'推进内容与实验卡','article','writing','open','P1','我','继续写作','',0,?,?)`)
        .bind("work-owner-fixture", sourceArticle, sourceBranch, now, now),
    ]);

    const discovery = await identityGet(harness, session, "view=source_owner_mismatches");
    assert.equal(discovery.response.status, 200, JSON.stringify(discovery.payload));
    assert.equal(discovery.payload.data.autoRepairAttempted, false);
    assert.equal(discovery.payload.data.counts.mismatchCount, 1);
    const mismatch = discovery.payload.data.sourceOwnerMismatches[0];
    const targetArticle = mismatch.currentOwnerArticleId;
    assert.match(targetArticle, /^art-[a-z0-9-]+$/u);
    assert.deepEqual({
      sourceBranchId: mismatch.sourceBranchId,
      sourceArticleId: mismatch.sourceArticleId,
      sourceRevisionId: mismatch.sourceRevisionId,
      sourceVersionId: mismatch.sourceVersionId,
      sourceBodySha256: mismatch.sourceBodySha256,
      currentOwnerArticleId: mismatch.currentOwnerArticleId,
    }, {
      sourceBranchId: sourceBranch,
      sourceArticleId: sourceArticle,
      sourceRevisionId: sourceRevision,
      sourceVersionId: sourceVersion,
      sourceBodySha256: bodySha,
      currentOwnerArticleId: targetArticle,
    });
    assert.equal(mismatch.evidence.ownerCount, 1);
    assert.equal(mismatch.evidence.bodyShaMatchesOwnerTextHash, true);
    assert.equal(mismatch.evidence.repairAuthority, "read_only_detection_only");
    assert.equal(mismatch.lock.branchUpdatedAt, now);
    assert.equal(mismatch.lock.workingCopyLockVersion, 1);
    assert.equal(mismatch.lock.workingCopyDirty, false);

    const plan = await identityPost(harness, session, "plan_source_owner_repair", "identity.plan.owner", {
      sourceBranchId: sourceBranch, sourceRevisionId: sourceRevision,
      expectedSourceArticleId: sourceArticle, targetArticleId: targetArticle,
      sourceVersionId: sourceVersion, expectedBodySha256: bodySha,
      evidence: ["fixture:corpus-owner-and-textHash"],
    });
    assert.equal(plan.response.status, 201, JSON.stringify(plan.payload));
    assert.equal(plan.payload.data.plan.target.articleId, targetArticle);
    assert.equal(plan.payload.data.autoApplied, false);

    const apply = await identityPost(harness, session, "apply_source_owner_repair", "identity.apply.owner", {
      operationId: plan.payload.data.operationId, expectedPlanSha256: plan.payload.data.planSha256,
    });
    assert.equal(apply.response.status, 200, JSON.stringify(apply.payload));
    const newBranch = apply.payload.data.result.newBranchId;
    const newRevision = apply.payload.data.result.newRevisionId;
    assert.equal((await db.prepare("SELECT status FROM article_branches WHERE id=?").bind(sourceBranch).first()).status, "archived");
    const copiedRevision = await db.prepare("SELECT article_id,branch_id,body_sha256,source_version_id FROM article_revisions WHERE id=?")
      .bind(newRevision).first();
    assert.deepEqual(copiedRevision, { article_id: targetArticle, branch_id: newBranch, body_sha256: bodySha, source_version_id: sourceVersion });
    assert.equal((await db.prepare("SELECT dirty FROM branch_working_copies WHERE branch_id=?").bind(newBranch).first()).dirty, 0);
    assert.equal((await db.prepare("SELECT state FROM work_items WHERE id='work-owner-fixture'").first()).state, "cancelled");
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM article_lineage_links WHERE relation_type='owner_repair' AND status='confirmed'").first()).count, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM workspace_events WHERE event_type='article.identity.owner_repaired'").first()).count, 1);
    const resolvedDiscovery = await identityGet(harness, session, "view=source_owner_mismatches");
    assert.equal(resolvedDiscovery.response.status, 200, JSON.stringify(resolvedDiscovery.payload));
    assert.equal(resolvedDiscovery.payload.data.counts.mismatchCount, 0);

    const rollback = await identityPost(harness, session, "rollback_operation", "identity.rollback.owner", {
      operationId: plan.payload.data.operationId, expectedPlanSha256: plan.payload.data.planSha256,
    });
    assert.equal(rollback.response.status, 200, JSON.stringify(rollback.payload));
    assert.equal(rollback.payload.data.retainedImmutableRevisionId, newRevision);
    assert.equal((await db.prepare("SELECT status FROM article_branches WHERE id=?").bind(sourceBranch).first()).status, "active");
    assert.equal((await db.prepare("SELECT status FROM article_branches WHERE id=?").bind(newBranch).first()).status, "archived");
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM article_revisions WHERE id=?").bind(newRevision).first()).count, 1);
    assert.equal((await db.prepare("SELECT state FROM work_items WHERE id='work-owner-fixture'").first()).state, "open");
    const restoredDiscovery = await identityGet(harness, session, "view=source_owner_mismatches");
    assert.equal(restoredDiscovery.response.status, 200, JSON.stringify(restoredDiscovery.payload));
    assert.equal(restoredDiscovery.payload.data.counts.mismatchCount, 1);
  } finally {
    await harness.mf.dispose();
  }
});
