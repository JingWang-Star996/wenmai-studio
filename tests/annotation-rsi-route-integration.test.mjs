import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const origin = "http://[::1]:3000";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}` : JSON.stringify(value);

function failFreshBuild(message) {
  const error = new Error(`FRESH_BUILD_REQUIRED: ${message}`);
  error.code = "FRESH_BUILD_REQUIRED";
  throw error;
}

async function compiledModules() {
  const staticPath = path.join(root, "dist", "server", "_next", "static");
  let names;
  try { names = await readdir(staticPath); } catch { failFreshBuild("缺少 dist/server/_next/static；请由脚本层先构建 production dist"); }
  const sources = await Promise.all(names.filter((name) => name.endsWith(".js")).map(async (name) => ({ name, contents: await readFile(path.join(staticPath, name), "utf8"), modified: await stat(path.join(staticPath, name)) })));
  const route = (marker) => {
    const result = sources.find((source) => source.name.startsWith("route-") && source.contents.includes(marker));
    assert.ok(result, `production dist 缺少 ${marker}`);
    return result;
  };
  const annotation = route("annotation-rsi.v1.create_requirement");
  const auth = route("PAIRING_CODE_REQUIRED");
  const agent = route("Wenmai Agent Control Plane");
  assert.notEqual(annotation.name, agent.name, "annotation route marker must not resolve to the Agent review-context bundle");
  const newestSource = Math.max(...await Promise.all(["app/api/annotation-rsi/v1/route.ts", "app/annotation-rsi.ts", "app/annotation-rsi-lifecycle.ts", "drizzle/0029_vnext_annotation_rsi.sql", "drizzle/0031_windy_shard.sql", "package.json"].map(async (file) => (await stat(path.join(root, file))).mtimeMs)));
  if (annotation.modified.mtimeMs < newestSource) failFreshBuild("annotation route 早于 route/migration/package 源文件");
  return [{ type: "ESModule", path: "annotation-rsi-test-worker.mjs", contents: `import * as auth from ${JSON.stringify(`./${auth.name}`)};import * as api from ${JSON.stringify(`./${annotation.name}`)};import * as agent from ${JSON.stringify(`./${agent.name}`)};export default {fetch(request){const p=new URL(request.url).pathname;const mod=p==='/api/auth'?auth:p==='/api/annotation-rsi/v1'?api:p==='/api/agent/v1'?agent:null;const headers=new Headers(request.headers);headers.set('host','[::1]:3000');return mod?.[request.method]?mod[request.method](new Request(request,{headers})):new Response('not found',{status:404});}};` }, ...sources.map((source) => ({ type: "ESModule", path: source.name, contents: source.contents }))];
}

function request(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "[::1]:3000");
  headers.set("x-forwarded-host", "[::1]:3000");
  return new MiniflareRequest(`${origin}${pathname}`, { ...init, headers });
}

async function harness() {
  const selector = randomBytes(16).toString("base64url");
  const pairingCode = `wenmai1.${selector}.${randomBytes(16).toString("base64url")}`;
  const browserBinding = randomBytes(32).toString("base64url");
  const now = new Date();
  const mf = new Miniflare({ modules: await compiledModules(), compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat"], publicUrl: origin, d1Databases: { DB: `annotation-rsi-${randomUUID()}` }, log: new NoOpLog(), bindings: { WENMAI_AUTH_CANONICAL_ORIGIN: origin, WENMAI_AUTH_BOOT_ID: `boot-${selector}`, WENMAI_AUTH_CHALLENGE_ID: `management-challenge-${selector}`, WENMAI_AUTH_PAIRING_SHA256: sha256(pairingCode), WENMAI_AUTH_CHALLENGE_CREATED_AT: now.toISOString(), WENMAI_AUTH_CHALLENGE_EXPIRES_AT: new Date(+now + 300000).toISOString(), WENMAI_AUTH_CSRF_HMAC_KEY: randomBytes(32).toString("base64url") } });
  return { mf, pairingCode, browserBinding };
}

async function migrate(mf) {
  const db = await mf.getD1Database("DB");
  const names = (await readdir(path.join(root, "drizzle"))).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  for (const name of names) for (const sql of (await readFile(path.join(root, "drizzle", name), "utf8")).split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await db.prepare(sql).run();
  return db;
}

async function ownerSession(h) {
  const binding = { "X-Wenmai-Browser-Binding": h.browserBinding };
  await h.mf.dispatchFetch(request("/api/auth", { headers: binding }));
  const response = await h.mf.dispatchFetch(request("/api/auth", { method: "POST", headers: { ...binding, "content-type": "application/json", origin, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ action: "bootstrap", pairingCode: h.pairingCode, browserBindingSha256: sha256(h.browserBinding) }) }));
  const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body));
  return { cookie: response.headers.get("set-cookie").split(";", 1)[0], csrf: body.data.csrfToken };
}

async function post(h, session, action, commandId, payload) {
  const response = await h.mf.dispatchFetch(request("/api/annotation-rsi/v1", { method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", cookie: session.cookie, "X-Wenmai-CSRF": session.csrf, "X-Wenmai-Browser-Binding": h.browserBinding }, body: JSON.stringify({ action, commandId, payload }) }));
  return { response, body: await response.json() };
}

async function get(h, session, query) {
  const response = await h.mf.dispatchFetch(request(`/api/annotation-rsi/v1?${query}`, { headers: { cookie: session.cookie, "X-Wenmai-Browser-Binding": h.browserBinding } }));
  return { response, body: await response.json() };
}

async function issueSiteFullControl(h, session, label = "annotation-rsi site full control") {
  const catalog = await h.mf.dispatchFetch(request("/api/agent/v1?view=permission_catalog", { headers: { cookie: session.cookie, "X-Wenmai-Browser-Binding": h.browserBinding } }));
  const catalogBody = await catalog.json(); assert.equal(catalog.status, 200, JSON.stringify(catalogBody));
  const response = await h.mf.dispatchFetch(request("/api/agent/v1", { method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", cookie: session.cookie, "X-Wenmai-CSRF": session.csrf, "X-Wenmai-Browser-Binding": h.browserBinding, "X-Wenmai-Write": "1" }, body: JSON.stringify({ action: "issue_client", commandId: `annotation-rsi-root-${randomUUID()}`, payload: { label, clientKind: "codex", role: "super_admin", permissionPresetId: "site_full_control", catalogVersion: catalogBody.data.catalog.catalogVersion, catalogSha256: catalogBody.data.catalog.catalogSha256, scopes: ["site.full_control"], confirmedActionIds: ["auth.site_full_control.direct", "auth.site_full_control.exchange"], articleScope: { mode: "all_articles", articleIds: ["*"] }, articleIds: ["*"], taskIds: [] } }) }));
  const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body)); return body.data;
}

async function issueUnprivilegedAgent(h, session) {
  const response = await h.mf.dispatchFetch(request("/api/agent/v1", { method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", cookie: session.cookie, "X-Wenmai-CSRF": session.csrf, "X-Wenmai-Browser-Binding": h.browserBinding, "X-Wenmai-Write": "1" }, body: JSON.stringify({ action: "issue_client", commandId: `annotation-rsi-old-agent-${randomUUID()}`, payload: { label: "old privileged token rejection", clientKind: "codex", role: "agent", scopes: ["task.read"], articleScope: { mode: "all_articles", articleIds: ["*"] }, articleIds: ["*"], taskIds: [] } }) }));
  const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body)); return body.data;
}

async function directPost(h, token, action, commandId, payload) {
  const headers = new Headers({ host: "[::1]:3000", authorization: `Bearer ${token}`, "content-type": "application/json", "sec-fetch-site": "none" });
  const response = await h.mf.dispatchFetch(new MiniflareRequest(`${origin}/api/annotation-rsi/v1`, { method: "POST", headers, body: JSON.stringify({ action, commandId, payload }) }));
  return { response, body: await response.json() };
}

async function directReviewContext(h, token, articleId) {
  const response = await h.mf.dispatchFetch(request(`/api/agent/v1?view=review_context&articleId=${encodeURIComponent(articleId)}`, {
    headers: { authorization: `Bearer ${token}` },
  }));
  return { response, body: await response.json() };
}

function reviewReaderToken() {
  return `wenmai_agent_${randomBytes(16).toString("hex")}_${randomBytes(16).toString("hex")}`;
}

async function insertReviewReader(db, token, articleIds) {
  const id = `review-reader-${randomUUID()}`;
  await db.prepare(`INSERT INTO agent_clients
    (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,status,expires_at,created_at)
    VALUES (?,'review context reader','codex','agent',?,'["context.read"]',?,'[]','active','2099-01-01T00:00:00.000Z','2026-09-04T00:00:00.000Z')`)
    .bind(id, sha256(token), JSON.stringify(articleIds)).run();
  return id;
}

async function exchangeSiteFullControl(h, token) {
  const response = await h.mf.dispatchFetch(request("/api/auth", { method: "POST", headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json", origin, "sec-fetch-site": "same-origin", "X-Wenmai-Browser-Binding": h.browserBinding }, body: JSON.stringify({ action: "site_full_control.exchange", browserBindingSha256: sha256(h.browserBinding), exchangeCommandId: `site-full-control-exchange:${randomUUID()}` }) }));
  const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body)); return { cookie: response.headers.get("set-cookie").split(";", 1)[0], csrf: body.data.csrfToken };
}

// The complete seeded lineage is deliberately kept in SQL rather than mocks: all IDs bind to one article.
async function seedLineage(db) {
  const f = { articleId: "article-rsi", packageId: "package-rsi", branchId: "branch-rsi", revisionId: "revision-rsi", publicationId: "publication-rsi", buildId: "build-rsi", bodySha: sha256("body"), publicationSha: sha256("publication"), buildSha: sha256("build"), at: "2026-09-04T00:00:00.000Z" };
  await db.batch([
    db.prepare("INSERT INTO article_revisions(id,article_id,branch_id,sequence,title,document_title,annotation,body_text,body_sha256,author_kind,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(f.revisionId, f.articleId, f.branchId, 1, "RSI", "RSI", "", "PRIVATE_BODY_SENTINEL", f.bodySha, "import", f.at),
    db.prepare("INSERT INTO article_branches(id,article_id,name,slug,color,status,head_revision_id,base_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?,?,?)").bind(f.branchId, f.articleId, "main", "main", "blue", f.revisionId, f.revisionId, f.at, f.at),
    db.prepare("INSERT INTO article_project_packages(id,article_id,title,main_composition_id,main_composition_sha256,status,lock_version,primary_branch_id,branch_model_version,created_at,updated_at) VALUES(?,?,?,?,?,'active',1,?,1,?,?)").bind(f.packageId, f.articleId, "RSI", "composition", f.bodySha, f.branchId, f.at, f.at),
    db.prepare("INSERT INTO package_branch_states(package_id,branch_id,head_composition_id,head_composition_sha256,head_revision_id,status,lock_version,created_at,updated_at) VALUES(?,?,?,?,?,'active',1,?,?)").bind(f.packageId, f.branchId, "composition", f.bodySha, f.revisionId, f.at, f.at),
    db.prepare("INSERT INTO lifecycle_article_projects(id,article_id,title,intent,owner,phase,execution_state,lock_version,created_at,updated_at) VALUES(?,?,?,'','me','operate','active',1,?,?)").bind("project-rsi", f.articleId, "RSI", f.at, f.at),
    db.prepare("INSERT INTO article_publication_versions(id,package_id,article_id,role,version_key,platform,branch_id,branch_lock_version,revision_id,body_sha256,composition_id,composition_sha256,publication_version_json,registration_sha256,state,lock_version,created_at,updated_at) VALUES(?,?,?,'canonical_baseline','canonical',NULL,?,1,?,?,?,?,?,?,'active',1,?,?)").bind(f.publicationId, f.packageId, f.articleId, f.branchId, f.revisionId, f.bodySha, "composition", f.bodySha, "{}", f.publicationSha, f.at, f.at),
    db.prepare("INSERT INTO lifecycle_builds(id,project_id,article_id,branch_id,revision_id,source_title,source_body_sha256,target_profile_id,target_profile_sha256,adaptation_contract_id,contract_sha256,slice_kind,state,artifact_ref,artifact_sha256,artifact_media_type,artifact_manifest_json,failure_summary,created_at,built_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'full','built','fixture',?,'text/plain','{}','',?,?,?)").bind(f.buildId, "project-rsi", f.articleId, f.branchId, f.revisionId, "RSI", f.bodySha, "profile", f.bodySha, "contract", f.bodySha, f.buildSha, f.at, f.at, f.at),
  ]);
  return f;
}

function requirement(f, extra = {}) { return { articleId: f.articleId, packageId: f.packageId, branchId: f.branchId, baseRevisionId: f.revisionId, baseBodySha256: f.bodySha, requirementKey: "auditability", supersedesRequirementId: null, title: "可审计", requirementText: "PRIVATE_REQUIREMENT_SENTINEL", acceptance: { checked: true }, priority: "must", ...extra }; }
function acceptPayload(f, requirementId, inputSha256, extra = {}) { return { articleId: f.articleId, requirementId, expectedStatus: "draft", expectedLockVersion: 1, expectedInputSha256: inputSha256, note: "human acceptance", ...extra }; }
function annotationPayload(f, requirementId, subjectType, subjectId, snapshotSha256, extra = {}) { return { articleId: f.articleId, requirementId, subjectType, subjectId, snapshotSha256, labelSchemaVersion: 1, labelKind: "quality", verdict: "pass", severity: "info", note: "PRIVATE_ANNOTATION_SENTINEL", details: { secret: "PRIVATE_DETAILS_SENTINEL" }, evidenceRefs: ["fixture:evidence"], supersedesAnnotationId: null, ...extra }; }

async function acceptedRequirement(h, session, f, command = "requirement") {
  const made = await post(h, session, "create_requirement", command, requirement(f));
  assert.equal(made.response.status, 201, JSON.stringify(made.body));
  const accepted = await post(h, session, "accept_requirement", `${command}.accept`, acceptPayload(f, made.body.data.id, made.body.data.inputSha256));
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
  return made.body.data;
}

test("fresh production Miniflare/D1: article-scoped review_context 只读投影绑定 accepted human sources", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    await post(h, session, "initialize_workspace", "review-context-init", { articleId: f.articleId });
    const accepted = await acceptedRequirement(h, session, f, "review-context-accepted");
    await post(h, session, "create_requirement", "review-context-draft", requirement(f, { requirementKey: "draft-only", requirementText: "PRIVATE_DRAFT_REQUIREMENT_SENTINEL" }));
    const first = await post(h, session, "create_human_annotation", "review-context-annotation-1", annotationPayload(f, accepted.id, "article_revision", f.revisionId, f.bodySha));
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    const replacement = await post(h, session, "create_human_annotation", "review-context-annotation-2", annotationPayload(f, accepted.id, "article_revision", f.revisionId, f.bodySha, { supersedesAnnotationId: first.body.data.id, note: "ACTIVE_ANNOTATION_SENTINEL" }));
    assert.equal(replacement.response.status, 201, JSON.stringify(replacement.body));
    const token = reviewReaderToken(); await insertReviewReader(db, token, [f.articleId]);
    const read = await directReviewContext(h, token, f.articleId);
    assert.equal(read.response.status, 200, JSON.stringify(read.body));
    const rendered = JSON.stringify(read.body);
    assert.equal(read.body.data.articleId, f.articleId);
    assert.equal(read.body.data.bodyTextIncluded, false);
    assert.equal(read.body.data.advisoryOnly, true);
    assert.equal(read.body.data.autoAdopt, false);
    assert.match(read.body.data.canonicalSourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(read.body.data.requirements.items.length, 1);
    assert.equal(read.body.data.annotations.items.length, 1);
    assert.equal(read.body.data.annotations.items[0].id, replacement.body.data.id);
    assert.doesNotMatch(rendered, /PRIVATE_BODY_SENTINEL|PRIVATE_DRAFT_REQUIREMENT_SENTINEL/);
    const beforeDigest = read.body.data.canonicalSourceSha256;
    const changedRequirement = await post(h, session, "create_requirement", "review-context-digest-change", requirement(f, { requirementKey: "digest-change" }));
    assert.equal(changedRequirement.response.status, 201, JSON.stringify(changedRequirement.body));
    const changedAcceptance = await post(h, session, "accept_requirement", "review-context-digest-change.accept", acceptPayload(f, changedRequirement.body.data.id, changedRequirement.body.data.inputSha256));
    assert.equal(changedAcceptance.response.status, 200, JSON.stringify(changedAcceptance.body));
    const changed = await directReviewContext(h, token, f.articleId);
    assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
    assert.notEqual(changed.body.data.canonicalSourceSha256, beforeDigest);
    const outsider = reviewReaderToken(); await insertReviewReader(db, outsider, ["article-not-allowed"]);
    assert.equal((await directReviewContext(h, outsider, f.articleId)).response.status, 403);
    const unknown = await directPost(h, token, "adopt_rule", "review-context-adopt-denied", { articleId: f.articleId });
    assert.ok(unknown.response.status >= 400 && unknown.response.status < 500, JSON.stringify(unknown.body));
  } finally { await h.mf.dispose(); }
});

test("site.full_control v5 direct and exchanged principals create agent requirements but cannot perform human actions", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const owner = await ownerSession(h); const f = await seedLineage(db);
    await post(h, owner, "initialize_workspace", "init.site-full-control", { articleId: f.articleId });
    const root = await issueSiteFullControl(h, owner);
    const direct = await directPost(h, root.token, "create_requirement", "root.direct.requirement", requirement(f));
    assert.equal(direct.response.status, 201, JSON.stringify(direct.body));
    assert.equal((await db.prepare("SELECT created_by_kind FROM article_requirements WHERE id=?").bind(direct.body.data.id).first()).created_by_kind, "agent");
    const exchanged = await exchangeSiteFullControl(h, root.token);
    const exchangedCreated = await post(h, exchanged, "create_requirement", "root.exchange.requirement", requirement(f, { requirementKey: "exchange-auditability" }));
    assert.equal(exchangedCreated.response.status, 201, JSON.stringify(exchangedCreated.body));
    assert.equal((await db.prepare("SELECT created_by_kind FROM article_requirements WHERE id=?").bind(exchangedCreated.body.data.id).first()).created_by_kind, "agent");
    const v4 = await issueSiteFullControl(h, owner, "historical v4 exchange root");
    const v4Snapshot = await db.prepare("SELECT snapshot_json FROM agent_client_permission_snapshots WHERE client_id=?").bind(v4.client.id).first();
    const v4Document = JSON.parse(v4Snapshot.snapshot_json); delete v4Document.directAgentApi; v4Document.schemaVersion = 4; v4Document.credentialPurpose = "management_session_exchange"; v4Document.actionIds = ["auth.site_full_control.exchange"]; v4Document.managementProjectionVersion = "wenmai.site-full-control-management-projection/v4"; v4Document.managementProjectionSha256 = sha256(canonicalJson({ managementProjectionVersion: v4Document.managementProjectionVersion, managementScopes: v4Document.managementScopes }));
    const v4Json = canonicalJson(v4Document);
    await db.prepare("UPDATE agent_client_permission_snapshots SET action_ids_json=?,snapshot_json=?,snapshot_sha256=? WHERE client_id=?").bind('["auth.site_full_control.exchange"]', v4Json, sha256(v4Json), v4.client.id).run();
    await db.prepare("UPDATE agent_clients SET credential_purpose='management_session_exchange' WHERE id=?").bind(v4.client.id).run();
    assert.equal((await directPost(h, v4.token, "create_requirement", "v4.direct.denied", requirement(f, { requirementKey: "v4-direct" }))).response.status, 401);
    const v4Session = await exchangeSiteFullControl(h, v4.token);
    const v4Created = await post(h, v4Session, "create_requirement", "v4.exchange.requirement", requirement(f, { requirementKey: "v4-exchange" }));
    assert.equal(v4Created.response.status, 201, JSON.stringify(v4Created.body));
    assert.equal((await db.prepare("SELECT created_by_kind FROM article_requirements WHERE id=?").bind(v4Created.body.data.id).first()).created_by_kind, "agent");
    for (const [action, payload] of [["accept_requirement", acceptPayload(f, direct.body.data.id, direct.body.data.inputSha256)], ["create_human_annotation", annotationPayload(f, direct.body.data.id, "article_revision", f.revisionId, f.bodySha)], ["record_external_ai_observation", { articleId: f.articleId, canonicalSource: "fixture", sourceVersion: "v1", publishedAt: f.at, contentSha256: sha256("external"), eventInputSha256: sha256("event"), officialFact: "fixture", inferredImpact: "fixture", evidenceRefs: ["fixture"] }]]) {
      const rejected = await directPost(h, root.token, action, `root.human.${action}`, payload);
      assert.equal(rejected.response.status, 403, JSON.stringify(rejected.body));
    }
    const oldAgent = await issueUnprivilegedAgent(h, owner);
    assert.equal((await directPost(h, oldAgent.token, "create_requirement", "old-agent.denied", requirement(f, { requirementKey: "old-agent" }))).response.status, 401);
    const expired = await issueSiteFullControl(h, owner, "expired root");
    await db.prepare("UPDATE agent_clients SET expires_at=? WHERE id=?").bind("2020-01-01T00:00:00.000Z", expired.client.id).run();
    assert.equal((await directPost(h, expired.token, "create_requirement", "root.expired", requirement(f, { requirementKey: "expired" }))).response.status, 401);
    const noSnapshot = await issueSiteFullControl(h, owner, "missing snapshot root");
    await db.prepare("DELETE FROM agent_client_permission_snapshots WHERE client_id=?").bind(noSnapshot.client.id).run();
    assert.equal((await directPost(h, noSnapshot.token, "create_requirement", "root.no-snapshot", requirement(f, { requirementKey: "no-snapshot" }))).response.status, 401);
    await db.prepare("UPDATE agent_clients SET status='revoked', revoked_at=? WHERE id=?").bind(new Date().toISOString(), root.client.id).run();
    const revoked = await directPost(h, root.token, "create_requirement", "root.revoked", requirement(f, { requirementKey: "revoked" }));
    assert.equal(revoked.response.status, 401);
  } finally { await h.mf.dispose(); }
});

test("fresh production Miniflare/D1: management envelope、初始化回放与输入校验", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    const init = await post(h, session, "initialize_workspace", "init.rsi", { articleId: f.articleId });
    assert.equal(init.response.status, 200, JSON.stringify(init.body)); assert.equal(init.body.data.schemaReady, true);
    const replay = await post(h, session, "initialize_workspace", "init.rsi", { articleId: f.articleId });
    assert.equal(replay.response.status, 200); assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events").first()).count, 0);
    const malformed = await post(h, session, "create_requirement", "bad", { ...requirement(f), baseBodySha256: "bad" });
    assert.equal(malformed.response.status, 400); assert.equal(malformed.body.error.code, "SHA256_INVALID");
    const badCursor = await get(h, session, `view=annotations&articleId=${f.articleId}&cursor=not-base64`);
    assert.equal(badCursor.response.status, 400); assert.equal(badCursor.body.error.code, "CURSOR_MALFORMED");
  } finally { await h.mf.dispose(); }
});

test("three subject snapshots require built build and reject stale digests", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    await post(h, session, "initialize_workspace", "init.subject", { articleId: f.articleId });
    const requirementRow = await acceptedRequirement(h, session, f, "subject.requirement");
    for (const [type, id, digest] of [["article_revision", f.revisionId, f.bodySha], ["publication_version", f.publicationId, f.publicationSha], ["build", f.buildId, f.buildSha]]) {
      const made = await post(h, session, "create_human_annotation", `subject.${type}`, annotationPayload(f, requirementRow.id, type, id, digest));
      assert.equal(made.response.status, 201, JSON.stringify(made.body));
    }
    await db.prepare("UPDATE lifecycle_builds SET state='planned' WHERE id=?").bind(f.buildId).run();
    const rejected = await post(h, session, "create_human_annotation", "subject.unbuilt", annotationPayload(f, requirementRow.id, "build", f.buildId, f.buildSha));
    assert.equal(rejected.response.status, 409); assert.equal(rejected.body.error.code, "SUBJECT_SNAPSHOT_MISMATCH");
  } finally { await h.mf.dispose(); }
});

test("accept CAS race commits one receipt/event and command readback is minimal", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    await post(h, session, "initialize_workspace", "init.accept", { articleId: f.articleId });
    const made = await post(h, session, "create_requirement", "accept.requirement", requirement(f));
    const payload = acceptPayload(f, made.body.data.id, made.body.data.inputSha256);
    const [left, right] = await Promise.all([post(h, session, "accept_requirement", "accept.left", payload), post(h, session, "accept_requirement", "accept.right", payload)]);
    assert.deepEqual([left.response.status, right.response.status].sort(), [200, 409]);
    const loser = left.response.status === 409 ? left : right;
    assert.equal(loser.body.error.code, "REQUIREMENT_CAS_CONFLICT");
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE event_type='requirement.accepted'").first()).count, 1);
    const winner = left.response.status === 200 ? "accept.left" : "accept.right";
    const readback = await get(h, session, `view=command&articleId=${f.articleId}&commandId=${winner}`);
    assert.equal(readback.response.status, 200, JSON.stringify(readback.body));
    for (const secret of ["PRIVATE_REQUIREMENT_SENTINEL", "PRIVATE_ANNOTATION_SENTINEL", "PRIVATE_DETAILS_SENTINEL"]) assert.doesNotMatch(JSON.stringify(readback.body), new RegExp(secret));
  } finally { await h.mf.dispose(); }
});

test("annotation supersede race and event-abort transaction rollback", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db); await post(h, session, "initialize_workspace", "init.annotation", { articleId: f.articleId });
    const r = await acceptedRequirement(h, session, f, "annotation.requirement");
    const original = await post(h, session, "create_human_annotation", "annotation.original", annotationPayload(f, r.id, "article_revision", f.revisionId, f.bodySha));
    const payload = annotationPayload(f, r.id, "article_revision", f.revisionId, f.bodySha, { supersedesAnnotationId: original.body.data.id, note: "replacement" });
    const [a, b] = await Promise.all([post(h, session, "create_human_annotation", "annotation.left", payload), post(h, session, "create_human_annotation", "annotation.right", payload)]);
    assert.deepEqual([a.response.status, b.response.status].sort(), [201, 409]);
    const loser = a.response.status === 409 ? a : b;
    assert.ok(["ANNOTATION_CAS_CONFLICT", "ANNOTATION_SUPERSESSION_INVALID"].includes(loser.body.error.code), loser.body.error.code);
    await db.prepare("CREATE TRIGGER annotation_event_abort BEFORE INSERT ON lifecycle_events WHEN NEW.event_type='annotation.created' BEGIN SELECT RAISE(ABORT,'forced'); END").run();
    const failed = await post(h, session, "create_human_annotation", "annotation.abort", annotationPayload(f, r.id, "publication_version", f.publicationId, f.publicationSha));
    assert.equal(failed.response.status, 500); assert.equal((await db.prepare("SELECT COUNT(*) count FROM command_receipts WHERE id='annotation.abort'").first()).count, 0);
    await db.prepare("DROP TRIGGER annotation_event_abort").run();
    assert.equal((await post(h, session, "create_human_annotation", "annotation.abort", annotationPayload(f, r.id, "publication_version", f.publicationId, f.publicationSha))).response.status, 201);
  } finally { await h.mf.dispose(); }
});

test("proposal stale digest remains 200 advisory and GET never leaks sentinels", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db); await post(h, session, "initialize_workspace", "init.context", { articleId: f.articleId });
    const r = await acceptedRequirement(h, session, f, "context.requirement");
    await post(h, session, "create_human_annotation", "context.annotation", annotationPayload(f, r.id, "article_revision", f.revisionId, f.bodySha));
    const before = await db.prepare("SELECT (SELECT COUNT(*) FROM lifecycle_rule_candidates) rules,(SELECT COUNT(*) FROM meta_improvement_experiments) experiments,(SELECT COUNT(*) FROM meta_skill_activations) activations").first();
    const response = await get(h, session, `view=proposal-context&articleId=${f.articleId}&sourceSetSha256=${"0".repeat(64)}`);
    assert.equal(response.response.status, 200, JSON.stringify(response.body)); assert.ok(response.body.data.blockers.some((blocker) => blocker.code === "SOURCE_DIGEST_STALE"));
    for (const secret of ["PRIVATE_BODY_SENTINEL", "PRIVATE_REQUIREMENT_SENTINEL", "PRIVATE_ANNOTATION_SENTINEL", "PRIVATE_DETAILS_SENTINEL"]) assert.doesNotMatch(JSON.stringify(response.body), new RegExp(secret));
    assert.deepEqual(await db.prepare("SELECT (SELECT COUNT(*) FROM lifecycle_rule_candidates) rules,(SELECT COUNT(*) FROM meta_improvement_experiments) experiments,(SELECT COUNT(*) FROM meta_skill_activations) activations").first(), before);
  } finally { await h.mf.dispose(); }
});

test("requirement supersede is two-row CAS atomic", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    await post(h, session, "initialize_workspace", "init.supersede", { articleId: f.articleId });
    const old = await acceptedRequirement(h, session, f, "old.requirement");
    const replacement = await post(h, session, "create_requirement", "replacement.requirement", requirement(f, { supersedesRequirementId: old.id }));
    assert.equal(replacement.response.status, 201, JSON.stringify(replacement.body));
    const before = await db.prepare("SELECT id,status,lock_version,input_sha256 FROM article_requirements WHERE id IN (?,?) ORDER BY id").bind(old.id, replacement.body.data.id).all();
    const invalid = await post(h, session, "supersede_requirement", "supersede.invalid", { articleId: f.articleId, oldRequirementId: old.id, oldExpectedStatus: "accepted", oldExpectedLockVersion: 2, oldExpectedInputSha256: old.inputSha256, replacementRequirementId: replacement.body.data.id, replacementExpectedStatus: "draft", replacementExpectedLockVersion: 99, replacementExpectedInputSha256: replacement.body.data.inputSha256, note: "supersede" });
    assert.equal(invalid.response.status, 409); assert.equal(invalid.body.error.code, "REQUIREMENT_CAS_CONFLICT"); assert.deepEqual((await db.prepare("SELECT id,status,lock_version,input_sha256 FROM article_requirements WHERE id IN (?,?) ORDER BY id").bind(old.id, replacement.body.data.id).all()).results, before.results);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM command_receipts WHERE id='supersede.invalid'").first()).count, 0);
    const success = await post(h, session, "supersede_requirement", "supersede.success", { articleId: f.articleId, oldRequirementId: old.id, oldExpectedStatus: "accepted", oldExpectedLockVersion: 2, oldExpectedInputSha256: old.inputSha256, replacementRequirementId: replacement.body.data.id, replacementExpectedStatus: "draft", replacementExpectedLockVersion: 1, replacementExpectedInputSha256: replacement.body.data.inputSha256, note: "supersede" });
    assert.equal(success.response.status, 200, JSON.stringify(success.body));
    const rows = await db.prepare("SELECT id,status,lock_version FROM article_requirements WHERE id IN (?,?)").bind(old.id, replacement.body.data.id).all();
    assert.deepEqual(Object.fromEntries(rows.results.map((row) => [row.id, [row.status, row.lock_version]])), { [old.id]: ["superseded", 3], [replacement.body.data.id]: ["accepted", 2] });
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE event_type='requirement.superseded'").first()).count, 1);
  } finally { await h.mf.dispose(); }
});

test("requirement supersede is independent of primary-key scan order", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    await post(h, session, "initialize_workspace", "init.supersede-order", { articleId: f.articleId });
    const oldSql = "INSERT INTO article_requirements(id,article_id,requirement_key,revision,package_id,branch_id,base_revision_id,base_body_sha256,title,requirement_text,input_sha256,status,lock_version,created_by_kind,created_by,accepted_by,accepted_at,create_command_id,last_command_id,created_at,updated_at) VALUES(?,?,?,1,?,?,?,?,?,?,?,'accepted',2,'human','owner','owner',?,?,?,?,?)";
    const replacementSql = "INSERT INTO article_requirements(id,article_id,requirement_key,revision,supersedes_requirement_id,package_id,branch_id,base_revision_id,base_body_sha256,title,requirement_text,input_sha256,status,lock_version,created_by_kind,created_by,create_command_id,last_command_id,created_at,updated_at) VALUES(?,?,?,2,?,?,?,?,?,?,?,?,'draft',1,'human','owner',?,?,?,?)";
    const seedPair = async ({ label, oldId, replacementId }) => {
      const key = `scan-order-${label}`, oldSha = sha256(`${label}:old`), replacementSha = sha256(`${label}:replacement`);
      await db.batch([
        db.prepare(oldSql).bind(oldId, f.articleId, key, f.packageId, f.branchId, f.revisionId, f.bodySha, label, label, oldSha, f.at, `seed.${label}.old`, `seed.${label}.old`, f.at, f.at),
        db.prepare(replacementSql).bind(replacementId, f.articleId, key, oldId, f.packageId, f.branchId, f.revisionId, f.bodySha, label, label, replacementSha, `seed.${label}.replacement`, `seed.${label}.replacement`, f.at, f.at),
      ]);
      return { key, oldSha, replacementSha };
    };
    for (const pair of [
      { label: "old-first", oldId: "requirement:a-old", replacementId: "requirement:z-new" },
      { label: "replacement-first", oldId: "requirement:z-old", replacementId: "requirement:a-new" },
    ]) {
      const seeded = await seedPair(pair);
      const commandId = `supersede.order.${pair.label}`;
      const result = await post(h, session, "supersede_requirement", commandId, { articleId: f.articleId, oldRequirementId: pair.oldId, oldExpectedStatus: "accepted", oldExpectedLockVersion: 2, oldExpectedInputSha256: seeded.oldSha, replacementRequirementId: pair.replacementId, replacementExpectedStatus: "draft", replacementExpectedLockVersion: 1, replacementExpectedInputSha256: seeded.replacementSha, note: "ordered supersede" });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      const rows = await db.prepare("SELECT id,status,lock_version FROM article_requirements WHERE id IN (?,?)").bind(pair.oldId, pair.replacementId).all();
      assert.deepEqual(Object.fromEntries(rows.results.map((row) => [row.id, [row.status, row.lock_version]])), { [pair.oldId]: ["superseded", 3], [pair.replacementId]: ["accepted", 2] });
      assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE event_type='requirement.superseded' AND subject_id=?").bind(pair.oldId).first()).count, 1);
      assert.equal((await db.prepare("SELECT COUNT(*) count FROM command_receipts WHERE id=?").bind(commandId).first()).count, 1);
    }
    const failedPair = { label: "reverse-cas-failure", oldId: "requirement:z-cas-old", replacementId: "requirement:a-cas-new" };
    const failedSeed = await seedPair(failedPair);
    const before = await db.prepare("SELECT id,status,lock_version,last_command_id FROM article_requirements WHERE id IN (?,?) ORDER BY id").bind(failedPair.oldId, failedPair.replacementId).all();
    const failed = await post(h, session, "supersede_requirement", "supersede.order.reverse-failure", { articleId: f.articleId, oldRequirementId: failedPair.oldId, oldExpectedStatus: "accepted", oldExpectedLockVersion: 2, oldExpectedInputSha256: failedSeed.oldSha, replacementRequirementId: failedPair.replacementId, replacementExpectedStatus: "draft", replacementExpectedLockVersion: 99, replacementExpectedInputSha256: failedSeed.replacementSha, note: "ordered supersede failure" });
    assert.equal(failed.response.status, 409); assert.equal(failed.body.error.code, "REQUIREMENT_CAS_CONFLICT");
    assert.deepEqual((await db.prepare("SELECT id,status,lock_version,last_command_id FROM article_requirements WHERE id IN (?,?) ORDER BY id").bind(failedPair.oldId, failedPair.replacementId).all()).results, before.results);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE event_type='requirement.superseded' AND subject_id=?").bind(failedPair.oldId).first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM command_receipts WHERE id='supersede.order.reverse-failure'").first()).count, 0);
  } finally { await h.mf.dispose(); }
});

test("external AI observation is idempotent, conflict-safe, and advisory-only", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    await post(h, session, "initialize_workspace", "init.external", { articleId: f.articleId });
    const payload = { articleId: f.articleId, canonicalSource: "https://openai.com/release", sourceVersion: "v1", publishedAt: "2026-09-01T00:00:00.000Z", contentSha256: sha256("external-v1"), officialFact: "PRIVATE_EXTERNAL_FACT_SENTINEL", inferredImpact: "PRIVATE_EXTERNAL_IMPACT_SENTINEL", evidenceRefs: ["fixture:official"] };
    const before = await db.prepare("SELECT (SELECT COUNT(*) FROM lifecycle_rule_candidates) rules,(SELECT COUNT(*) FROM meta_improvement_experiments) experiments,(SELECT COUNT(*) FROM meta_skill_activations) activations").first();
    const first = await post(h, session, "record_external_ai_observation", "external.one", payload); assert.equal(first.response.status, 200, JSON.stringify(first.body)); assert.equal(first.body.data.present, true); assert.equal(first.body.data.contentMatched, true); for (const forbidden of ["recorded", "unchanged", "creator", "firstWriter"]) assert.equal(forbidden in first.body.data, false);
    const replay = await post(h, session, "record_external_ai_observation", "external.two", payload); assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE event_type='external_ai_change.recorded'").first()).count, 1);
    const concurrentSamePayload = { ...payload, sourceVersion: "v-concurrent-same", contentSha256: sha256("external-concurrent-same") };
    const [sameLeft, sameRight] = await Promise.all([
      post(h, session, "record_external_ai_observation", "external.same.left", concurrentSamePayload),
      post(h, session, "record_external_ai_observation", "external.same.right", concurrentSamePayload),
    ]);
    assert.deepEqual([sameLeft.response.status, sameRight.response.status], [200, 200]);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE event_type='external_ai_change.recorded' AND json_extract(payload_json,'$.sourceVersion')='v-concurrent-same'").first()).count, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM command_receipts WHERE id IN ('external.same.left','external.same.right')").first()).count, 2);
    const concurrentConflictLeft = { ...payload, sourceVersion: "v-concurrent-conflict", contentSha256: sha256("external-concurrent-left") };
    const concurrentConflictRight = { ...concurrentConflictLeft, contentSha256: sha256("external-concurrent-right") };
    const [conflictLeft, conflictRight] = await Promise.all([
      post(h, session, "record_external_ai_observation", "external.conflict.left", concurrentConflictLeft),
      post(h, session, "record_external_ai_observation", "external.conflict.right", concurrentConflictRight),
    ]);
    assert.deepEqual([conflictLeft.response.status, conflictRight.response.status].sort(), [200, 409]);
    const conflictLoser = conflictLeft.response.status === 409 ? conflictLeft : conflictRight;
    assert.equal(conflictLoser.body.error.code, "EXTERNAL_OBSERVATION_CONFLICT");
    const conflictLoserId = conflictLeft.response.status === 409 ? "external.conflict.left" : "external.conflict.right";
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM command_receipts WHERE id=?").bind(conflictLoserId).first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE event_type='external_ai_change.recorded' AND json_extract(payload_json,'$.sourceVersion')='v-concurrent-conflict'").first()).count, 1);
    const conflict = await post(h, session, "record_external_ai_observation", "external.conflict", { ...payload, contentSha256: sha256("external-v2") }); assert.equal(conflict.response.status, 409); assert.equal(conflict.body.error.code, "EXTERNAL_OBSERVATION_CONFLICT");
    const commandReuse = await post(h, session, "record_external_ai_observation", "external.one", { ...payload, sourceVersion: "v2" });
    assert.equal(commandReuse.response.status, 409); assert.equal(commandReuse.body.error.code, "COMMAND_ID_REUSED");
    const secondArticle = await post(h, session, "record_external_ai_observation", "external.second-article", { ...payload, articleId: "article-rsi-second" });
    assert.equal(secondArticle.response.status, 200, JSON.stringify(secondArticle.body));
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE event_type='external_ai_change.recorded' AND json_extract(payload_json,'$.sourceVersion')='v1'").first()).count, 2);
    const view = await get(h, session, `view=proposal-context&articleId=${f.articleId}`); assert.equal(view.response.status, 200); const external = view.body.data.items.find((item) => item.triggerKind === "external_ai_change"); assert.ok(external); assert.equal(external.officialFact, "PRIVATE_EXTERNAL_FACT_SENTINEL"); assert.equal(external.inferredImpact, "PRIVATE_EXTERNAL_IMPACT_SENTINEL");
    const command = await get(h, session, `view=command&articleId=${f.articleId}&commandId=external.one`);
    for (const secret of ["PRIVATE_EXTERNAL_FACT_SENTINEL", "PRIVATE_EXTERNAL_IMPACT_SENTINEL"]) assert.doesNotMatch(JSON.stringify(command.body), new RegExp(secret));
    assert.deepEqual(await db.prepare("SELECT (SELECT COUNT(*) FROM lifecycle_rule_candidates) rules,(SELECT COUNT(*) FROM meta_improvement_experiments) experiments,(SELECT COUNT(*) FROM meta_skill_activations) activations").first(), before);
  } finally { await h.mf.dispose(); }
});

test("proposal context reads all seven bounded fact sets through one D1 batch", async () => {
  const source = await readFile(path.join(root, "app", "api", "annotation-rsi", "v1", "route.ts"), "utf8");
  const contextSource = source.slice(source.indexOf("async function context("), source.indexOf("type SummaryLabel"));
  const summarySource = source.slice(source.indexOf("type SummaryLabel"), source.indexOf("async function initializeWorkspace("));
  assert.equal((contextSource.match(/await db\.batch<Row>/gu) ?? []).length, 1);
  for (const label of ["requirements", "annotations", "retrospectives", "tasks", "progressEvents", "externalObservations", "ruleCandidates"]) assert.match(contextSource, new RegExp('label: "' + label + '"'));
  assert.doesNotMatch(contextSource, /await boundedRows/);
  assert.equal((summarySource.match(/await db\.batch<Row>/gu) ?? []).length, 1);
  assert.match(summarySource, /r\.id=a\.requirement_id AND r\.article_id=a\.article_id/);
  assert.doesNotMatch(summarySource, /SELECT a\.\*/);
});

test("derived projection overflow returns 409 without partial data or business writes", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    await post(h, session, "initialize_workspace", "init.derived-budget", { articleId: f.articleId });
    const requirementRow = await acceptedRequirement(h, session, f, "derived-budget.requirement");
    const annotationDigest = sha256("derived-budget-annotation"), annotationInput = sha256("derived-budget-input");
    await db.prepare("WITH digits(n) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)), seq(n) AS (SELECT a.n+10*b.n+100*c.n+1000*d.n FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d) INSERT INTO human_annotations(id,article_id,requirement_id,subject_type,subject_id,snapshot_sha256,label_schema_version,label_kind,verdict,severity,note,details_json,evidence_refs_json,annotation_sha256,supersedes_annotation_id,input_sha256,human_actor_id,command_id,created_at) SELECT 'budget-ann-'||n,?,?, 'article_revision',?,?,1,'quality','pass','info','','{}','[\"fixture:evidence\"]',?,NULL,?,'fixture','budget-command-'||n,? FROM seq WHERE n<2045").bind(f.articleId, requirementRow.id, f.revisionId, f.bodySha, annotationDigest, annotationInput, f.at).run();
    const externalStatements = Array.from({ length: 9 }, (_, index) => {
      const id = "budget-external-" + index;
      const payload = { schemaVersion: "wenmai.annotation-rsi/1.0", articleId: f.articleId, canonicalSource: "https://openai.com/budget-" + index, sourceVersion: "budget-" + index, publishedAt: "2026-09-01T00:00:00.000Z", contentSha256: sha256("budget-content-" + index), officialFact: "budget fact", inferredImpact: "", evidenceRefs: ["requirement:" + requirementRow.id], humanReviewed: true };
      const inputSha256 = sha256(canonicalJson(payload));
      return db.prepare("INSERT INTO lifecycle_events(id,article_id,event_type,subject_type,subject_id,payload_json,input_sha256,created_at) VALUES(?,?,'external_ai_change.recorded','external_ai_observation',?,?,?,?)").bind(id, f.articleId, id, canonicalJson(payload), inputSha256, f.at);
    });
    await db.batch(externalStatements);
    const before = await db.prepare("SELECT (SELECT COUNT(*) FROM lifecycle_events) events,(SELECT COUNT(*) FROM lifecycle_rule_candidates) rules,(SELECT COUNT(*) FROM meta_improvement_experiments) experiments,(SELECT COUNT(*) FROM meta_skill_activations) activations").first();
    const over = await get(h, session, "view=proposal-context&articleId=" + f.articleId + "&asOf=2026-09-04T00:00:00.000Z");
    assert.equal(over.response.status, 409, JSON.stringify(over.body)); assert.equal(over.body.error.code, "RSI_CONTEXT_LIMIT_EXCEEDED"); assert.equal(over.body.data, undefined); assert.doesNotMatch(JSON.stringify(over.body), /sourceSetSha256|items/);
    assert.deepEqual(await db.prepare("SELECT (SELECT COUNT(*) FROM lifecycle_events) events,(SELECT COUNT(*) FROM lifecycle_rule_candidates) rules,(SELECT COUNT(*) FROM meta_improvement_experiments) experiments,(SELECT COUNT(*) FROM meta_skill_activations) activations").first(), before);
  } finally { await h.mf.dispose(); }
});

test("four-trigger projection binds task context exactly and remains a pure read", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    await post(h, session, "initialize_workspace", "init.matrix", { articleId: f.articleId });
    const r = await acceptedRequirement(h, session, f, "matrix.requirement");
    const a = await post(h, session, "create_human_annotation", "matrix.annotation", annotationPayload(f, r.id, "article_revision", f.revisionId, f.bodySha));
    assert.equal(a.response.status, 201, JSON.stringify(a.body));
    const old = "2026-08-01T00:00:00.000Z";
    await db.batch([
      db.prepare("INSERT INTO agent_context_snapshots(id,task_id,article_id,revision_id,body_sha256,corpus_schema_version,corpus_algorithm_version,corpus_generated_at,corpus_sha256,graph_sha256,rules_sha256,bundle_json,context_sha256,created_at) VALUES(?,?,?,?,?,'v','v',?,?,?,?,'{}',?,?)").bind("context-matrix", "task-matrix", f.articleId, f.revisionId, f.bodySha, old, sha256("corpus"), sha256("graph"), sha256("rules"), sha256("context"), old),
      db.prepare("INSERT INTO agent_tasks(id,article_id,base_revision_id,current_context_snapshot_id,title,objective,state,created_at,updated_at,finished_at) VALUES(?,?,?,?,? ,?,'succeeded',?,?,?)").bind("task-matrix", f.articleId, f.revisionId, "context-matrix", "task", "objective", old, old, old),
      db.prepare("INSERT INTO agent_progress_events(id,task_id,event_type,actor_kind,actor_id,input_sha256,created_at) VALUES(?,?,?,'agent',?,?,?)").bind("progress-matrix", "task-matrix", "finished", "agent", sha256("progress"), old),
    ]);
    const before = await db.prepare("SELECT COUNT(*) count FROM lifecycle_events").first();
    const due = await get(h, session, `view=proposal-context&articleId=${f.articleId}&asOf=2026-09-04T00:00:00.000Z`);
    assert.equal(due.response.status, 200, JSON.stringify(due.body));
    assert.ok(due.body.data.items.some((item) => item.triggerKind === "task_terminal"));
    assert.ok(due.body.data.items.some((item) => item.triggerKind === "review_due" && item.triggerKey === "task-retrospective:task-matrix"));
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events").first()).count, before.count);
    await db.prepare("INSERT INTO lifecycle_retrospectives(id,project_id,article_id,title,summary,evidence_refs_json,status,lock_version,created_at,updated_at) VALUES(?,?,?,'','','[\"task:task-matrix\",\"annotation:" + a.body.data.id + "\"]','reviewed',1,?,?)").bind("retro-matrix", "project-rsi", f.articleId, old, old).run();
    const response = await get(h, session, `view=proposal-context&articleId=${f.articleId}&asOf=2026-09-04T00:00:00.000Z`);
    assert.equal(response.response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.data.items.some((item) => item.triggerKind === "task_terminal"));
    assert.ok(!response.body.data.items.some((item) => item.triggerKind === "review_due" && item.triggerKey === "task-retrospective:task-matrix"));
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events").first()).count, before.count);
    await db.prepare("UPDATE agent_context_snapshots SET body_sha256=? WHERE id='context-matrix'").bind(sha256("changed")).run();
    const mismatched = await get(h, session, `view=proposal-context&articleId=${f.articleId}&asOf=2026-09-04T00:00:00.000Z`);
    const task = mismatched.body.data.items.find((item) => item.triggerKey === "task-matrix");
    assert.ok(task.blockers.some((blocker) => blocker.code === "NO_ACTIVE_HUMAN_ANNOTATION" || blocker.code === "CONTEXT_SNAPSHOT_MISSING"));
    await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<512)
      INSERT INTO article_requirements(id,article_id,requirement_key,revision,supersedes_requirement_id,package_id,branch_id,base_revision_id,base_body_sha256,title,requirement_text,acceptance_json,priority,input_sha256,status,lock_version,created_by_kind,created_by,accepted_by,accepted_at,superseded_at,cancelled_at,create_command_id,last_command_id,created_at,updated_at)
      SELECT 'overflow-'||n,?,'overflow-'||n,1,NULL,?,?,?,?,'overflow','overflow','{}','should',?,'accepted',1,'human','fixture','fixture',?,NULL,NULL,'overflow-command-'||n,'overflow-command-'||n,?,? FROM seq`)
      .bind(f.articleId, f.packageId, f.branchId, f.revisionId, f.bodySha, sha256("overflow"), old, old, old).run();
    const overLimit = await get(h, session, `view=proposal-context&articleId=${f.articleId}&asOf=2026-09-04T00:00:00.000Z`);
    assert.equal(overLimit.response.status, 409); assert.equal(overLimit.body.error.code, "RSI_CONTEXT_LIMIT_EXCEEDED");
  } finally { await h.mf.dispose(); }
});

test("proposal summary is global, advisory, redacted, and fails closed at its global budget", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    await post(h, session, "initialize_workspace", "summary-init", { articleId: f.articleId });
    const first = await acceptedRequirement(h, session, f, "summary-first");
    const second = "article-rsi-second", third = "article-rsi-third", externalArticle = "article-rsi-external";
    const old = "2026-08-01T00:00:00.000Z", future = "2026-09-05T00:00:00.000Z", asOf = "2026-09-04T00:00:00.000Z";
    await db.prepare("UPDATE article_requirements SET accepted_at=?,created_at=?,updated_at=? WHERE id=?").bind(old, old, old, first.id).run();
    await db.prepare("INSERT INTO article_requirements(id,article_id,requirement_key,revision,supersedes_requirement_id,package_id,branch_id,base_revision_id,base_body_sha256,title,requirement_text,acceptance_json,priority,input_sha256,status,lock_version,created_by_kind,created_by,accepted_by,accepted_at,create_command_id,last_command_id,created_at,updated_at) VALUES('summary-second',?,'summary',1,NULL,?,?,?,?,?,'PRIVATE_SUMMARY_REQUIREMENT','{}','must',?,'accepted',1,'human','fixture','fixture',?,'summary-command','summary-command',?,?)").bind(second, f.packageId, f.branchId, f.revisionId, f.bodySha, "summary", sha256("summary-second"), old, old, old).run();
    await db.prepare("UPDATE article_requirements SET priority='should' WHERE id='summary-second'").run();
    await db.prepare("INSERT INTO article_requirements(id,article_id,requirement_key,revision,supersedes_requirement_id,package_id,branch_id,base_revision_id,base_body_sha256,title,requirement_text,acceptance_json,priority,input_sha256,status,lock_version,created_by_kind,created_by,accepted_by,accepted_at,create_command_id,last_command_id,created_at,updated_at) VALUES('summary-third',?,'summary',1,NULL,?,?,?,?,?,'PRIVATE_SUMMARY_COULD','{}','could',?,'accepted',1,'human','fixture','fixture',?,'summary-third-command','summary-third-command',?,?)").bind(third, f.packageId, f.branchId, f.revisionId, f.bodySha, "summary", sha256("summary-third"), old, old, old).run();
    const externalPayload = { schemaVersion: "wenmai.annotation-rsi/1.0", articleId: externalArticle, canonicalSource: "https://openai.com/summary", sourceVersion: "summary", publishedAt: old, contentSha256: sha256("summary-external-content"), officialFact: "PRIVATE_SUMMARY_OFFICIAL_FACT", inferredImpact: "PRIVATE_SUMMARY_INFERRED_IMPACT", evidenceRefs: ["fixture:summary"], humanReviewed: true };
    await db.prepare("INSERT INTO lifecycle_events(id,article_id,event_type,subject_type,subject_id,payload_json,input_sha256,created_at) VALUES('summary-external',?,'external_ai_change.recorded','external_ai_observation','summary-external',?,?,?)").bind(externalArticle, canonicalJson(externalPayload), sha256(canonicalJson(externalPayload)), old).run();
    const businessSnapshot = "SELECT (SELECT COUNT(*) FROM article_requirements) requirements,(SELECT COUNT(*) FROM human_annotations) annotations,(SELECT COUNT(*) FROM lifecycle_retrospectives) retrospectives,(SELECT COUNT(*) FROM agent_tasks) tasks,(SELECT COUNT(*) FROM agent_progress_events) progressEvents,(SELECT COUNT(*) FROM lifecycle_events) lifecycleEvents,(SELECT COUNT(*) FROM lifecycle_rule_candidates) ruleCandidates,(SELECT COUNT(*) FROM meta_improvement_experiments) experiments,(SELECT COUNT(*) FROM meta_skill_activations) activations";
    const before = await db.prepare(businessSnapshot).first();
    const read = await get(h, session, "view=proposal-summary&asOf=" + encodeURIComponent(asOf));
    assert.equal(read.response.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.advisoryOnly, true);
    assert.equal(read.body.data.autoAdopt, false);
    assert.equal(read.body.data.pendingCount, 4);
    assert.equal(read.body.data.highestPriority.articleId, f.articleId);
    assert.equal(read.body.data.highestPriority.priority, "must");
    assert.doesNotMatch(JSON.stringify(read.body), /PRIVATE_SUMMARY_REQUIREMENT|PRIVATE_SUMMARY_COULD|PRIVATE_SUMMARY_OFFICIAL_FACT|PRIVATE_SUMMARY_INFERRED_IMPACT|recommendation|requirementText|officialFact/);
    await db.prepare("UPDATE article_requirements SET accepted_at=? WHERE id=?").bind(future, first.id).run();
    const shouldRead = await get(h, session, "view=proposal-summary&asOf=" + encodeURIComponent(asOf));
    assert.equal(shouldRead.body.data.highestPriority.articleId, second);
    assert.equal(shouldRead.body.data.highestPriority.priority, "should");
    await db.prepare("UPDATE article_requirements SET accepted_at=? WHERE id='summary-second'").bind(future).run();
    const couldRead = await get(h, session, "view=proposal-summary&asOf=" + encodeURIComponent(asOf));
    assert.equal(couldRead.body.data.highestPriority.articleId, third);
    assert.equal(couldRead.body.data.highestPriority.priority, "could");
    await db.prepare("UPDATE article_requirements SET accepted_at=? WHERE id='summary-third'").bind(future).run();
    const nullRead = await get(h, session, "view=proposal-summary&asOf=" + encodeURIComponent(asOf));
    assert.equal(nullRead.body.data.highestPriority.articleId, externalArticle);
    assert.equal(nullRead.body.data.highestPriority.priority, null);
    assert.deepEqual(await db.prepare(businessSnapshot).first(), before);
    const restrictedToken = randomBytes(24).toString("base64url"), expiry = "2099-01-01T00:00:00.000Z";
    await db.prepare("INSERT INTO management_sessions(id,principal_id,token_sha256,browser_binding_sha256,scopes_json,article_ids_json,object_boundary_json,status,absolute_expires_at,idle_expires_at,last_seen_at,created_at,revoke_reason) VALUES('summary-restricted','fixture',?,?,?,?,?,'active',?,?,?,?, '')").bind(sha256(restrictedToken), sha256(h.browserBinding), '["management.read"]', JSON.stringify([f.articleId]), '{}', expiry, expiry, old, old).run();
    const restrictedResponse = await h.mf.dispatchFetch(request("/api/annotation-rsi/v1?view=proposal-summary", { headers: { cookie: `wenmai_management_session=${restrictedToken}`, "X-Wenmai-Browser-Binding": h.browserBinding } })); const restrictedBody = await restrictedResponse.json();
    assert.equal(restrictedResponse.status, 403, JSON.stringify(restrictedBody)); assert.equal(restrictedBody.data, undefined); assert.doesNotMatch(JSON.stringify(restrictedBody), /pendingCount|highestPriority|proposal-summary/);
    const noScopeToken = randomBytes(24).toString("base64url");
    await db.prepare("INSERT INTO management_sessions(id,principal_id,token_sha256,browser_binding_sha256,scopes_json,article_ids_json,object_boundary_json,status,absolute_expires_at,idle_expires_at,last_seen_at,created_at,revoke_reason) VALUES('summary-no-scope','fixture',?,?,?,?,?,'active',?,?,?,?, '')").bind(sha256(noScopeToken), sha256(h.browserBinding), '[]', '["*"]', '{}', expiry, expiry, old, old).run();
    const noScopeResponse = await h.mf.dispatchFetch(request("/api/annotation-rsi/v1?view=proposal-summary", { headers: { cookie: "wenmai_management_session=" + noScopeToken, "X-Wenmai-Browser-Binding": h.browserBinding } }));
    const noScopeBody = await noScopeResponse.json();
    assert.equal(noScopeResponse.status, 403, JSON.stringify(noScopeBody));
    assert.equal(noScopeBody.data, undefined);
    await db.prepare("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<257) INSERT INTO article_requirements(id,article_id,requirement_key,revision,supersedes_requirement_id,package_id,branch_id,base_revision_id,base_body_sha256,title,requirement_text,acceptance_json,priority,input_sha256,status,lock_version,created_by_kind,created_by,accepted_by,accepted_at,create_command_id,last_command_id,created_at,updated_at) SELECT 'summary-over-'||n,?,'k-'||n,1,NULL,?,?,?,?,?,'x','{}','should',?,'accepted',1,'human','fixture','fixture',?,'c-'||n,'c-'||n,?,? FROM seq").bind(second, f.packageId, f.branchId, f.revisionId, f.bodySha, "x", sha256("summary-over"), old, old, old).run();
    const over = await get(h, session, "view=proposal-summary&asOf=2026-09-04T00:00:00.000Z"); assert.equal(over.response.status, 409, JSON.stringify(over.body)); assert.equal(over.body.data, undefined);
  } finally { await h.mf.dispose(); }
});

test("proposal summary fails closed over a corrupted cross-article annotation binding", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf); const session = await ownerSession(h); const f = await seedLineage(db);
    await post(h, session, "initialize_workspace", "summary-cross-init", { articleId: f.articleId });
    const sourceRequirement = await acceptedRequirement(h, session, f, "summary-cross-source");
    await db.prepare("UPDATE article_requirements SET accepted_at=? WHERE id=?").bind("2026-09-05T00:00:00.000Z", sourceRequirement.id).run();
    const targetArticle = "article-rsi-cross-target", annotationId = "summary-cross-annotation", observedAt = "2026-08-01T00:00:00.000Z";
    await db.prepare("INSERT INTO human_annotations(id,article_id,requirement_id,subject_type,subject_id,snapshot_sha256,label_schema_version,label_kind,verdict,severity,note,details_json,evidence_refs_json,annotation_sha256,supersedes_annotation_id,input_sha256,human_actor_id,command_id,created_at) VALUES(?,?,?,'article_revision',?,?,1,'quality','pass','info','PRIVATE_CROSS_ARTICLE_ANNOTATION','{}','[]',?,NULL,?,'fixture','summary-cross-annotation-command',?)").bind(annotationId, targetArticle, sourceRequirement.id, f.revisionId, f.bodySha, sha256("summary-cross-annotation"), sha256("summary-cross-input"), observedAt).run();
    const observation = { schemaVersion: "wenmai.annotation-rsi/1.0", articleId: targetArticle, canonicalSource: "https://openai.com/cross-article", sourceVersion: "cross", publishedAt: observedAt, contentSha256: sha256("summary-cross-content"), officialFact: "PRIVATE_CROSS_ARTICLE_FACT", inferredImpact: "PRIVATE_CROSS_ARTICLE_IMPACT", evidenceRefs: [annotationId], humanReviewed: true };
    await db.prepare("INSERT INTO lifecycle_events(id,article_id,event_type,subject_type,subject_id,payload_json,input_sha256,created_at) VALUES('summary-cross-event',?,'external_ai_change.recorded','external_ai_observation','summary-cross-event',?,?,?)").bind(targetArticle, canonicalJson(observation), sha256(canonicalJson(observation)), observedAt).run();
    const read = await get(h, session, "view=proposal-summary&asOf=2026-09-04T00:00:00.000Z");
    assert.equal(read.response.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.pendingCount, 1);
    assert.equal(read.body.data.highestPriority.articleId, targetArticle);
    assert.equal(read.body.data.highestPriority.triggerKind, "external_ai_change");
    assert.ok(read.body.data.highestPriority.blockerCodes.includes("NO_ACTIVE_HUMAN_ANNOTATION"));
    assert.doesNotMatch(JSON.stringify(read.body), /PRIVATE_CROSS_ARTICLE_ANNOTATION|PRIVATE_CROSS_ARTICLE_FACT|PRIVATE_CROSS_ARTICLE_IMPACT/);
  } finally { await h.mf.dispose(); }
});

test("reduced RSI lifecycle creates one candidate, human-approved baseline, and compact due summary", async () => {
  const h = await harness(); try {
    const db = await migrate(h.mf), session = await ownerSession(h), f = await seedLineage(db);
    const requirementRow = await acceptedRequirement(h, session, f, "rsi-reduced-requirement");
    const annotationRow = await post(h, session, "create_human_annotation", "rsi-reduced-annotation", annotationPayload(f, requirementRow.id, "article_revision", f.revisionId, f.bodySha));
    assert.equal(annotationRow.response.status, 201, JSON.stringify(annotationRow.body));
    const sourceBindings = [
      { kind: "accepted_requirement", id: requirementRow.id, sha256: requirementRow.inputSha256 },
      { kind: "human_annotation", id: annotationRow.body.data.id, sha256: annotationRow.body.data.annotationSha256 },
    ];
    const candidate = await post(h, session, "create_rule_candidate", "rsi-reduced-candidate", { articleId: f.articleId, projectId: "project-rsi", sourceBindings, rule: { requireHumanLabel: true }, variantIds: [] });
    assert.equal(candidate.response.status, 201, JSON.stringify(candidate.body));
    const approved = await post(h, session, "approve_rule_candidate", "rsi-reduced-approve", {
      articleId: f.articleId, candidateId: candidate.body.data.id, expectedCanonicalRuleSha256: candidate.body.data.canonicalRuleSha256,
      expectedCandidateSha256: candidate.body.data.candidateSha256, expectedLockVersion: 1, expectedSourceSetSha256: candidate.body.data.sourceSetSha256,
      expectedHeadRevisionId: null, expectedHeadRevisionSha256: null, note: "人工批准",
    });
    assert.equal(approved.response.status, 201, JSON.stringify(approved.body));
    const baseline = await get(h, session, `view=baseline-revisions&articleId=${f.articleId}`);
    assert.equal(baseline.response.status, 200, JSON.stringify(baseline.body));
    assert.equal(baseline.body.data.items.length, 1);
    const due = await post(h, session, "run_due_check", "rsi-reduced-due", { articleId: f.articleId, projectId: "project-rsi", triggerKind: "task_terminal" });
    assert.equal(due.response.status, 200, JSON.stringify(due.body));
    assert.deepEqual(Object.keys(due.body.data.sourceSummary).sort(), ["acceptedRequirementCount", "activeAnnotationCount", "baselineId"]);
  } finally { await h.mf.dispose(); }
});
