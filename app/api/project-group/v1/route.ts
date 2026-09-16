import { env } from "cloudflare:workers";
import { ManagementAuthError } from "../../../management-auth-core";
import { managementActorId, requireManagementSession } from "../../../management-auth";
import { canonicalProjectGroupTopology, canonicalProjectGroupTopologyJson, isProjectGroupDag, wouldIntroduceProjectGroupCycle } from "../../../project-group-model";
export const runtime = "edge";
type Row = Record<string, string | number | null>;
type Obj = Record<string, unknown>;
const ACTIONS = new Set(["create_group", "update_group", "archive_group", "add_member", "remove_member", "add_edge", "remove_edge"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
class E extends Error {
    constructor(public code: string, message: string, public status = 400, public details?: Obj) { super(message); }
}
const bad = (code: string, message: string, status = 400, details?: Obj): never => { throw new E(code, message, status, details); };
const obj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
function text(v: unknown, k: string, max = 240) { const s = typeof v === "string" ? v.trim().replace(/\s+/gu, " ") : ""; if (!s)
    bad("MISSING_FIELD", `缺少 ${k}`); if (s.length > max)
    bad("FIELD_TOO_LARGE", `${k} 过长`, 413); return s; }
function id(v: unknown, k: string) { const s = text(v, k, 200); if (!ID.test(s))
    bad("INVALID_ID", `${k} 无效`); return s; }
function version(v: unknown) { const n = Number(v); if (!Number.isInteger(n) || n < 1)
    bad("INVALID_LOCK_VERSION", "expectedLockVersion 必须为正整数"); return n; }
const now = () => new Date().toISOString();
const row = (r: Row, k: string) => r[k] === null || r[k] === undefined ? "" : String(r[k]);
function canon(v: unknown): unknown { if (Array.isArray(v))
    return v.map(canon); if (obj(v))
    return Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canon(v[k])])); return v ?? null; }
const json = (v: unknown) => JSON.stringify(canon(v));
async function sha(s: string) { const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); return Array.from(d, x => x.toString(16).padStart(2, "0")).join(""); }
function database(): D1Database { if (!env.DB)
    bad("DB_UNAVAILABLE", "ProjectGroup 数据库尚未连接", 503); return env.DB; }
const response = (data: Obj, status = 200) => Response.json({ ok: true, data }, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
function failure(x: unknown) { const e = x instanceof E || x instanceof ManagementAuthError ? x : new E("INTERNAL_ERROR", "ProjectGroup 请求失败", 500); return Response.json({ ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }, { status: e.status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } }); }
async function ensureReady(db: D1Database) { try {
    const r = await db.prepare("SELECT type,name FROM sqlite_master WHERE (type='table' AND name IN ('project_groups','project_group_members','project_group_edges','project_group_events','project_group_command_receipts')) OR (type='trigger' AND name IN ('project_group_events_no_update','project_group_events_no_delete','project_group_command_receipts_no_update','project_group_command_receipts_no_delete')) OR (type='index' AND name='idx_lifecycle_article_projects_id_article')").all<Row>();
    const found = new Set(r.results.map(x => `${row(x, 'type')}:${row(x, 'name')}`));
    for (const key of ['table:project_groups', 'table:project_group_members', 'table:project_group_edges', 'table:project_group_events', 'table:project_group_command_receipts', 'trigger:project_group_events_no_update', 'trigger:project_group_events_no_delete', 'trigger:project_group_command_receipts_no_update', 'trigger:project_group_command_receipts_no_delete', 'index:idx_lifecycle_article_projects_id_article'])
        if (!found.has(key))
            bad("PROJECT_GROUP_NOT_INITIALIZED", "ProjectGroup 数据库迁移尚未完成", 503);
}
catch (e) {
    if (e instanceof E)
        throw e;
    bad("PROJECT_GROUP_NOT_INITIALIZED", "ProjectGroup 数据库迁移尚未完成", 503);
} }
async function detail(db: D1Database, groupId: string) { const g = await db.prepare("SELECT * FROM project_groups WHERE id=? LIMIT 1").bind(groupId).first<Row>(); if (!g)
    bad("GROUP_NOT_FOUND", "ProjectGroup 不存在", 404); const ms = await db.prepare("SELECT article_id,article_project_id FROM project_group_members WHERE group_id=? ORDER BY article_id,article_project_id").bind(groupId).all<Row>(); const es = await db.prepare("SELECT source_article_id,target_article_id,relation_type FROM project_group_edges WHERE group_id=? ORDER BY source_article_id,target_article_id,relation_type").bind(groupId).all<Row>(); const topology = canonicalProjectGroupTopology({ groupId, members: ms.results.map(r => ({ articleId: row(r, "article_id"), articleProjectId: row(r, "article_project_id") })), edges: es.results.map(r => ({ sourceArticleId: row(r, "source_article_id"), targetArticleId: row(r, "target_article_id"), relationType: "precedes" as const })) }); const recomputedTopologySha256 = await sha(JSON.stringify(topology)); const storedTopologySha256 = row(g, "topology_sha256"); return { group: { id: groupId, title: row(g, "title"), status: row(g, "status"), lockVersion: Number(g.lock_version), createdBy: row(g, "created_by"), createdAt: row(g, "created_at"), updatedAt: row(g, "updated_at"), archivedAt: g.archived_at }, members: topology.members, edges: topology.edges, topology, storedTopologySha256, recomputedTopologySha256, integrityStatus: storedTopologySha256 === recomputedTopologySha256 && isProjectGroupDag(topology.edges) ? "valid" : "drifted" }; }
async function active(db: D1Database, id: string) { const d = await detail(db, id); if (d.integrityStatus !== "valid")
    bad("TOPOLOGY_INTEGRITY_DRIFT", "拓扑摘要漂移，已停止写入", 409); if (d.group.status !== "active")
    bad("GROUP_ARCHIVED", "已归档 ProjectGroup 只读", 409); return d; }
async function input(request: Request) { const raw = await request.text(); if (new TextEncoder().encode(raw).byteLength > 80000)
    bad("REQUEST_TOO_LARGE", "请求过大", 413); let b: unknown; try {
    b = JSON.parse(raw);
}
catch {
    bad("INVALID_JSON", "请求正文不是 JSON");
} if (!obj(b) || !obj(b.payload))
    bad("INVALID_PAYLOAD", "payload 必须是对象"); const action = text(b.action, "action", 80); if (!ACTIONS.has(action))
    bad("UNKNOWN_ACTION", "未知动作", 404); return { action, commandId: id(b.commandId, "commandId"), payload: b.payload }; }
async function saved(db: D1Database, commandId: string, action: string, actor: string, requestSha: string) { const r = await db.prepare("SELECT * FROM project_group_command_receipts WHERE command_id=? LIMIT 1").bind(commandId).first<Row>(); if (!r)
    return null; if (r.action !== action || r.actor_id !== actor || r.request_sha256 !== requestSha)
    bad("COMMAND_ID_REUSED", "commandId 已绑定不同请求", 409); if (r.status !== "succeeded" || Number(r.status_code) <= 0 || !r.completed_at)
    bad("INVALID_RECEIPT", "回执必须是完整终态", 500); try {
    return JSON.parse(row(r, "mutation_readback_json")) as Obj;
}
catch {
    bad("INVALID_RECEIPT", "回执不可读", 500);
} }
async function mutate(db: D1Database, action: string, commandId: string, actor: string, p: Obj) {
    const requestSha = await sha(json({ schemaVersion: "wenmai.project-group-command/1", action, actor, payload: p }));
    const replay = await saved(db, commandId, action, actor, requestSha);
    if (replay)
        return { ...replay, replayed: true };
    const groupId = id(p.groupId, "groupId"), t = now(), before = action === "create_group" ? null : await active(db, groupId), expected = version(p.expectedLockVersion);
    if (before && before.group.lockVersion !== expected)
        bad("LOCK_CONFLICT", "锁版本已变化", 409);
    if (action === "create_group" && expected !== 1)
        bad("INVALID_LOCK_VERSION", "创建锁版本必须是 1");
    let title = before?.group.title ?? text(p.title, "title"), status = before?.group.status ?? "active", members = before?.members ?? [], edges = before?.edges ?? [];
    const domain: D1PreparedStatement[] = [];
    if (action === "update_group")
        title = text(p.title, "title");
    if (action === "archive_group")
        status = "archived";
    if (action === "add_member") {
        const articleId = id(p.articleId, "articleId"), articleProjectId = id(p.articleProjectId, "articleProjectId");
        if (members.some(m => m.articleId === articleId || m.articleProjectId === articleProjectId))
            bad("MEMBER_EXISTS", "成员已存在", 409);
        members = [...members, { articleId, articleProjectId }];
        domain.push(db.prepare("INSERT INTO project_group_members(id,group_id,article_id,article_project_id,created_at) VALUES(?,?,?,?,?)").bind(`pgm-${crypto.randomUUID()}`, groupId, articleId, articleProjectId, t));
    }
    if (action === "remove_member") {
        const articleId = id(p.articleId, "articleId");
        if (edges.some(e => e.sourceArticleId === articleId || e.targetArticleId === articleId))
            bad("MEMBER_HAS_EDGES", "成员有边，不能移除", 409);
        if (!members.some(m => m.articleId === articleId))
            bad("MEMBER_NOT_FOUND", "成员不存在", 404);
        members = members.filter(m => m.articleId !== articleId);
        domain.push(db.prepare("DELETE FROM project_group_members WHERE group_id=? AND article_id=?").bind(groupId, articleId));
    }
    if (action === "add_edge") {
        const sourceArticleId = id(p.sourceArticleId, "sourceArticleId"), targetArticleId = id(p.targetArticleId, "targetArticleId");
        if (sourceArticleId === targetArticleId || wouldIntroduceProjectGroupCycle(edges, sourceArticleId, targetArticleId))
            bad("CYCLE_REJECTED", "边会形成环", 409);
        if (!members.some(m => m.articleId === sourceArticleId) || !members.some(m => m.articleId === targetArticleId))
            bad("CROSS_GROUP_EDGE", "边端点必须同组", 409);
        if (edges.some(e => e.sourceArticleId === sourceArticleId && e.targetArticleId === targetArticleId))
            bad("EDGE_EXISTS", "边已存在", 409);
        edges = [...edges, { sourceArticleId, targetArticleId, relationType: "precedes" }];
        domain.push(db.prepare("INSERT INTO project_group_edges(id,group_id,source_article_id,target_article_id,relation_type,created_at) VALUES(?,?,?,?,?,?)").bind(`pge-${crypto.randomUUID()}`, groupId, sourceArticleId, targetArticleId, "precedes", t));
    }
    if (action === "remove_edge") {
        const sourceArticleId = id(p.sourceArticleId, "sourceArticleId"), targetArticleId = id(p.targetArticleId, "targetArticleId");
        if (!edges.some(e => e.sourceArticleId === sourceArticleId && e.targetArticleId === targetArticleId))
            bad("EDGE_NOT_FOUND", "边不存在", 404);
        edges = edges.filter(e => e.sourceArticleId !== sourceArticleId || e.targetArticleId !== targetArticleId);
        domain.push(db.prepare("DELETE FROM project_group_edges WHERE group_id=? AND source_article_id=? AND target_article_id=? AND relation_type='precedes'").bind(groupId, sourceArticleId, targetArticleId));
    }
    const topologySha256 = await sha(canonicalProjectGroupTopologyJson({ groupId, members, edges })), beforeVersion = action === "create_group" ? 0 : expected, after = beforeVersion + 1, readback = { groupId, action, group: { id: groupId, title, status, lockVersion: after }, topology: canonicalProjectGroupTopology({ groupId, members, edges }), topologySha256 };
    const cas = action === "create_group" ? db.prepare("INSERT INTO project_groups(id,title,status,topology_sha256,lock_version,created_by,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)").bind(groupId, title, "active", topologySha256, actor, t, t) : db.prepare("UPDATE project_groups SET title=?,status=?,topology_sha256=?,lock_version=lock_version+1,updated_at=?,archived_at=CASE WHEN ?='archived' THEN ? ELSE archived_at END WHERE id=? AND status='active' AND lock_version=?").bind(title, status, topologySha256, t, status, t, groupId, expected);
    // CASE ELSE NULL deliberately trips command_id NOT NULL: this is the final in-batch sentinel, so any failed CAS/event assertion rolls the whole D1 batch back.
    const event = db.prepare("INSERT INTO project_group_events(id,group_id,event_type,actor_id,command_id,request_sha256,before_lock_version,after_lock_version,result_topology_sha256,details_json,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM project_groups WHERE id=? AND lock_version=? AND topology_sha256=?)").bind(`pgev-${crypto.randomUUID()}`, groupId, action, actor, commandId, requestSha, beforeVersion, after, topologySha256, json({ action, payload: p }), t, groupId, after, topologySha256);
    const assertionFor = (condition: string, bindings: unknown[]) => db.prepare(`INSERT INTO project_group_command_receipts(command_id,action,actor_id,request_sha256,mutation_readback_json,result_lock_version,topology_sha256,status,status_code,created_at,completed_at) SELECT NULL,'assertion','assertion',?,'{}',1,?,'succeeded',200,?,? WHERE NOT (${condition})`).bind(requestSha, topologySha256, t, t, ...bindings);
    const assertion = action === "add_member" ? assertionFor("EXISTS(SELECT 1 FROM project_group_members WHERE group_id=? AND article_id=? AND article_project_id=?)", [groupId, id(p.articleId, "articleId"), id(p.articleProjectId, "articleProjectId")]) : action === "remove_member" ? assertionFor("NOT EXISTS(SELECT 1 FROM project_group_members WHERE group_id=? AND article_id=?)", [groupId, id(p.articleId, "articleId")]) : action === "add_edge" ? assertionFor("EXISTS(SELECT 1 FROM project_group_edges WHERE group_id=? AND source_article_id=? AND target_article_id=? AND relation_type='precedes')", [groupId, id(p.sourceArticleId, "sourceArticleId"), id(p.targetArticleId, "targetArticleId")]) : action === "remove_edge" ? assertionFor("NOT EXISTS(SELECT 1 FROM project_group_edges WHERE group_id=? AND source_article_id=? AND target_article_id=? AND relation_type='precedes')", [groupId, id(p.sourceArticleId, "sourceArticleId"), id(p.targetArticleId, "targetArticleId")]) : undefined;
    const receipt = db.prepare("INSERT INTO project_group_command_receipts(command_id,action,actor_id,request_sha256,mutation_readback_json,result_lock_version,topology_sha256,status,status_code,created_at,completed_at) VALUES(CASE WHEN EXISTS(SELECT 1 FROM project_groups WHERE id=? AND lock_version=? AND topology_sha256=?) AND EXISTS(SELECT 1 FROM project_group_events WHERE command_id=? AND group_id=? AND after_lock_version=? AND result_topology_sha256=?) AND NOT EXISTS(WITH RECURSIVE walk(start_id,node_id) AS (SELECT source_article_id,target_article_id FROM project_group_edges WHERE group_id=? UNION SELECT walk.start_id,e.target_article_id FROM walk JOIN project_group_edges e ON e.group_id=? AND e.source_article_id=walk.node_id) SELECT 1 FROM walk WHERE start_id=node_id) THEN ? ELSE NULL END,?,?,?,?,?,?,'succeeded',200,?,?)").bind(groupId, after, topologySha256, commandId, groupId, after, topologySha256, groupId, groupId, commandId, action, actor, requestSha, json(readback), after, topologySha256, t, t);
    try {
        await db.batch([cas, ...domain, event, ...(assertion ? [assertion] : []), receipt]);
    }
    catch (original) {
        const terminal = await saved(db, commandId, action, actor, requestSha);
        if (terminal)
            return { ...terminal, replayed: true };
        throw original;
    }
    const final = await saved(db, commandId, action, actor, requestSha);
    if (!final)
        bad("RECEIPT_MISSING", "未生成终态回执", 500);
    return { ...final, replayed: false };
}
export async function GET(request: Request) { try {
    await requireManagementSession(request, { scope: "management.read" });
    const db = database();
    await ensureReady(db);
    const u = new URL(request.url), view = u.searchParams.get("view") ?? "list", limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit") ?? 50)));
    if (!Number.isInteger(limit))
        bad("INVALID_LIMIT", "limit 无效");
    if (view === "detail")
        return response(await detail(db, id(u.searchParams.get("groupId"), "groupId")));
    const archived = u.searchParams.get("includeArchived") === "true" ? 1 : 0;
    if (view === "by-article") {
        const rows = await db.prepare("SELECT g.id FROM project_groups g JOIN project_group_members m ON m.group_id=g.id WHERE m.article_id=? AND (?=1 OR g.status='active') ORDER BY g.updated_at DESC LIMIT ?").bind(id(u.searchParams.get("articleId"), "articleId"), archived, limit).all<Row>();
        return response({ groups: await Promise.all(rows.results.map(r => detail(db, row(r, "id")))) });
    }
    const rows = await db.prepare("SELECT id FROM project_groups WHERE (?=1 OR status='active') ORDER BY updated_at DESC LIMIT ?").bind(archived, limit).all<Row>();
    return response({ groups: await Promise.all(rows.results.map(r => detail(db, row(r, "id")))) });
}
catch (e) {
    return failure(e);
} }
export async function POST(request: Request) { try {
    if (request.headers.has("authorization"))
        bad("AUTHORIZATION_HEADER_FORBIDDEN", "禁止 Authorization", 401);
    if (request.headers.get("X-Wenmai-Write") !== "1")
        bad("WRITE_HEADER_REQUIRED", "缺少 X-Wenmai-Write", 403);
    const principal = await requireManagementSession(request, { mutation: true, scope: "lifecycle.write" }), i = await input(request), db = database();
    await ensureReady(db);
    return response(await mutate(db, i.action, i.commandId, managementActorId(principal), i.payload));
}
catch (e) {
    return failure(e);
} }
