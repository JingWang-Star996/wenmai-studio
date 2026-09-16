import type { Metadata } from "next";
import corpusData from "../data/corpus.generated.json";
import capabilityData from "../data/capabilities.generated.json";
import capabilityAuditData from "../data/capability-audit.example.json";
import { createWorkbenchCorpusSeed } from "./corpus-library";
import { FACTORY_RECIPES } from "./factory-recipes";
import WorkbenchShell from "./WorkbenchShell";
import type { CorpusData } from "./types";
import type {
  CapabilityAdoption,
  CapabilityDimension,
  CapabilityIndex,
  CapabilityKind,
  CapabilityMaterial,
  CapabilityRecord,
  WorkStage,
} from "./workbench-types";

const indexedCorpus = corpusData as unknown as CorpusData;
const workbenchCorpus = createWorkbenchCorpusSeed(indexedCorpus, 12);

type AuditCapability = {
  capabilityId: string;
  name: string;
  category: string;
  creativeDimensions: string[];
  maturity: string;
  maturityScope: string;
  statusSource: string;
  owner: string | null;
  canonicalEntry: string;
  scripts: string[];
  gateContracts: Array<{ gateId: string; inputs: string[]; outputs: string[]; blockingSemantics: string; humanRequired: boolean }>;
  stages: string[];
  evidence: Array<{ relation: "explicit" | "inferred"; locator: string; result: string; freshness: string; note?: string }>;
  materials: Array<{ relation: "explicit" | "inferred"; locator: string }>;
  gaps: string[];
  freshness: string;
};

const auditSample = capabilityAuditData as unknown as { notice: string; capabilities: AuditCapability[] };

function pathKey(value: string) {
  return value.split("#", 1)[0].replace(/\\/g, "/").toLowerCase();
}

function materialFromAudit(locator: string, relation: "explicit" | "inferred", label?: string): CapabilityMaterial {
  const isUrl = /^https?:\/\//i.test(locator);
  let hash = 2166136261;
  for (const character of locator) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return {
    id: `audit-material:${(hash >>> 0).toString(16)}`,
    label: label || locator.split(/[\\/]/).at(-1) || locator,
    locator,
    kind: isUrl ? "url" : /\.(?:py|ps1|js|ts|cmd)$/i.test(locator) ? "script" : "document",
    relation,
    exists: isUrl ? null : true,
  };
}

function auditDimension(item: AuditCapability): CapabilityDimension {
  const text = [item.category, item.name, ...item.creativeDimensions].join(" ").toLowerCase();
  if (/publish|platform|发布/.test(text)) return "publishing";
  if (/delivery|package|artifact/.test(text)) return "packaging";
  if (/language|syntax|tone|中文/.test(text)) return "language";
  if (/visual|cover|color/.test(text)) return "visual";
  if (/source|evidence|receipt|authorization/.test(text)) return "evidence";
  if (/workflow|state|permission|recovery|governance/.test(text)) return "orchestration";
  if (/learning|observation|experiment|promotion/.test(text)) return "review";
  if (/research|analysis|media/.test(text)) return "research";
  return "quality";
}

function auditStages(stages: string[]): WorkStage[] {
  const mapped = stages.flatMap((stage): WorkStage[] => {
    if (/plan|discover/.test(stage)) return ["commission"];
    if (/research|observe|learn/.test(stage)) return ["research", "maintain"];
    if (/draft|revise/.test(stage)) return ["draft"];
    if (/qa|review/.test(stage)) return ["review"];
    if (/package|delivery|publish/.test(stage)) return ["distribution"];
    return [];
  });
  return [...new Set(mapped.length ? mapped : ["review"])] as WorkStage[];
}

const generatedCapabilities = capabilityData as unknown as CapabilityIndex;
const auditsByEntry = new Map(auditSample.capabilities.map((item) => [pathKey(item.canonicalEntry), item]));
const matchedAuditIds = new Set<string>();

const enrichedCapabilities: CapabilityRecord[] = generatedCapabilities.capabilities.map((capability) => {
  const audit = auditsByEntry.get(pathKey(capability.entryPath));
  if (!audit) return capability;
  matchedAuditIds.add(audit.capabilityId);
  const contract = audit.gateContracts[0];
  const auditMaterials = [
    ...audit.evidence.map((evidence) => materialFromAudit(evidence.locator, evidence.relation, evidence.result)),
    ...audit.materials.map((material) => materialFromAudit(material.locator, material.relation)),
  ];
  return {
    ...capability,
    indexedAdoption: audit.maturity as CapabilityAdoption,
    adoptionBasis: `${audit.statusSource}；${audit.maturityScope}`,
    auditId: audit.capabilityId,
    maturityScope: audit.maturityScope,
    owner: audit.owner,
    evidenceRefs: audit.evidence.map((evidence) => evidence.locator),
    freshness: audit.freshness,
    canonicalEntry: audit.canonicalEntry,
    scripts: [...new Set([...capability.scripts, ...audit.scripts])],
    gateInput: contract?.inputs.length ? contract.inputs : capability.gateInput,
    gateOutput: contract?.outputs.length ? contract.outputs : capability.gateOutput,
    materials: [...capability.materials, ...auditMaterials],
    tags: [...new Set([...capability.tags, "human-audited", ...audit.gaps.map(() => "has-gap")])],
  };
});

for (const audit of auditSample.capabilities) {
  if (matchedAuditIds.has(audit.capabilityId)) continue;
  const contract = audit.gateContracts[0];
  const kind: CapabilityKind = audit.category.includes("workflow") || audit.category.includes("governance")
    ? "workflow"
    : audit.gateContracts.length ? "gate" : "checker";
  enrichedCapabilities.push({
    id: audit.capabilityId,
    name: audit.name,
    description: audit.maturityScope,
    kind,
    dimension: auditDimension(audit),
    stages: auditStages(audit.stages),
    availability: "available",
    indexedAdoption: audit.maturity as CapabilityAdoption,
    adoptionBasis: `${audit.statusSource}；${audit.maturityScope}`,
    auditId: audit.capabilityId,
    maturityScope: audit.maturityScope,
    owner: audit.owner,
    evidenceRefs: audit.evidence.map((evidence) => evidence.locator),
    freshness: audit.freshness,
    canonicalEntry: audit.canonicalEntry,
    entryPath: audit.canonicalEntry,
    root: "人工能力审计样本",
    gateInput: contract?.inputs ?? ["按审计范围提供目标工件"],
    gateOutput: contract?.outputs ?? ["证据绑定的运行或人工决定"],
    scripts: audit.scripts,
    materials: [
      ...audit.evidence.map((evidence) => materialFromAudit(evidence.locator, evidence.relation, evidence.result)),
      ...audit.materials.map((material) => materialFromAudit(material.locator, material.relation)),
    ],
    tags: [audit.category, "human-audited"],
    sourceDigest: "manual-audit-sample",
  });
}

const kindCounts = enrichedCapabilities.reduce<Record<string, number>>((counts, capability) => {
  counts[capability.kind] = (counts[capability.kind] ?? 0) + 1;
  return counts;
}, {});

const capabilityIndex: CapabilityIndex = {
  ...generatedCapabilities,
  stats: {
    ...generatedCapabilities.stats,
    capabilities: enrichedCapabilities.length,
    skills: kindCounts.skill ?? 0,
    gates: (kindCounts.gate ?? 0) + (kindCounts.checker ?? 0),
    workflows: kindCounts.workflow ?? 0,
    templates: kindCounts.template ?? 0,
  },
  capabilities: enrichedCapabilities,
  notes: [...generatedCapabilities.notes, `人工审计层：${auditSample.notice}`],
};

export const metadata: Metadata = {
  title: "本地文章工程台",
  description: "在本地整理资料、编辑文章、保存分支与修订，并逐层核验平台适配、提交、公开页面和复盘证据。",
};

export default function Home() {
  return <WorkbenchShell corpus={workbenchCorpus} capabilities={capabilityIndex} recipes={FACTORY_RECIPES} />;
}
