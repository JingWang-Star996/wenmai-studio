import capabilityData from "../../../data/capabilities.generated.json";
import capabilityAuditData from "../../../data/capability-audit.example.json";
import { capabilityForOperativeRetrieval, hasOperativePath } from "../../operative-retrieval";

type IndexedCapability = {
  id: string;
  name: string;
  description: string;
  kind: string;
  dimension: string;
  stages: string[];
  availability: string;
  indexedAdoption: string;
  adoptionBasis: string;
  entryPath: string;
  root: string;
  gateInput: string[];
  gateOutput: string[];
  scripts: string[];
  pathAliases?: string[];
  materials: Array<{ id: string; label: string; locator: string; pathAliases?: string[]; kind: string; relation: string; exists: boolean | null }>;
  tags: string[];
  sourceDigest: string;
};

type AuditCapability = {
  capabilityId: string;
  name: string;
  maturity: string;
  maturityScope: string;
  owner: string | null;
  canonicalEntry: string;
  scripts: string[];
  gateContracts: Array<{ inputs: string[]; outputs: string[] }>;
  evidence: Array<{ locator: string; relation: string; result: string; freshness: string }>;
  freshness: string;
};

const index = capabilityData as unknown as {
  schemaVersion: string;
  generatedAt: string;
  capabilities: IndexedCapability[];
};
const audit = capabilityAuditData as unknown as { notice: string; capabilities: AuditCapability[] };

function pathKey(value: string) {
  return value.split("#", 1)[0].replace(/\\/g, "/").toLowerCase();
}

const auditByEntry = new Map(audit.capabilities.map((item) => [pathKey(item.canonicalEntry), item]));

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

function bounded(value: string | null, maximum: number) {
  return (value ?? "").trim().slice(0, maximum);
}

export async function GET(request: Request) {
  if (!sameOrigin(request)) return Response.json({ ok: false, error: { code: "ORIGIN_MISMATCH", message: "能力目录只接受当前工作台的同源读取" } }, { status: 403 });
  const url = new URL(request.url);
  const query = bounded(url.searchParams.get("q"), 160).toLowerCase();
  const kind = bounded(url.searchParams.get("kind"), 40);
  const stage = bounded(url.searchParams.get("stage"), 40);
  const dimension = bounded(url.searchParams.get("dimension"), 40);
  const requestedLimit = Number(url.searchParams.get("limit") ?? "30");
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.trunc(requestedLimit))) : 30;

  const capabilities = index.capabilities
    .map(capabilityForOperativeRetrieval)
    .filter((item): item is IndexedCapability & { materials: IndexedCapability["materials"] } => item !== null)
    .filter((item) => !kind || item.kind === kind)
    .filter((item) => !stage || item.stages.includes(stage))
    .filter((item) => !dimension || item.dimension === dimension)
    .filter((item) => {
      if (!query) return true;
      return [item.id, item.name, item.description, item.kind, item.dimension, ...item.stages, ...item.tags]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .slice(0, limit)
    .map((item) => {
      const auditCandidate = auditByEntry.get(pathKey(item.entryPath));
      const audited = auditCandidate && hasOperativePath({ path: auditCandidate.canonicalEntry }) ? auditCandidate : undefined;
      const contract = audited?.gateContracts[0];
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        kind: item.kind,
        dimension: item.dimension,
        stages: item.stages,
        availability: item.availability,
        adoption: audited?.maturity ?? item.indexedAdoption,
        adoptionBasis: audited ? `人工审计；${audited.maturityScope}` : item.adoptionBasis,
        maturityScope: audited?.maturityScope ?? null,
        owner: audited?.owner ?? null,
        freshness: audited?.freshness ?? null,
        canonicalEntry: audited?.canonicalEntry ?? item.entryPath,
        entryPath: item.entryPath,
        gateInput: contract?.inputs?.length ? contract.inputs : item.gateInput,
        gateOutput: contract?.outputs?.length ? contract.outputs : item.gateOutput,
        scripts: [...new Set([...(item.scripts ?? []), ...(audited?.scripts ?? [])])],
        materials: item.materials.slice(0, 30),
        evidenceRefs: audited?.evidence.map((evidence) => evidence.locator) ?? [],
        tags: item.tags,
        sourceDigest: item.sourceDigest,
      };
    });

  return Response.json({
    ok: true,
    data: {
      schemaVersion: index.schemaVersion,
      generatedAt: index.generatedAt,
      auditNotice: audit.notice,
      query: { q: query, kind, stage, dimension, limit },
      capabilities,
      boundary: {
        indexPresenceIsNotAdoption: true,
        rulesAreReferencedNotCopied: true,
        arbitraryFileReadAvailable: false,
      },
    },
  }, { headers: { "cache-control": "private, max-age=30" } });
}
