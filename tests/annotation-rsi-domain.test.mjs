import assert from "node:assert/strict";
import test from "node:test";
import { RSI_DERIVED_LIMITS, advisoryProposalContext, annotationSha256, buildRsiProposalContext, decodeTupleCursor, encodeTupleCursor, requirementTransition, requireId, requireSha256, requireString, sha256Text, sourceBindingsSha256, sourceSetSha256 } from "../app/annotation-rsi.ts";

const sha = "a".repeat(64);
const cursor = { v: 1, view: "annotations", articleId: "article-1", filterSha256: sha, createdAt: "2026-09-04T00:00:00.000Z", id: "annotation-1" };
const base = { id: "annotation-1", articleId: "article-1", requirementId: "requirement-1", subjectType: "article_revision", subjectId: "revision-1", snapshotSha256: sha, labelSchemaVersion: 1, labelKind: "quality", verdict: "pass", severity: "info", note: "note", details: { source: "human" }, evidenceRefs: ["evidence-1"], supersedesAnnotationId: null, humanActorId: "human-1", createdAt: "2026-09-04T00:00:00.000Z", annotationSha256: "b".repeat(64), inputSha256: "c".repeat(64), commandId: "command-1" };
const input = () => ({ requirements: [{ id: "requirement-1", articleId: "article-1", status: "accepted", priority: "must" }], annotations: [{ ...base }], reviewedRetrospectives: [{ id: "retrospective-1" }] });

test("requirement state matrix is irreversible", () => {
  for (const from of ["draft", "accepted", "cancelled", "superseded"]) for (const to of ["draft", "accepted", "cancelled", "superseded"]) assert.equal(requirementTransition(from, to), (from === "draft" && ["accepted", "cancelled"].includes(to)) || (from === "accepted" && to === "superseded"));
});
test("validators enforce UTF-8 byte limits and lowercase digests", () => {
  assert.throws(() => requireString("中中", "text", 5), { code: "UTF8_BYTE_LIMIT_EXCEEDED" });
  assert.throws(() => requireId("bad space"), { code: "IDENTIFIER_INVALID" });
  assert.throws(() => requireSha256("A".repeat(64)), { code: "SHA256_INVALID" });
});
test("SHA-256 uses public standard vectors", async () => {
  assert.equal(await sha256Text(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(await sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
test("annotation digest is stable and all sensitive bindings affect it", async () => {
  const digest = await annotationSha256(base);
  assert.equal(digest, await annotationSha256({ ...base, details: { source: "human" } }));
  for (const changed of [{ verdict: "fail" }, { evidenceRefs: ["other"] }, { note: "other" }, { subjectId: "revision-2" }]) assert.notEqual(digest, await annotationSha256({ ...base, ...changed }));
});
test("source digest uses typed prefixes and sorted deduped IDs", async () => {
  assert.equal(await sourceSetSha256({ requirementIds: ["r2", "r1", "r1"], annotationIds: ["a1"], retrospectiveIds: ["x1"] }), await sourceSetSha256({ requirementIds: ["r1", "r2"], annotationIds: ["a1"], retrospectiveIds: ["x1"] }));
  assert.notEqual(await sourceSetSha256({ requirementIds: ["same"], annotationIds: [], retrospectiveIds: [] }), await sourceSetSha256({ requirementIds: [], annotationIds: ["same"], retrospectiveIds: [] }));
});
test("cursor roundtrips canonical payload", () => assert.deepEqual(decodeTupleCursor(encodeTupleCursor(cursor), cursor), cursor));
test("cursor rejects exact-key violations and every binding mismatch", () => {
  const encoded = encodeTupleCursor(cursor);
  for (const binding of [{ ...cursor, view: "requirements" }, { ...cursor, articleId: "other" }, { ...cursor, filterSha256: "b".repeat(64) }]) assert.throws(() => decodeTupleCursor(encoded, binding));
  const extra = btoa(JSON.stringify({ ...cursor, extra: true })).replace(/=+$/u, "");
  assert.throws(() => decodeTupleCursor(extra, cursor), { code: "CURSOR_KEYS_INVALID" });
  assert.throws(() => decodeTupleCursor("not-a-cursor", cursor));
});
test("current active annotation excludes a row superseded by another row", async () => {
  const result = await advisoryProposalContext({ ...input(), annotations: [{ ...base, id: "old" }, { ...base, id: "new", supersedesAnnotationId: "old" }] });
  assert.deepEqual(result.sourceAnnotationIds, ["new"]);
});
test("proposal context exposes each mandated blocker", async () => {
  const codes = async (value) => (await advisoryProposalContext(value)).blockers.map((blocker) => blocker.code);
  assert((await codes({})).includes("NO_ACCEPTED_REQUIREMENT"));
  assert((await codes({ requirements: [{ id: "r", status: "accepted" }] })).includes("NO_ACTIVE_HUMAN_ANNOTATION"));
  assert((await codes({ requirements: [{ id: "r", status: "accepted" }], annotations: [{ ...base, requirementId: "r", snapshotSha256: "bad" }], reviewedRetrospectives: [{ id: "x" }] })).includes("ANNOTATION_EVIDENCE_INCOMPLETE"));
  assert((await codes({ requirements: [{ id: "r", status: "accepted" }], annotations: [{ ...base }], sourceSetSha256: sha })).includes("NO_REVIEWED_RETROSPECTIVE"));
  assert((await codes({ ...input(), sourceSetSha256: "b".repeat(64) })).includes("SOURCE_DIGEST_STALE"));
});
test("eligible positive case remains advisory and never leaks body text", async () => {
  const result = await advisoryProposalContext({ ...input(), bodyText: "secret body" });
  assert.equal(result.eligibleForRuleCandidate, true);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.bodyTextIncluded, false);
  assert.equal(result.autoCreateExperiment, false);
  assert.equal(result.autoAdopt, false);
  assert.equal(JSON.stringify(result).includes("secret body"), false);
  assert.deepEqual(result.items, []);
});

const task = (id, state, finishedAt = null) => ({ id, state, createdAt: "2026-09-01T00:00:00.000Z", finishedAt, currentContextSnapshotId: `context-${id}`, contextSha256: "d".repeat(64), requirementIds: ["requirement-1"], annotationIds: ["annotation-1"], progressEvents: [{ id: `event-${id}`, eventType: "progress", inputSha256: "e".repeat(64), createdAt: "2026-09-01T01:00:00.000Z" }] });
const retro = (evidenceRefs = ["task:task-1", "annotation:annotation-1"]) => ({ id: "retro-1", articleId: "article-1", projectId: "project-1", releaseId: "release-1", title: "Private title", summary: "Private summary", state: "closed", evidenceRefs, lockVersion: 1, updatedAt: "2026-09-03T00:00:00.000Z", contentSha256: "f".repeat(64) });
const requirement = (id, inputSha256 = "a".repeat(64), lockVersion = 1) => ({ id, articleId: "article-1", status: "accepted", priority: "must", createdAt: "2026-09-01T00:00:00.000Z", acceptedAt: "2026-09-01T00:00:00.000Z", inputSha256, lockVersion });
const domainInput = () => ({ asOf: "2026-09-04T12:00:00.000Z", tasks: [task("task-1", "succeeded", "2026-09-02T00:00:00.000Z"), task("task-new", "queued"), task("task-review", "review", "2026-09-03T01:00:00.000Z")], acceptedRequirements: [requirement("requirement-1"), requirement("requirement-due", "9".repeat(64))], activeAnnotations: [{ ...base }], reviewedOrClosedRetrospectives: [retro()], externalObservations: [{ id: "external-1", observedAt: "2026-09-03T00:00:00.000Z", officialFact: "Vendor changed model policy.", inferredImpact: "Local review may be needed.", humanReviewed: true, evidenceRefs: ["external-source-1"], canonicalSource: "vendor", sourceVersion: "v2", publishedAt: "2026-09-03T00:00:00.000Z", contentSha256: "1".repeat(64), eventInputSha256: "2".repeat(64) }], existingRuleCandidates: [] });
test("pure RSI projection covers four triggers and keeps review non-terminal", async () => {
  const value = domainInput(); const before = structuredClone(value); const result = await buildRsiProposalContext(value);
  assert.deepEqual(value, before);
  assert.deepEqual(result.items.map((item) => item.triggerKind), ["external_ai_change", "new_task", "new_task", "review_due", "task_terminal"]);
  assert.equal(result.items.some((item) => item.triggerKey === "task-review" && item.triggerKind === "task_terminal"), false);
  assert.equal(result.items.some((item) => item.triggerKey === "task-review" && item.triggerKind === "new_task"), true);
  assert(result.items.find((item) => item.triggerKind === "external_ai_change").officialFact);
});
test("due timing, binding, candidate block and deterministic IDs are controlled by input", async () => {
  const early = domainInput(); early.asOf = "2026-09-01T12:00:00.000Z";
  assert.equal((await buildRsiProposalContext(early)).items.some((item) => item.triggerKind === "review_due"), false);
  const result = await buildRsiProposalContext(domainInput()); const terminal = result.items.find((item) => item.triggerKind === "task_terminal");
  assert.equal(terminal.blockers.some((item) => item.code === "NO_BOUND_REVIEWED_RETROSPECTIVE"), false);
  const unbound = domainInput(); unbound.reviewedOrClosedRetrospectives[0].evidenceRefs = ["unrelated"];
  assert((await buildRsiProposalContext(unbound)).items.find((item) => item.triggerKind === "task_terminal").blockers.some((item) => item.code === "NO_BOUND_REVIEWED_RETROSPECTIVE"));
  const candidate = domainInput(); candidate.existingRuleCandidates = [{ id: "candidate-1", sourceDigest: terminal.sourceDigest }];
  const blocked = (await buildRsiProposalContext(candidate)).items.find((item) => item.triggerKind === "task_terminal");
  assert.equal(blocked.eligibleForRuleCandidate, false); assert(blocked.blockers.some((item) => item.code === "ALREADY_HAS_RULE_CANDIDATE"));
  assert.equal(terminal.proposalId, (await buildRsiProposalContext(domainInput())).items.find((item) => item.triggerKind === "task_terminal").proposalId);
});
test("adding an active annotation removes the requirement review-due proposal", async () => {
  const value = domainInput();
  value.activeAnnotations.push({ ...base, id: "annotation-due", requirementId: "requirement-due" });
  assert.equal((await buildRsiProposalContext(value)).items.some((item) => item.triggerKey === "requirement:requirement-due"), false);
});
test("terminal is immediate, task review due disappears after an exact binding", async () => {
  const now = domainInput(); now.asOf = "2026-09-02T00:01:00.000Z";
  const immediate = await buildRsiProposalContext(now);
  assert(immediate.items.some((item) => item.triggerKind === "task_terminal"));
  assert.equal(immediate.items.some((item) => item.triggerKey === "task-retrospective:task-1"), false);
  const overdue = domainInput(); overdue.reviewedOrClosedRetrospectives = [retro(["unrelated"])];
  assert((await buildRsiProposalContext(overdue)).items.some((item) => item.triggerKey === "task-retrospective:task-1"));
  assert.equal((await buildRsiProposalContext(domainInput())).items.some((item) => item.triggerKey === "task-retrospective:task-1"), false);
});
test("all real active task states produce new-task while only real terminals produce terminal", async () => {
  const value = domainInput();
  value.tasks = ["draft", "queued", "claimed", "running", "awaiting_human", "blocked", "review"].map((state) => task(`active-${state}`, state)).concat(["succeeded", "failed", "cancelled"].map((state) => task(`terminal-${state}`, state, "2026-09-04T11:59:00.000Z")));
  const result = await buildRsiProposalContext(value);
  assert.equal(result.items.filter((item) => item.triggerKind === "new_task").length, 7);
  assert.deepEqual(result.items.filter((item) => item.triggerKind === "task_terminal").map((item) => item.triggerKey).sort(), ["terminal-cancelled", "terminal-failed", "terminal-succeeded"]);
});
test("content bindings, stale propagation and time-stable IDs are deterministic", async () => {
  const original = await buildRsiProposalContext(domainInput());
  const changed = domainInput(); changed.acceptedRequirements[0].inputSha256 = "3".repeat(64);
  assert.notEqual(original.sourceSetSha256, (await buildRsiProposalContext(changed)).sourceSetSha256);
  const annotationChanged = domainInput(); annotationChanged.activeAnnotations[0].annotationSha256 = "4".repeat(64);
  assert.notEqual(original.sourceSetSha256, (await buildRsiProposalContext(annotationChanged)).sourceSetSha256);
  const retroChanged = domainInput(); retroChanged.reviewedOrClosedRetrospectives[0].lockVersion = 2;
  assert.notEqual(original.sourceSetSha256, (await buildRsiProposalContext(retroChanged)).sourceSetSha256);
  const stale = domainInput(); stale.requestedSourceSetSha256 = "5".repeat(64); const staleResult = await buildRsiProposalContext(stale);
  assert(staleResult.blockers.some((blocker) => blocker.code === "SOURCE_DIGEST_STALE")); assert(staleResult.items.every((item) => !item.eligibleForRuleCandidate && item.blockers.some((blocker) => blocker.code === "SOURCE_DIGEST_STALE")));
  const later = domainInput(); later.asOf = "2026-09-05T12:00:00.000Z";
  assert.equal(original.items.find((item) => item.triggerKind === "task_terminal").proposalId, (await buildRsiProposalContext(later)).items.find((item) => item.triggerKind === "task_terminal").proposalId);
});
test("task and external facts bind top-level digest while related facts bind item digest", async () => {
  const baseline = await buildRsiProposalContext(domainInput());
  const taskChanged = domainInput(); taskChanged.tasks[0].progressEvents[0].inputSha256 = "6".repeat(64);
  assert.notEqual(baseline.sourceSetSha256, (await buildRsiProposalContext(taskChanged)).sourceSetSha256);
  const externalChanged = domainInput(); externalChanged.externalObservations[0].contentSha256 = "7".repeat(64);
  assert.notEqual(baseline.sourceSetSha256, (await buildRsiProposalContext(externalChanged)).sourceSetSha256);
  const annotationChanged = domainInput(); annotationChanged.activeAnnotations[0].annotationSha256 = "8".repeat(64);
  assert.notEqual(baseline.items.find((item) => item.triggerKind === "task_terminal").sourceDigest, (await buildRsiProposalContext(annotationChanged)).items.find((item) => item.triggerKind === "task_terminal").sourceDigest);
  const retroChanged = domainInput(); retroChanged.reviewedOrClosedRetrospectives[0].lockVersion = 2;
  assert.notEqual(baseline.items.find((item) => item.triggerKind === "task_terminal").sourceDigest, (await buildRsiProposalContext(retroChanged)).items.find((item) => item.triggerKind === "task_terminal").sourceDigest);
});
test("null context remains advisory, nullable release works, and conflicting bindings fail closed", async () => {
  const value = domainInput(); value.tasks[1].currentContextSnapshotId = null; value.tasks[1].contextSha256 = null; value.reviewedOrClosedRetrospectives[0].releaseId = null;
  const result = await buildRsiProposalContext(value); const item = result.items.find((candidate) => candidate.triggerKey === "task-new");
  assert(item); assert(item.blockers.some((blocker) => blocker.code === "CONTEXT_SNAPSHOT_MISSING")); assert.equal(item.sourceRefs.includes("context:null"), false);
  await assert.rejects(sourceBindingsSha256([{ kind: "task", id: "same", sha256: "a".repeat(64) }, { kind: "task", id: "same", sha256: "b".repeat(64) }]), { code: "SOURCE_BINDING_CONFLICT" });
});
test("external fact can be eligible with relevant annotation and exact retrospective evidence", async () => {
  const value = domainInput(); value.externalObservations[0].evidenceRefs = ["requirement:requirement-1"]; value.reviewedOrClosedRetrospectives[0].evidenceRefs = ["external:external-1"];
  const external = (await buildRsiProposalContext(value)).items.find((item) => item.triggerKind === "external_ai_change");
  assert.equal(external.eligibleForRuleCandidate, true);
  for (const ref of ["external:external-1", "requirement:requirement-1", "annotation:annotation-1", "retrospective:retro-1"]) assert(external.sourceRefs.includes(ref));
});
test("external facts bind only explicitly referenced requirements and annotations", async () => {
  const unbound = (await buildRsiProposalContext(domainInput())).items.find((item) => item.triggerKind === "external_ai_change");
  assert.equal(unbound.sourceRefs.includes("requirement:requirement-1"), false);
  assert.equal(unbound.sourceRefs.includes("annotation:annotation-1"), false);
  const linked = domainInput(); linked.externalObservations[0].evidenceRefs = ["annotation:annotation-1"];
  const external = (await buildRsiProposalContext(linked)).items.find((item) => item.triggerKind === "external_ai_change");
  assert(external.sourceRefs.includes("requirement:requirement-1"));
  assert(external.sourceRefs.includes("annotation:annotation-1"));
});
test("derived proposal budget succeeds at the source-ref boundary and fails closed above it", async () => {
  const value = domainInput(); value.acceptedRequirements = []; value.activeAnnotations = []; value.reviewedOrClosedRetrospectives = []; value.externalObservations = [];
  const minimal = (id) => ({ id, state: "queued", createdAt: "2026-09-01T00:00:00.000Z", finishedAt: null, currentContextSnapshotId: null, contextSha256: null, requirementIds: [], annotationIds: [], progressEvents: [] });
  value.tasks = Array.from({ length: 32 }, (_, index) => minimal(`budget-${index}`));
  const atBoundary = await buildRsiProposalContext(value);
  assert.equal(atBoundary.items.length, RSI_DERIVED_LIMITS.items);
  value.tasks.push(minimal("budget-overflow"));
  await assert.rejects(() => buildRsiProposalContext(value), (error) => error?.code === "RSI_CONTEXT_LIMIT_EXCEEDED");
});
test("item refs expose every digest-binding source alongside caller evidence", async () => {
  const terminal = (await buildRsiProposalContext(domainInput())).items.find((item) => item.triggerKind === "task_terminal");
  for (const ref of ["task:task-1", "requirement:requirement-1", "annotation:annotation-1", "retrospective:retro-1", "event:event-task-1"]) assert(terminal.sourceRefs.includes(ref));
  assert(terminal.sourceRefs.includes("context:context-task-1"));
});
test("DTO envelope contract keeps pagination nested", () => {
  const envelope = { items: [], bodyTextIncluded: false, page: { limit: 10, nextCursor: null } };
  assert.deepEqual(Object.keys(envelope).sort(), ["bodyTextIncluded", "items", "page"]);
});
