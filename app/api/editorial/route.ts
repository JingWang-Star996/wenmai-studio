import { env } from "cloudflare:workers";
import { ManagementAuthError } from "../../management-auth-core";
import { requireManagementSession } from "../../management-auth";

type D1Row = Record<string, string | number | null>;

const EDITORIAL_STATES = new Set(["inbox", "planned", "researching", "drafting", "review", "approved", "maintaining", "retired"]);
const EVIDENCE_STATES = new Set(["证据冲突", "有精确绑定证据", "存在弱线索", "仅文件线索", "未知"]);
const GATE_STATES = new Set([
  "不适用",
  "自动提醒：证据线索偏少",
  "自动提醒：长句偏多",
  "自动扫描：未发现明确结构提醒",
]);

function database() {
  if (!env.DB) throw new Error("本地编辑数据库尚未连接");
  return env.DB;
}

async function ensureSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS editorial_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('topic', 'series')),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '候选',
      summary TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT '中',
      linked_article_ids TEXT NOT NULL DEFAULT '[]',
      next_action TEXT NOT NULL DEFAULT '',
      source_opportunity_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_editorial_items_kind_status ON editorial_items(kind, status)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_editorial_items_source_opportunity ON editorial_items(source_opportunity_id) WHERE source_opportunity_id IS NOT NULL"),
    db.prepare(`CREATE TABLE IF NOT EXISTS article_overrides (
      article_id TEXT PRIMARY KEY,
      editorial_state TEXT NOT NULL DEFAULT 'inbox',
      gate_state TEXT NOT NULL DEFAULT 'not_run',
      evidence_health TEXT NOT NULL DEFAULT 'unknown',
      favorite INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      series_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_article_overrides_editorial_state ON article_overrides(editorial_state)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS decision_events (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('article', 'opportunity', 'identity')),
      subject_id TEXT NOT NULL,
      decision_type TEXT NOT NULL,
      value_json TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      rule_version TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_decision_events_subject ON decision_events(subject_type, subject_id, created_at)"),
  ]);
  return db;
}

function jsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 100);
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseItem(row: D1Row) {
  let linkedArticleIds: string[] = [];
  try {
    linkedArticleIds = JSON.parse(String(row.linked_article_ids ?? "[]"));
  } catch {
    linkedArticleIds = [];
  }
  return {
    id: String(row.id),
    kind: String(row.kind),
    title: String(row.title),
    status: String(row.status),
    summary: String(row.summary ?? ""),
    rationale: String(row.rationale ?? ""),
    confidence: String(row.confidence ?? "中"),
    linkedArticleIds,
    nextAction: String(row.next_action ?? ""),
    sourceOpportunityId: row.source_opportunity_id ? String(row.source_opportunity_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseOverride(row: D1Row) {
  return {
    articleId: String(row.article_id),
    editorialState: String(row.editorial_state),
    gateState: String(row.gate_state),
    evidenceHealth: String(row.evidence_health),
    favorite: Boolean(row.favorite),
    notes: String(row.notes ?? ""),
    seriesId: row.series_id ? String(row.series_id) : null,
    updatedAt: String(row.updated_at),
  };
}

function parseDecision(row: D1Row) {
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(String(row.value_json ?? "{}"));
  } catch {
    value = {};
  }
  return {
    id: String(row.id),
    subjectType: String(row.subject_type),
    subjectId: String(row.subject_id),
    decisionType: String(row.decision_type),
    value,
    notes: String(row.notes ?? ""),
    ruleVersion: String(row.rule_version),
    inputSha256: String(row.input_sha256),
    createdAt: String(row.created_at),
  };
}

export async function GET(request: Request) {
  try {
    await requireManagementSession(request, { scope: "management.read" });
    const db = await ensureSchema();
    const [itemsResult, overridesResult, decisionsResult] = await db.batch([
      db.prepare("SELECT * FROM editorial_items ORDER BY updated_at DESC, created_at DESC LIMIT 250"),
      db.prepare("SELECT * FROM article_overrides ORDER BY updated_at DESC LIMIT 500"),
      db.prepare("SELECT * FROM decision_events ORDER BY created_at DESC LIMIT 1000"),
    ]);
    return Response.json({
      storage: "d1-local",
      items: (itemsResult.results as D1Row[]).map(parseItem),
      overrides: (overridesResult.results as D1Row[]).map(parseOverride),
      decisions: (decisionsResult.results as D1Row[]).map(parseDecision),
    });
  } catch (error) {
    const status = error instanceof ManagementAuthError ? error.status : 503;
    return Response.json(
      {
        storage: "unavailable",
        items: [],
        overrides: [],
        error: error instanceof Error ? error.message : "数据库不可用",
        ...(error instanceof ManagementAuthError ? { code: error.code } : {}),
      },
      { status },
    );
  }
}

export async function POST(request: Request) {
  try {
    try {
      await requireManagementSession(request, { mutation: true, scope: "editorial.write" });
    } catch (error) {
      if (error instanceof ManagementAuthError) {
        return Response.json({ error: error.message, code: error.code }, { status: error.status });
      }
      throw error;
    }
    const payload = await request.json() as Record<string, unknown>;
    const action = cleanText(payload.action, 40);
    const db = await ensureSchema();

    if (action === "storage_probe") {
      const probeId = `qa-${crypto.randomUUID()}`;
      const decisionProbeId = `decision-${crypto.randomUUID()}`;
      await db.batch([
        db.prepare(`INSERT INTO editorial_items
          (id, kind, title, status, summary, rationale, confidence, linked_article_ids, next_action, source_opportunity_id)
          VALUES (?, 'topic', '持久化自检', 'qa', '', '', '中', '[]', '', '__qa_probe__')`)
          .bind(probeId),
        db.prepare("DELETE FROM editorial_items WHERE id = ? AND source_opportunity_id = '__qa_probe__'")
          .bind(probeId),
        db.prepare(`INSERT INTO decision_events
          (id, subject_type, subject_id, decision_type, value_json, notes, rule_version, input_sha256)
          VALUES (?, 'article', '__qa_probe__', 'storage_probe', '{}', '', 'qa/1', ?)`)
          .bind(decisionProbeId, await sha256Text(decisionProbeId)),
        db.prepare("DELETE FROM decision_events WHERE id = ? AND subject_id = '__qa_probe__'").bind(decisionProbeId),
        db.prepare(`INSERT INTO article_overrides
          (article_id, editorial_state, gate_state, evidence_health, favorite, notes, series_id)
          VALUES ('__qa_probe__', 'inbox', 'not_run', '未知', 0, '', NULL)`),
        db.prepare("DELETE FROM article_overrides WHERE article_id = '__qa_probe__'"),
      ]);
      return Response.json({ storage: "d1-local", writable: true, cleaned: true });
    }

    if (action === "accept_opportunity") {
      const sourceOpportunityId = cleanText(payload.sourceOpportunityId, 120);
      const title = cleanText(payload.title, 180);
      const requestedStatus = cleanText(payload.status, 20);
      const status = requestedStatus === "已采纳"
        ? "已入候选池"
        : ["已入候选池", "稍后", "不做"].includes(requestedStatus)
          ? requestedStatus
          : "已入候选池";
      if (!sourceOpportunityId || !title) {
        return Response.json({ error: "缺少机会 ID 或标题" }, { status: 400 });
      }
      const existing = await db.prepare("SELECT * FROM editorial_items WHERE source_opportunity_id = ? LIMIT 1").bind(sourceOpportunityId).first<D1Row>();
      const decisionId = `decision-${crypto.randomUUID()}`;
      const decisionInput = await sha256Text(JSON.stringify({ sourceOpportunityId, title, status }));
      if (existing) {
        await db.batch([
          db.prepare("UPDATE editorial_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, existing.id),
          db.prepare(`INSERT INTO decision_events
            (id, subject_type, subject_id, decision_type, value_json, notes, rule_version, input_sha256)
            VALUES (?, 'opportunity', ?, 'opportunity.disposition', ?, '', 'opportunity-decision/1.0.0', ?)`)
            .bind(decisionId, sourceOpportunityId, JSON.stringify({ status }), decisionInput),
        ]);
        const updated = await db.prepare("SELECT * FROM editorial_items WHERE id = ?").bind(existing.id).first<D1Row>();
        return Response.json({ item: updated ? parseItem(updated) : parseItem(existing), existed: true });
      }

      const id = `plan-${crypto.randomUUID()}`;
      const kind = cleanText(payload.kind, 20) === "series" ? "series" : "topic";
      await db.batch([
        db.prepare(`INSERT INTO editorial_items
          (id, kind, title, status, summary, rationale, confidence, linked_article_ids, next_action, source_opportunity_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            id,
            kind,
            title,
            status,
            cleanText(payload.summary, 1200),
            cleanText(payload.rationale, 1800),
            cleanText(payload.confidence, 12) || "中",
            JSON.stringify(jsonArray(payload.linkedArticleIds)),
            cleanText(payload.nextAction, 800),
            sourceOpportunityId,
          ),
        db.prepare(`INSERT INTO decision_events
          (id, subject_type, subject_id, decision_type, value_json, notes, rule_version, input_sha256)
          VALUES (?, 'opportunity', ?, 'opportunity.disposition', ?, '', 'opportunity-decision/1.0.0', ?)`)
          .bind(decisionId, sourceOpportunityId, JSON.stringify({ status }), decisionInput),
      ]);
      const created = await db.prepare("SELECT * FROM editorial_items WHERE id = ?").bind(id).first<D1Row>();
      return Response.json({ item: created ? parseItem(created) : null, existed: false }, { status: 201 });
    }

    if (action === "save_override") {
      const articleId = cleanText(payload.articleId, 120);
      if (!articleId) return Response.json({ error: "缺少文章 ID" }, { status: 400 });
      const editorialState = cleanText(payload.editorialState, 40);
      const evidenceHealth = cleanText(payload.evidenceHealth, 40);
      if (!EDITORIAL_STATES.has(editorialState)) return Response.json({ error: "非法编辑阶段" }, { status: 400 });
      if (!EVIDENCE_STATES.has(evidenceHealth)) return Response.json({ error: "非法证据状态" }, { status: 400 });
      const gateState = cleanText(payload.gateState, 120);
      if (!GATE_STATES.has(gateState)) return Response.json({ error: "非法门禁状态；人工保存不能写入“通过”" }, { status: 400 });
      const notes = cleanText(payload.notes, 4000);
      const seriesId = cleanText(payload.seriesId, 120) || null;
      const ruleVersion = cleanText(payload.ruleVersion, 120) || "manual-editorial/1.0.0";
      const suppliedInput = cleanText(payload.inputSha256, 64).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(suppliedInput)) {
        return Response.json({ error: "保存编辑决定前必须提供有效输入摘要" }, { status: 400 });
      }
      const inputSha256 = suppliedInput;
      const decisionId = `decision-${crypto.randomUUID()}`;
      const decisionValue = { editorialState, gateState, evidenceHealth, favorite: Boolean(payload.favorite), seriesId };
      await db.batch([
        db.prepare(`INSERT INTO article_overrides
          (article_id, editorial_state, gate_state, evidence_health, favorite, notes, series_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(article_id) DO UPDATE SET
            editorial_state = excluded.editorial_state,
            gate_state = excluded.gate_state,
            evidence_health = excluded.evidence_health,
            favorite = excluded.favorite,
            notes = excluded.notes,
            series_id = excluded.series_id,
            updated_at = CURRENT_TIMESTAMP`)
          .bind(articleId, editorialState, gateState, evidenceHealth, payload.favorite ? 1 : 0, notes, seriesId),
        db.prepare(`INSERT INTO decision_events
          (id, subject_type, subject_id, decision_type, value_json, notes, rule_version, input_sha256)
          VALUES (?, 'article', ?, 'article.override', ?, ?, ?, ?)`)
          .bind(decisionId, articleId, JSON.stringify(decisionValue), notes, ruleVersion, inputSha256),
      ]);
      const saved = await db.prepare("SELECT * FROM article_overrides WHERE article_id = ?").bind(articleId).first<D1Row>();
      const decision = await db.prepare("SELECT * FROM decision_events WHERE id = ?").bind(decisionId).first<D1Row>();
      return Response.json({ override: saved ? parseOverride(saved) : null, decision: decision ? parseDecision(decision) : null });
    }

    if (action === "record_identity_decision") {
      const articleId = cleanText(payload.articleId, 120);
      const decision = cleanText(payload.decision, 40);
      if (!articleId || !["confirm_group", "review_split"].includes(decision)) {
        return Response.json({ error: "缺少文章 ID 或身份决定非法" }, { status: 400 });
      }
      const suppliedInput = cleanText(payload.inputSha256, 64).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(suppliedInput)) return Response.json({ error: "身份决定缺少有效输入摘要" }, { status: 400 });
      const id = `decision-${crypto.randomUUID()}`;
      await db.prepare(`INSERT INTO decision_events
        (id, subject_type, subject_id, decision_type, value_json, notes, rule_version, input_sha256)
        VALUES (?, 'identity', ?, 'identity.disposition', ?, ?, ?, ?)`)
        .bind(
          id,
          articleId,
          JSON.stringify({ decision }),
          cleanText(payload.notes, 1000),
          cleanText(payload.ruleVersion, 120) || "wenmai-identity/manual-1",
          suppliedInput,
        )
        .run();
      const saved = await db.prepare("SELECT * FROM decision_events WHERE id = ?").bind(id).first<D1Row>();
      return Response.json({ decision: saved ? parseDecision(saved) : null }, { status: 201 });
    }

    return Response.json({ error: "未知动作" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存失败" }, { status: 500 });
  }
}
