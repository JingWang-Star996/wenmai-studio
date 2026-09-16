export const ARTICLE_PUBLICATION_SEMANTIC_GATE_SCHEMA_VERSION = "wenmai.article-publication-semantic-gate/1.2.0";
export const ARTICLE_PUBLICATION_SEMANTIC_INVARIANT_IDS = [
  "author_entry", "problem_origin", "first_term_explanation", "reading_route",
  "core_proposition", "evidence_boundary", "responsibility_boundary",
] as const;

type InvariantId = typeof ARTICLE_PUBLICATION_SEMANTIC_INVARIANT_IDS[number];
type JsonRecord = Record<string, unknown>;
const SHA256_RE = /^[a-f0-9]{64}$/u;
export const ARTICLE_PUBLICATION_SEMANTIC_LEAD_WINDOW_CHARACTERS = 800;
const MIN_EVIDENCE_QUOTE_CHARACTERS = 8;
const MIN_READER_ANSWER_CHARACTERS = 8;
const EVIDENCE_REGIONS = new Set(["lead", "body", "tail"]);
const REQUIRED_LEAD_IDS = new Set<InvariantId>([
  "author_entry", "problem_origin", "first_term_explanation", "reading_route",
]);

function record(value: unknown): JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function rawText(value: unknown): string { return typeof value === "string" ? value : ""; }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const input = value as JsonRecord;
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}`;
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Article Revision body_sha256 and primaryThesisSha256 are raw UTF-8 text digests. */
export async function sha256Text(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function semanticGateContractSha256(items: unknown, primaryThesis: unknown = ""): Promise<string> {
  const normalized = (Array.isArray(items) ? items : []).map((item) => {
    const entry = record(item);
    return { id: text(entry.id), evidenceQuote: text(entry.evidenceQuote), evidenceRef: text(entry.evidenceRef), region: text(entry.region) };
  });
  return digest({ schemaVersion: ARTICLE_PUBLICATION_SEMANTIC_GATE_SCHEMA_VERSION, invariantIds: ARTICLE_PUBLICATION_SEMANTIC_INVARIANT_IDS, primaryThesis: text(primaryThesis), items: normalized });
}

export type ArticlePublicationSemanticGateResult = {
  valid: boolean;
  state: "passed" | "semantic_gate_missing" | "failed";
  errors: string[];
};

export function validatePlatformCanonicalContractBinding(value: unknown, canonicalContractSha256: string, canonicalPrimaryThesisSha256?: string): string[] {
  const bound = text(record(value).canonicalContractSha256).toLowerCase();
  if (!SHA256_RE.test(bound)) return ["platform semanticGate 缺少 canonicalContractSha256"];
  const errors = bound === canonicalContractSha256
    ? []
    : ["platform semanticGate.canonicalContractSha256 未精确绑定当前 canonical semantic contract"];
  const primaryBound = text(record(value).canonicalPrimaryThesisSha256).toLowerCase();
  if (!SHA256_RE.test(primaryBound)) errors.push("platform semanticGate 缺少 canonicalPrimaryThesisSha256");
  if (!canonicalPrimaryThesisSha256 || !SHA256_RE.test(canonicalPrimaryThesisSha256)) errors.push("当前 canonical primaryThesisSha256 无效，不能验证平台主命题绑定");
  else if (primaryBound !== canonicalPrimaryThesisSha256) errors.push("platform semanticGate.canonicalPrimaryThesisSha256 未精确绑定当前 canonical primary thesis");
  const platformPrimaryThesisSha256 = text(record(value).primaryThesisSha256).toLowerCase();
  if (!SHA256_RE.test(platformPrimaryThesisSha256)) errors.push("platform semanticGate 缺少 primaryThesisSha256");
  else if (canonicalPrimaryThesisSha256 && platformPrimaryThesisSha256 !== canonicalPrimaryThesisSha256) errors.push("platform semanticGate.primaryThesisSha256 必须精确等于当前 canonical primary thesis");
  return errors;
}

/** Validates exact reader-visible evidence; it intentionally has no keyword/similarity fallback. */
export async function validateArticlePublicationSemanticGate(
  value: unknown,
  bodyText: string,
  expectedBodySha256: string,
): Promise<ArticlePublicationSemanticGateResult> {
  if (value === undefined || value === null) return { valid: false, state: "semantic_gate_missing", errors: ["缺少 semanticGate；历史登记只可读取，不能新登记或建构"] };
  const gate = record(value); const errors: string[] = [];
  const computedBodySha256 = await sha256Text(bodyText);
  if (text(gate.schemaVersion) !== ARTICLE_PUBLICATION_SEMANTIC_GATE_SCHEMA_VERSION) errors.push("semanticGate.schemaVersion 无效");
  if (computedBodySha256 !== expectedBodySha256) errors.push("当前正文实算 SHA-256 与 Article Revision bodySha256 不一致");
  if (text(gate.bodySha256).toLowerCase() !== expectedBodySha256 || text(gate.bodySha256).toLowerCase() !== computedBodySha256) errors.push("semanticGate.bodySha256 必须精确绑定当前正文实算摘要与 Article Revision bodySha256");
  const primaryThesis = rawText(gate.primaryThesis);
  const primaryThesisSha256 = text(gate.primaryThesisSha256).toLowerCase();
  const primaryThesisEvidenceQuote = rawText(gate.primaryThesisEvidenceQuote);
  const primaryThesisRegion = text(gate.primaryThesisRegion);
  if (!primaryThesis) errors.push("semanticGate.primaryThesis 必须是非空主命题文本");
  if (primaryThesis !== primaryThesis.trim()) errors.push("semanticGate.primaryThesis 不得包含首尾空白；摘要按 UTF-8 原文计算");
  if (!SHA256_RE.test(primaryThesisSha256) || primaryThesisSha256 !== await sha256Text(primaryThesis)) errors.push("semanticGate.primaryThesisSha256 必须精确绑定 primaryThesis UTF-8 原文 SHA-256");
  if (!primaryThesisEvidenceQuote || primaryThesisEvidenceQuote.length < MIN_EVIDENCE_QUOTE_CHARACTERS) errors.push("semanticGate.primaryThesisEvidenceQuote 必须是至少 8 字的精确正文引文");
  if (primaryThesisEvidenceQuote !== primaryThesisEvidenceQuote.trim()) errors.push("semanticGate.primaryThesisEvidenceQuote 不得包含首尾空白");
  if (primaryThesisEvidenceQuote !== primaryThesis) errors.push("semanticGate.primaryThesisEvidenceQuote 必须精确等于 primaryThesis 的稳定命题身份");
  const primaryThesisPosition = primaryThesisEvidenceQuote ? bodyText.indexOf(primaryThesisEvidenceQuote) : -1;
  if (primaryThesisPosition < 0) errors.push("semanticGate.primaryThesisEvidenceQuote 不在当前正文中");
  if (primaryThesisRegion !== "lead" || primaryThesisPosition >= ARTICLE_PUBLICATION_SEMANTIC_LEAD_WINDOW_CHARACTERS) errors.push(`primaryThesis 必须以 lead region 的精确引文出现在前 ${ARTICLE_PUBLICATION_SEMANTIC_LEAD_WINDOW_CHARACTERS} 字内`);
  const contract = record(gate.contract); const items = Array.isArray(contract.items) ? contract.items : [];
  const normalized = items.map((item) => record(item));
  const ids = normalized.map((item) => text(item.id));
  for (const id of ARTICLE_PUBLICATION_SEMANTIC_INVARIANT_IDS) if (ids.filter((valueId) => valueId === id).length !== 1) errors.push(`语义不变量 ${id} 必须恰好提供一次精确证据`);
  const contractSha256 = await semanticGateContractSha256(normalized, primaryThesis);
  if (text(gate.contractSha256).toLowerCase() !== contractSha256) errors.push("semanticGate.contractSha256 不匹配确定性合同");
  const evidencePositions = new Map<InvariantId, number>();
  for (const item of normalized) {
    const id = text(item.id) as InvariantId; const quote = text(item.evidenceQuote); const reference = text(item.evidenceRef); const region = text(item.region);
    if (!ARTICLE_PUBLICATION_SEMANTIC_INVARIANT_IDS.includes(id)) { errors.push(`未知语义不变量：${id || "(空)"}`); continue; }
    if (!quote || !reference || !region) { errors.push(`${id} 缺少 evidenceQuote、evidenceRef 或 region`); continue; }
    if (quote.length < MIN_EVIDENCE_QUOTE_CHARACTERS) errors.push(`${id} 的 evidenceQuote 过短，不能用词级命中冒充语义证据`);
    if (!EVIDENCE_REGIONS.has(region)) errors.push(`${id} 的 region 只能是 lead、body 或 tail`);
    const position = bodyText.indexOf(quote);
    if (position < 0) { errors.push(`${id} 的 evidenceQuote 不在当前正文中`); continue; }
    evidencePositions.set(id, position);
    if (REQUIRED_LEAD_IDS.has(id) && (region !== "lead" || position >= ARTICLE_PUBLICATION_SEMANTIC_LEAD_WINDOW_CHARACTERS)) errors.push(`${id} 必须以 lead region 的精确引文出现在前 ${ARTICLE_PUBLICATION_SEMANTIC_LEAD_WINDOW_CHARACTERS} 字内`);
  }
  const corePosition = evidencePositions.get("core_proposition");
  if (corePosition !== undefined && corePosition >= ARTICLE_PUBLICATION_SEMANTIC_LEAD_WINDOW_CHARACTERS) errors.push(`core_proposition 必须以精确引文出现在前 ${ARTICLE_PUBLICATION_SEMANTIC_LEAD_WINDOW_CHARACTERS} 字内`);
  for (const semanticId of ["core_proposition", "evidence_boundary", "responsibility_boundary"] as const) {
    const semanticPosition = evidencePositions.get(semanticId);
    if (primaryThesisPosition >= 0 && semanticPosition !== undefined && primaryThesisPosition > semanticPosition) errors.push(`primaryThesis 的正文位置不得晚于 ${semanticId}；正面主命题必须先于核心证明与边界证据`);
  }
  for (const boundaryId of ["evidence_boundary", "responsibility_boundary"] as const) {
    const boundaryPosition = evidencePositions.get(boundaryId);
    if (corePosition !== undefined && boundaryPosition !== undefined && corePosition > boundaryPosition) errors.push(`core_proposition 的正文位置不得晚于 ${boundaryId}；边界不能替代主命题`);
  }
  const coldRead = record(gate.independentReaderEvidence); const answers = record(coldRead.answers);
  if (text(coldRead.recordedBy) !== "coordinator_recorded") errors.push("independentReaderEvidence 必须明确标记 coordinator_recorded，不能声称服务端认证身份");
  if (!SHA256_RE.test(text(coldRead.snapshotSha256).toLowerCase()) || text(coldRead.snapshotSha256).toLowerCase() !== expectedBodySha256 || text(coldRead.snapshotSha256).toLowerCase() !== computedBodySha256) errors.push("independentReaderEvidence.snapshotSha256 必须精确绑定当前正文实算摘要与 Article Revision bodySha256");
  if (!text(coldRead.reviewerId) || !text(coldRead.reviewedAt)) errors.push("independentReaderEvidence 缺少 reviewerId 或 reviewedAt");
  const reviewedAt = Date.parse(text(coldRead.reviewedAt));
  if (!Number.isFinite(reviewedAt) || new Date(reviewedAt).toISOString() !== text(coldRead.reviewedAt)
    || reviewedAt > Date.now() + 5 * 60_000) errors.push("independentReaderEvidence.reviewedAt 必须是非未来的 ISO 时间");
  if (text(coldRead.verdict) !== "pass") errors.push("independentReaderEvidence verdict 必须为 pass；fail、inconclusive 或 stale 不可登记");
  for (const id of ["author_entry", "problem_origin", "first_term_explanation", "reading_route", "primary_thesis", "boundary_relation"] as const) {
    const answer = text(answers[id]);
    if (!answer) errors.push(`independentReaderEvidence 缺少 ${id} 的读者回答`);
    else if (answer.length < MIN_READER_ANSWER_CHARACTERS) errors.push(`independentReaderEvidence.${id} 回答过短，不能证明读者已形成可复述理解`);
  }
  return { valid: errors.length === 0, state: errors.length === 0 ? "passed" : "failed", errors };
}

export function semanticGateReadState(value: unknown): "passed" | "semantic_gate_missing" | "unverified" {
  if (value === undefined || value === null) return "semantic_gate_missing";
  // A stored verdict alone is never enough to claim pass: the caller has not
  // supplied the current body/hash needed for deterministic revalidation.
  return "unverified";
}
