import { sql } from "drizzle-orm";
import { check, foreignKey, integer, sqliteTable, text, uniqueIndex, index, primaryKey } from "drizzle-orm/sqlite-core";

export const editorialItems = sqliteTable(
  "editorial_items",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["topic", "series"] }).notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("候选"),
    summary: text("summary").notNull().default(""),
    rationale: text("rationale").notNull().default(""),
    confidence: text("confidence").notNull().default("中"),
    linkedArticleIds: text("linked_article_ids").notNull().default("[]"),
    nextAction: text("next_action").notNull().default(""),
    sourceOpportunityId: text("source_opportunity_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_editorial_items_kind_status").on(table.kind, table.status),
    uniqueIndex("idx_editorial_items_source_opportunity").on(table.sourceOpportunityId),
  ],
);

export const articleOverrides = sqliteTable(
  "article_overrides",
  {
    articleId: text("article_id").primaryKey(),
    editorialState: text("editorial_state").notNull().default("inbox"),
    gateState: text("gate_state").notNull().default("not_run"),
    evidenceHealth: text("evidence_health").notNull().default("unknown"),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    notes: text("notes").notNull().default(""),
    seriesId: text("series_id"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_article_overrides_editorial_state").on(table.editorialState)],
);

export const decisionEvents = sqliteTable(
  "decision_events",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type", { enum: ["article", "opportunity", "identity"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    decisionType: text("decision_type").notNull(),
    valueJson: text("value_json").notNull().default("{}"),
    notes: text("notes").notNull().default(""),
    ruleVersion: text("rule_version").notNull(),
    inputSha256: text("input_sha256").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_decision_events_subject").on(table.subjectType, table.subjectId, table.createdAt),
  ],
);

export const articleBranches = sqliteTable(
  "article_branches",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    color: text("color").notNull().default("blue"),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    headRevisionId: text("head_revision_id").notNull(),
    baseRevisionId: text("base_revision_id").notNull(),
    baseSourceVersionId: text("base_source_version_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_article_branches_article_slug").on(table.articleId, table.slug),
    index("idx_article_branches_article_status").on(table.articleId, table.status),
  ],
);

export const articleRevisions = sqliteTable(
  "article_revisions",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id").notNull(),
    branchId: text("branch_id").notNull(),
    sequence: integer("sequence").notNull(),
    parentRevisionId: text("parent_revision_id"),
    mergeParentRevisionId: text("merge_parent_revision_id"),
    sourceVersionId: text("source_version_id"),
    title: text("title").notNull(),
    documentTitle: text("document_title").notNull(),
    annotation: text("annotation").notNull().default(""),
    bodyText: text("body_text").notNull(),
    bodySha256: text("body_sha256").notNull(),
    authorKind: text("author_kind", { enum: ["user", "agent", "import"] }).notNull().default("user"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_article_revisions_branch_sequence").on(table.branchId, table.sequence),
    index("idx_article_revisions_article_created").on(table.articleId, table.createdAt),
    index("idx_article_revisions_branch_created").on(table.branchId, table.createdAt),
  ],
);

export const branchWorkingCopies = sqliteTable(
  "branch_working_copies",
  {
    branchId: text("branch_id").primaryKey(),
    articleId: text("article_id").notNull(),
    baseRevisionId: text("base_revision_id").notNull(),
    title: text("title").notNull(),
    annotation: text("annotation").notNull().default(""),
    bodyText: text("body_text").notNull(),
    bodySha256: text("body_sha256").notNull(),
    dirty: integer("dirty", { mode: "boolean" }).notNull().default(false),
    lockVersion: integer("lock_version").notNull().default(1),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_branch_working_copies_article").on(table.articleId, table.updatedAt)],
);

export const workItems = sqliteTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id"),
    branchId: text("branch_id"),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("article"),
    stage: text("stage").notNull().default("inbox"),
    state: text("state", { enum: ["open", "blocked", "done", "cancelled"] }).notNull().default("open"),
    priority: text("priority", { enum: ["P0", "P1", "P2", "P3"] }).notNull().default("P2"),
    owner: text("owner").notNull().default("我"),
    nextAction: text("next_action").notNull().default(""),
    blocker: text("blocker").notNull().default(""),
    sourceCapabilityId: text("source_capability_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_work_items_stage_state_order").on(table.stage, table.state, table.sortOrder),
    index("idx_work_items_article_updated").on(table.articleId, table.updatedAt),
  ],
);

export const gateRuns = sqliteTable(
  "gate_runs",
  {
    id: text("id").primaryKey(),
    runGroupId: text("run_group_id").notNull(),
    articleId: text("article_id").notNull(),
    branchId: text("branch_id").notNull(),
    revisionId: text("revision_id"),
    gateId: text("gate_id").notNull(),
    gateLabel: text("gate_label").notNull(),
    result: text("result", { enum: ["pass", "fail", "inconclusive"] }).notNull(),
    inputSha256: text("input_sha256").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    detailsJson: text("details_json").notNull().default("{}"),
    startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_gate_runs_article_completed").on(table.articleId, table.completedAt),
    index("idx_gate_runs_branch_completed").on(table.branchId, table.completedAt),
    index("idx_gate_runs_group").on(table.runGroupId),
  ],
);

export const capabilityOverrides = sqliteTable(
  "capability_overrides",
  {
    capabilityId: text("capability_id").primaryKey(),
    adoptionStatus: text("adoption_status", { enum: ["unassessed", "candidate", "tested", "verified", "adopted", "deferred", "rejected"] })
      .notNull()
      .default("unassessed"),
    notes: text("notes").notNull().default(""),
    evidenceRef: text("evidence_ref").notNull().default(""),
    regressionRef: text("regression_ref").notNull().default(""),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

export const productionRuns = sqliteTable(
  "production_runs",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id").notNull(),
    recipeVersion: text("recipe_version").notNull().default("1.0.0"),
    recipeSha256: text("recipe_sha256").notNull().default(""),
    articleId: text("article_id").notNull(),
    branchId: text("branch_id").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: ["planned", "active", "paused", "complete", "cancelled"] }).notNull().default("planned"),
    currentStepId: text("current_step_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_production_runs_article_status").on(table.articleId, table.status)],
);

export const productionRunSteps = sqliteTable(
  "production_run_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    stepId: text("step_id").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    actorKind: text("actor_kind").notNull(),
    agentRole: text("agent_role"),
    dependsOnJson: text("depends_on_json").notNull().default("[]"),
    writeScope: text("write_scope").notNull().default("none"),
    runnerAction: text("runner_action"),
    capabilityId: text("capability_id"),
    gateId: text("gate_id"),
    status: text("status", { enum: ["pending", "active", "blocked", "complete", "skipped"] }).notNull().default("pending"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_production_run_steps_run_step").on(table.runId, table.stepId),
    index("idx_production_run_steps_run_position").on(table.runId, table.position),
  ],
);

export const workspaceEvents = sqliteTable(
  "workspace_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    articleId: text("article_id"),
    payloadJson: text("payload_json").notNull().default("{}"),
    inputSha256: text("input_sha256").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_workspace_events_article_created").on(table.articleId, table.createdAt),
    index("idx_workspace_events_subject_created").on(table.subjectType, table.subjectId, table.createdAt),
  ],
);

export const runnerRegistry = sqliteTable(
  "runner_registry",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    tokenSha256: text("token_sha256").notNull(),
    capabilitiesJson: text("capabilities_json").notNull().default("[]"),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    revokedAt: text("revoked_at"),
  },
  (table) => [index("idx_runner_registry_status_seen").on(table.status, table.lastSeenAt)],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    productionRunId: text("production_run_id").notNull(),
    productionStepId: text("production_step_id").notNull(),
    recipeId: text("recipe_id").notNull(),
    recipeVersion: text("recipe_version").notNull(),
    recipeSha256: text("recipe_sha256").notNull(),
    articleId: text("article_id").notNull(),
    branchId: text("branch_id").notNull(),
    frozenRevisionId: text("frozen_revision_id").notNull(),
    frozenTitle: text("frozen_title").notNull().default(""),
    inputSha256: text("input_sha256").notNull(),
    permissionSnapshotJson: text("permission_snapshot_json").notNull().default("{}"),
    state: text("state", { enum: ["queued", "running", "awaiting_human", "partial", "succeeded", "failed", "cancelled"] }).notNull().default("queued"),
    requestedBy: text("requested_by").notNull().default("user"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    lastHeartbeatAt: text("last_heartbeat_at"),
  },
  (table) => [
    index("idx_agent_runs_article_state").on(table.articleId, table.state, table.createdAt),
    index("idx_agent_runs_production_step").on(table.productionRunId, table.productionStepId),
    uniqueIndex("idx_agent_runs_active_production_step")
      .on(table.productionRunId, table.productionStepId)
      .where(sql`${table.state} IN ('queued', 'running')`),
  ],
);

export const agentSteps = sqliteTable(
  "agent_steps",
  {
    id: text("id").primaryKey(),
    agentRunId: text("agent_run_id").notNull(),
    recipeStepId: text("recipe_step_id").notNull(),
    attempt: integer("attempt").notNull().default(1),
    runnerAction: text("runner_action").notNull(),
    agentRole: text("agent_role"),
    state: text("state", { enum: ["queued", "leased", "running", "succeeded", "failed", "cancelled"] }).notNull().default("queued"),
    assignedRunnerId: text("assigned_runner_id"),
    leaseId: text("lease_id"),
    terminalCommandId: text("terminal_command_id"),
    inputJson: text("input_json").notNull(),
    inputSha256: text("input_sha256").notNull(),
    outputSha256: text("output_sha256"),
    errorClass: text("error_class"),
    errorSummary: text("error_summary"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_agent_steps_run_step_attempt").on(table.agentRunId, table.recipeStepId, table.attempt),
    index("idx_agent_steps_state_action").on(table.state, table.runnerAction, table.createdAt),
  ],
);

export const agentArtifacts = sqliteTable(
  "agent_artifacts",
  {
    id: text("id").primaryKey(),
    agentStepId: text("agent_step_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    contentRef: text("content_ref").notNull(),
    sha256: text("sha256").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_agent_artifacts_step_created").on(table.agentStepId, table.createdAt),
    uniqueIndex("idx_agent_artifacts_step_kind_sha").on(table.agentStepId, table.kind, table.sha256),
  ],
);

export const runnerLeases = sqliteTable(
  "runner_leases",
  {
    id: text("id").primaryKey(),
    agentStepId: text("agent_step_id").notNull(),
    runnerId: text("runner_id").notNull(),
    leaseTokenSha256: text("lease_token_sha256").notNull(),
    leasedAt: text("leased_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
    heartbeatSeq: integer("heartbeat_seq").notNull().default(0),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("idx_runner_leases_step_active").on(table.agentStepId, table.revokedAt),
    index("idx_runner_leases_expiry").on(table.expiresAt, table.revokedAt),
  ],
);

export const commandReceipts = sqliteTable(
  "command_receipts",
  {
    id: text("id").primaryKey(),
    commandType: text("command_type").notNull(),
    actorId: text("actor_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    responseJson: text("response_json").notNull().default("{}"),
    statusCode: integer("status_code").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [index("idx_command_receipts_actor_created").on(table.actorId, table.createdAt)],
);

export const publishCapabilityReceipts = sqliteTable(
  "publish_capability_receipts",
  {
    commandId: text("command_id").primaryKey(),
    commandType: text("command_type").notNull(),
    actorId: text("actor_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    responseJson: text("response_json").notNull().default("{}"),
    statusCode: integer("status_code").notNull().default(0),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    check("publish_capability_receipts_type_check", sql`${table.commandType} IN ('publish-capability.issue','publish-capability.consume')`),
    index("idx_publish_capability_receipts_actor_created").on(table.actorId, table.createdAt),
  ],
);

export const publishCapabilities = sqliteTable(
  "publish_capabilities",
  {
    id: text("id").primaryKey(), schemaVersion: text("schema_version").notNull(),
    issueCommandId: text("issue_command_id").notNull().unique(), issueRequestSha256: text("issue_request_sha256").notNull(),
    executionPacketSha256: text("execution_packet_sha256").notNull().unique(), nonceSha256: text("nonce_sha256").notNull().unique(),
    ticketSha256: text("ticket_sha256").notNull(), packetJsonSha256: text("packet_json_sha256").notNull(), confirmationSha256: text("confirmation_sha256").notNull(),
    packetJson: text("packet_json").notNull(), ticketJson: text("ticket_json").notNull(), confirmationJson: text("confirmation_json").notNull(),
    runId: text("run_id").notNull(), articleId: text("article_id"), attempt: integer("attempt").notNull(), packetCommandId: text("packet_command_id").notNull(),
    contractRevision: integer("contract_revision").notNull(), contractSha256: text("contract_sha256").notNull(), platform: text("platform").notNull(),
    releaseId: text("release_id").notNull(), buildId: text("build_id").notNull(), artifactSha256: text("artifact_sha256").notNull(), targetAccount: text("target_account").notNull(),
    action: text("action").notNull(), maxClicks: integer("max_clicks").notNull(), issuerActorId: text("issuer_actor_id").notNull(), issuerPrincipalId: text("issuer_principal_id").notNull(),
    status: text("status").notNull().default("issued"), issuedAt: text("issued_at").notNull(), expiresAt: text("expires_at").notNull(), consumedAt: text("consumed_at"), createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("publish_capabilities_action_check", sql`${table.action} = 'publish'`),
    check("publish_capabilities_max_clicks_check", sql`${table.maxClicks} = 1`),
    check("publish_capabilities_status_check", sql`${table.status} IN ('issued','consumed')`),
    index("idx_publish_capabilities_status_expiry").on(table.status, table.expiresAt),
    index("idx_publish_capabilities_release").on(table.runId, table.platform, table.releaseId, table.buildId),
    index("idx_publish_capabilities_article_status_expiry").on(table.articleId, table.status, table.expiresAt),
  ],
);

export const publishCapabilityConsumptions = sqliteTable(
  "publish_capability_consumptions",
  {
    id: text("id").primaryKey(), capabilityId: text("capability_id").notNull().unique(), nonceSha256: text("nonce_sha256").notNull().unique(),
    consumerActorId: text("consumer_actor_id").notNull(), consumerClientId: text("consumer_client_id").notNull(), commandId: text("command_id").notNull().unique(),
    requestSha256: text("request_sha256").notNull(), consumedAt: text("consumed_at").notNull(),
  },
  (table) => [index("idx_publish_capability_consumptions_consumer").on(table.consumerClientId, table.consumedAt)],
);

export const mergeProposals = sqliteTable(
  "merge_proposals",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id").notNull().unique(),
    articleId: text("article_id").notNull(),
    sourceBranchId: text("source_branch_id").notNull(),
    targetBranchId: text("target_branch_id").notNull(),
    baseRevisionId: text("base_revision_id").notNull(),
    sourceHeadRevisionId: text("source_head_revision_id").notNull(),
    targetHeadRevisionId: text("target_head_revision_id").notNull(),
    baseSha256: text("base_sha256").notNull(),
    sourceHeadSha256: text("source_head_sha256").notNull(),
    targetHeadSha256: text("target_head_sha256").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    previewJson: text("preview_json").notNull().default("{}"),
    previewSha256: text("preview_sha256").notNull(),
    resolvedDocumentTitle: text("resolved_document_title").notNull().default(""),
    resolvedBodyText: text("resolved_body_text").notNull().default(""),
    resolvedBodySha256: text("resolved_body_sha256").notNull().default(""),
    resolutionJson: text("resolution_json").notNull().default("{}"),
    resolutionNote: text("resolution_note").notNull().default(""),
    unresolvedCount: integer("unresolved_count").notNull().default(0),
    status: text("status", { enum: ["prepared", "resolving", "ready", "stale", "merged", "cancelled"] }).notNull().default("prepared"),
    lockVersion: integer("lock_version").notNull().default(1),
    mergeRevisionId: text("merge_revision_id"),
    prepareActorId: text("prepare_actor_id"),
    resolutionActorId: text("resolution_actor_id"),
    applyActorId: text("apply_actor_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_merge_proposals_article_status").on(table.articleId, table.status, table.updatedAt),
    index("idx_merge_proposals_target_status").on(table.targetBranchId, table.status, table.updatedAt),
    uniqueIndex("idx_merge_proposals_active_heads")
      .on(table.sourceBranchId, table.targetBranchId, table.sourceHeadRevisionId, table.targetHeadRevisionId)
      .where(sql`${table.status} IN ('prepared','resolving','ready')`),
    uniqueIndex("idx_merge_proposals_revision").on(table.mergeRevisionId).where(sql`${table.mergeRevisionId} IS NOT NULL`),
  ],
);

export const lifecycleArticleProjects = sqliteTable(
  "lifecycle_article_projects",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id").notNull().unique(),
    title: text("title").notNull(),
    intent: text("intent").notNull().default(""),
    owner: text("owner").notNull().default("我"),
    phase: text("phase", { enum: ["pitch", "planning", "production", "packaging", "release", "operate", "retrospective"] }).notNull().default("pitch"),
    executionState: text("execution_state", { enum: ["proposed", "active", "blocked", "paused", "completed", "cancelled"] }).notNull().default("proposed"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("lifecycle_projects_phase_check", sql`${table.phase} IN ('pitch','planning','production','packaging','release','operate','retrospective')`),
    check("lifecycle_projects_execution_check", sql`${table.executionState} IN ('proposed','active','blocked','paused','completed','cancelled')`),
    index("idx_lifecycle_projects_article_state").on(table.articleId, table.executionState, table.updatedAt),
    uniqueIndex("idx_lifecycle_article_projects_id_article").on(table.id, table.articleId),
  ],
);

export const lifecyclePlatformTargets = sqliteTable(
  "lifecycle_platform_targets",
  {
    id: text("id").primaryKey(),
    profileKey: text("profile_key").notNull(),
    platform: text("platform").notNull(),
    label: text("label").notNull(),
    version: text("version").notNull(),
    connectionMode: text("connection_mode", { enum: ["manual"] }).notNull().default("manual"),
    status: text("status", { enum: ["active", "superseded"] }).notNull().default("active"),
    profileJson: text("profile_json").notNull().default("{}"),
    profileSha256: text("profile_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("lifecycle_targets_connection_check", sql`${table.connectionMode} = 'manual'`),
    check("lifecycle_targets_status_check", sql`${table.status} IN ('active','superseded')`),
    uniqueIndex("lifecycle_platform_targets_profile_key_version_unique").on(table.profileKey, table.version),
    uniqueIndex("idx_lifecycle_targets_active_key").on(table.profileKey).where(sql`${table.status} = 'active'`),
  ],
);

export const lifecycleAdaptationContracts = sqliteTable(
  "lifecycle_adaptation_contracts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    articleId: text("article_id").notNull(),
    targetProfileId: text("target_profile_id").notNull(),
    targetProfileSha256: text("target_profile_sha256").notNull(),
    sourceRevisionId: text("source_revision_id").notNull(),
    sourceBodySha256: text("source_body_sha256").notNull(),
    sliceKind: text("slice_kind", { enum: ["full", "demo", "excerpt", "promo"] }).notNull(),
    title: text("title").notNull(),
    invariantsJson: text("invariants_json").notNull().default("{}"),
    rulesJson: text("rules_json").notNull().default("{}"),
    contractSha256: text("contract_sha256").notNull(),
    status: text("status", { enum: ["draft", "approved", "superseded", "cancelled"] }).notNull().default("draft"),
    approvalNote: text("approval_note").notNull().default(""),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("lifecycle_contracts_slice_check", sql`${table.sliceKind} IN ('full','demo','excerpt','promo')`),
    check("lifecycle_contracts_status_check", sql`${table.status} IN ('draft','approved','superseded','cancelled')`),
    index("idx_lifecycle_contracts_article_status").on(table.articleId, table.status, table.updatedAt),
  ],
);

export const lifecycleBuilds = sqliteTable(
  "lifecycle_builds",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    articleId: text("article_id").notNull(),
    branchId: text("branch_id").notNull(),
    revisionId: text("revision_id").notNull(),
    sourceTitle: text("source_title").notNull(),
    sourceBodySha256: text("source_body_sha256").notNull(),
    targetProfileId: text("target_profile_id").notNull(),
    targetProfileSha256: text("target_profile_sha256").notNull(),
    adaptationContractId: text("adaptation_contract_id").notNull(),
    contractSha256: text("contract_sha256").notNull(),
    sliceKind: text("slice_kind", { enum: ["full", "demo", "excerpt", "promo"] }).notNull(),
    state: text("state", { enum: ["planned", "built", "failed", "superseded"] }).notNull().default("planned"),
    artifactRef: text("artifact_ref").notNull().default(""),
    artifactSha256: text("artifact_sha256").notNull().default(""),
    artifactMediaType: text("artifact_media_type").notNull().default(""),
    artifactManifestJson: text("artifact_manifest_json").notNull().default("{}"),
    failureSummary: text("failure_summary").notNull().default(""),
    createdAt: text("created_at").notNull(),
    builtAt: text("built_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("lifecycle_builds_slice_check", sql`${table.sliceKind} IN ('full','demo','excerpt','promo')`),
    check("lifecycle_builds_state_check", sql`${table.state} IN ('planned','built','failed','superseded')`),
    index("idx_lifecycle_builds_article_state").on(table.articleId, table.state, table.updatedAt),
  ],
);

export const lifecycleBuildInputBindings = sqliteTable(
  "lifecycle_build_input_bindings",
  {
    buildId: text("build_id").primaryKey(),
    inputBindingSha256: text("input_binding_sha256").notNull(),
    packageId: text("package_id").notNull(),
    branchId: text("branch_id").notNull(),
    branchLockVersion: integer("branch_lock_version").notNull(),
    revisionId: text("revision_id").notNull(),
    sourceBodySha256: text("source_body_sha256").notNull(),
    compositionId: text("composition_id").notNull(),
    compositionSha256: text("composition_sha256").notNull(),
    sliceId: text("slice_id").notNull(),
    sliceSha256: text("slice_sha256").notNull(),
    publicationVersionId: text("publication_version_id").notNull(),
    publicationRegistrationSha256: text("publication_registration_sha256").notNull(),
    coverRunId: text("cover_run_id").notNull(),
    coverRecipeId: text("cover_recipe_id").notNull(),
    coverRecipeVersion: text("cover_recipe_version").notNull(),
    coverRecipeSha256: text("cover_recipe_sha256").notNull(),
    coverReceiptId: text("cover_receipt_id").notNull(),
    coverReceiptSchemaVersion: text("cover_receipt_schema_version").notNull(),
    coverReceiptJson: text("cover_receipt_json").notNull(),
    coverReceiptSha256: text("cover_receipt_sha256").notNull(),
    coverReceiptChainJson: text("cover_receipt_chain_json").notNull(),
    coverReceiptChainSha256: text("cover_receipt_chain_sha256").notNull(),
    coverArtifactSha256: text("cover_artifact_sha256").notNull(),
    coverBaselineId: text("cover_baseline_id").notNull(),
    coverBaselineSha256: text("cover_baseline_sha256").notNull(),
    coverProfileSha256: text("cover_profile_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("lifecycle_build_input_binding_branch_lock_check", sql`${table.branchLockVersion} >= 1`),
    check("lifecycle_build_input_binding_receipt_json_check", sql`json_valid(${table.coverReceiptJson}) AND json_type(${table.coverReceiptJson}) = 'object'`),
    check("lifecycle_build_input_binding_chain_json_check", sql`json_valid(${table.coverReceiptChainJson}) AND json_type(${table.coverReceiptChainJson}) = 'array'`),
    check("lifecycle_build_input_binding_sha_check", sql`
      length(${table.inputBindingSha256}) = 64
      AND length(${table.sourceBodySha256}) = 64
      AND length(${table.compositionSha256}) = 64
      AND length(${table.sliceSha256}) = 64
      AND length(${table.publicationRegistrationSha256}) = 64
      AND length(${table.coverRecipeSha256}) = 64
      AND length(${table.coverReceiptSha256}) = 64
      AND length(${table.coverReceiptChainSha256}) = 64
      AND length(${table.coverArtifactSha256}) = 64
      AND length(${table.coverBaselineSha256}) = 64
      AND length(${table.coverProfileSha256}) = 64
    `),
    index("idx_lifecycle_build_input_package_branch").on(table.packageId, table.branchId, table.createdAt),
    index("idx_lifecycle_build_input_cover_receipt").on(table.coverRunId, table.coverReceiptId),
  ],
);

export const lifecycleBuildGateRuns = sqliteTable(
  "lifecycle_build_gate_runs",
  {
    id: text("id").primaryKey(),
    buildId: text("build_id").notNull(),
    projectId: text("project_id").notNull(),
    articleId: text("article_id").notNull(),
    gateKind: text("gate_kind", { enum: ["compatibility", "fidelity"] }).notNull(),
    result: text("result", { enum: ["pass", "fail", "inconclusive"] }).notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    targetProfileSha256: text("target_profile_sha256").notNull(),
    contractSha256: text("contract_sha256").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    detailsJson: text("details_json").notNull().default("{}"),
    inputSha256: text("input_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("lifecycle_gates_kind_check", sql`${table.gateKind} IN ('compatibility','fidelity')`),
    check("lifecycle_gates_result_check", sql`${table.result} IN ('pass','fail','inconclusive')`),
    index("idx_lifecycle_gates_build_kind").on(table.buildId, table.gateKind, table.createdAt),
  ],
);

export const lifecycleReleases = sqliteTable(
  "lifecycle_releases",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    articleId: text("article_id").notNull(),
    buildId: text("build_id").notNull(),
    buildArtifactSha256: text("build_artifact_sha256").notNull(),
    targetProfileId: text("target_profile_id").notNull(),
    targetProfileSha256: text("target_profile_sha256").notNull(),
    approvalState: text("approval_state", { enum: ["draft", "approved", "rejected"] }).notNull().default("draft"),
    readinessState: text("readiness_state", { enum: ["draft", "artifact_validated", "ready_to_submit", "stale", "blocked"] }).notNull().default("draft"),
    readinessEvidenceSha256: text("readiness_evidence_sha256").notNull().default(""),
    readyAt: text("ready_at"),
    expiresAt: text("expires_at"),
    submissionState: text("submission_state", { enum: ["not_submitted", "submitting", "submission_accepted", "submission_failed"] }).notNull().default("not_submitted"),
    destinationState: text("destination_state", { enum: ["not_checked", "backend_verified", "not_found", "inconclusive"] }).notNull().default("not_checked"),
    publicState: text("public_state", { enum: ["not_checked", "public_verified", "not_public", "inconclusive"] }).notNull().default("not_checked"),
    lifecycleState: text("lifecycle_state", { enum: ["active", "withdrawn", "superseded"] }).notNull().default("active"),
    remoteRecordId: text("remote_record_id").notNull().default(""),
    destinationUrl: text("destination_url").notNull().default(""),
    publicUrl: text("public_url").notNull().default(""),
    approvalNote: text("approval_note").notNull().default(""),
    submissionEvidenceJson: text("submission_evidence_json").notNull().default("[]"),
    destinationEvidenceJson: text("destination_evidence_json").notNull().default("[]"),
    publicEvidenceJson: text("public_evidence_json").notNull().default("[]"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("lifecycle_releases_approval_check", sql`${table.approvalState} IN ('draft','approved','rejected')`),
    check("lifecycle_releases_readiness_check", sql`${table.readinessState} IN ('draft','artifact_validated','ready_to_submit','stale','blocked')`),
    check("lifecycle_releases_submission_check", sql`${table.submissionState} IN ('not_submitted','submitting','submission_accepted','submission_failed')`),
    check("lifecycle_releases_destination_check", sql`${table.destinationState} IN ('not_checked','backend_verified','not_found','inconclusive')`),
    check("lifecycle_releases_public_check", sql`${table.publicState} IN ('not_checked','public_verified','not_public','inconclusive')`),
    check("lifecycle_releases_lifecycle_check", sql`${table.lifecycleState} IN ('active','withdrawn','superseded')`),
    index("idx_lifecycle_releases_article_state").on(table.articleId, table.lifecycleState, table.updatedAt),
    index("idx_lifecycle_releases_readiness_expiry").on(table.readinessState, table.expiresAt),
    uniqueIndex("idx_lifecycle_releases_active_build").on(table.buildId).where(sql`${table.lifecycleState} = 'active'`),
  ],
);

export const lifecycleMetricSnapshots = sqliteTable(
  "lifecycle_metric_snapshots",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id").notNull(),
    projectId: text("project_id").notNull(),
    articleId: text("article_id").notNull(),
    sourceMode: text("source_mode", { enum: ["manual", "export"] }).notNull(),
    sourceLabel: text("source_label").notNull(),
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    capturedAt: text("captured_at").notNull(),
    metricsJson: text("metrics_json").notNull(),
    evidenceRef: text("evidence_ref").notNull(),
    measurementSha256: text("measurement_sha256").notNull(),
    definitionSetSha256: text("definition_set_sha256"),
    validationState: text("validation_state", { enum: ["collected", "validated", "inconclusive"] }).notNull().default("collected"),
    validationNote: text("validation_note").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("lifecycle_metrics_source_check", sql`${table.sourceMode} IN ('manual','export')`),
    check("lifecycle_metrics_validation_check", sql`${table.validationState} IN ('collected','validated','inconclusive')`),
    index("idx_lifecycle_metrics_release_time").on(table.releaseId, table.capturedAt),
  ],
);

export const lifecycleMetricDefinitions = sqliteTable(
  "lifecycle_metric_definitions",
  {
    id: text("id").primaryKey(),
    definitionKey: text("definition_key").notNull(),
    version: text("version").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    valueKind: text("value_kind", { enum: ["integer", "decimal"] }).notNull(),
    unit: text("unit").notNull(),
    missingPolicy: text("missing_policy", { enum: ["unknown", "reject", "not_applicable"] }).notNull().default("unknown"),
    constraintsJson: text("constraints_json").notNull().default("{}"),
    scopeJson: text("scope_json").notNull().default("{}"),
    definitionSha256: text("definition_sha256").notNull(),
    status: text("status", { enum: ["active", "superseded"] }).notNull().default("active"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("lifecycle_metric_definitions_value_kind_check", sql`${table.valueKind} IN ('integer','decimal')`),
    check("lifecycle_metric_definitions_missing_check", sql`${table.missingPolicy} IN ('unknown','reject','not_applicable')`),
    check("lifecycle_metric_definitions_status_check", sql`${table.status} IN ('active','superseded')`),
    uniqueIndex("idx_lifecycle_metric_definitions_key_version").on(table.definitionKey, table.version),
    uniqueIndex("idx_lifecycle_metric_definitions_active_key").on(table.definitionKey).where(sql`${table.status} = 'active'`),
    uniqueIndex("idx_lifecycle_metric_definitions_sha").on(table.definitionSha256),
  ],
);

export const lifecycleMetricValues = sqliteTable(
  "lifecycle_metric_values",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id").notNull(),
    releaseId: text("release_id").notNull(),
    projectId: text("project_id").notNull(),
    articleId: text("article_id").notNull(),
    definitionId: text("definition_id").notNull(),
    definitionSha256: text("definition_sha256").notNull(),
    observationState: text("observation_state", { enum: ["observed", "missing", "not_applicable"] }).notNull(),
    valueJson: text("value_json").notNull().default("null"),
    valueSha256: text("value_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("lifecycle_metric_values_observation_check", sql`${table.observationState} IN ('observed','missing','not_applicable')`),
    uniqueIndex("idx_lifecycle_metric_values_snapshot_definition").on(table.snapshotId, table.definitionId),
    index("idx_lifecycle_metric_values_article_snapshot").on(table.articleId, table.snapshotId),
    index("idx_lifecycle_metric_values_definition").on(table.definitionId, table.createdAt),
  ],
);

export const lifecycleRetrospectives = sqliteTable(
  "lifecycle_retrospectives",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    articleId: text("article_id").notNull(),
    releaseId: text("release_id"),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    evidenceRefsJson: text("evidence_refs_json").notNull().default("[]"),
    status: text("status", { enum: ["draft", "reviewed", "closed"] }).notNull().default("draft"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("lifecycle_retrospectives_status_check", sql`${table.status} IN ('draft','reviewed','closed')`),
    index("idx_lifecycle_retrospectives_article_status").on(table.articleId, table.status, table.updatedAt),
  ],
);

export const lifecycleRuleCandidates = sqliteTable(
  "lifecycle_rule_candidates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    articleId: text("article_id").notNull(),
    retrospectiveId: text("retrospective_id").notNull(),
    title: text("title").notNull(),
    ruleText: text("rule_text").notNull(),
    scope: text("scope").notNull().default(""),
    counterexamples: text("counterexamples").notNull().default(""),
    owner: text("owner").notNull().default(""),
    implementationTarget: text("implementation_target").notNull().default(""),
    regressionRef: text("regression_ref").notNull().default(""),
    evidenceRefsJson: text("evidence_refs_json").notNull().default("[]"),
    state: text("state", { enum: ["candidate", "testing", "verified", "adopted", "deferred", "rejected"] }).notNull().default("candidate"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("lifecycle_rules_state_check", sql`${table.state} IN ('candidate','testing','verified','adopted','deferred','rejected')`),
    index("idx_lifecycle_rules_article_state").on(table.articleId, table.state, table.updatedAt),
  ],
);

export const lifecycleEvents = sqliteTable(
  "lifecycle_events",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id"),
    eventType: text("event_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    inputSha256: text("input_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_lifecycle_events_article_created").on(table.articleId, table.createdAt)],
);

// Human requirements and annotations are deliberately separate from lifecycle
// events: they bind a review to an immutable article/package revision while
// lifecycle_events remains the shared audit stream.
export const articleRequirements = sqliteTable(
  "article_requirements",
  {
    id: text("id").primaryKey(), articleId: text("article_id").notNull(), requirementKey: text("requirement_key").notNull(),
    revision: integer("revision").notNull().default(sql`1`), supersedesRequirementId: text("supersedes_requirement_id"), packageId: text("package_id").notNull(),
    branchId: text("branch_id").notNull(), baseRevisionId: text("base_revision_id").notNull(), baseBodySha256: text("base_body_sha256").notNull(),
    title: text("title").notNull(), requirementText: text("requirement_text").notNull(), acceptanceJson: text("acceptance_json").notNull().default("{}"),
    priority: text("priority", { enum: ["must", "should", "could"] }).notNull().default("should"), inputSha256: text("input_sha256").notNull(),
    status: text("status", { enum: ["draft", "accepted", "superseded", "cancelled"] }).notNull().default("draft"), lockVersion: integer("lock_version").notNull().default(sql`1`),
    createdByKind: text("created_by_kind", { enum: ["human", "agent"] }).notNull(), createdBy: text("created_by").notNull(), acceptedBy: text("accepted_by"),
    acceptedAt: text("accepted_at"), supersededAt: text("superseded_at"), cancelledAt: text("cancelled_at"), createCommandId: text("create_command_id").notNull(), lastCommandId: text("last_command_id").notNull(),
    createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("article_requirements_priority_check", sql`${table.priority} IN ('must','should','could')`),
    check("article_requirements_status_check", sql`${table.status} IN ('draft','accepted','superseded','cancelled')`),
    check("article_requirements_created_by_kind_check", sql`${table.createdByKind} IN ('human','agent')`),
    check("article_requirements_revision_lock_check", sql`${table.revision} >= 1 AND ${table.lockVersion} >= 1`),
    check("article_requirements_sha_check", sql`length(${table.baseBodySha256}) = 64 AND ${table.baseBodySha256} NOT GLOB '*[^0-9a-f]*' AND length(${table.inputSha256}) = 64 AND ${table.inputSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_requirements_acceptance_json_check", sql`json_valid(${table.acceptanceJson}) AND json_type(${table.acceptanceJson}) = 'object'`),
    check("article_requirements_self_supersede_check", sql`${table.supersedesRequirementId} IS NULL OR ${table.supersedesRequirementId} <> ${table.id}`),
    check("article_requirements_status_time_check", sql`(${table.status} = 'draft' AND ${table.acceptedAt} IS NULL AND ${table.supersededAt} IS NULL AND ${table.cancelledAt} IS NULL) OR (${table.status} = 'accepted' AND ${table.acceptedAt} IS NOT NULL AND ${table.supersededAt} IS NULL AND ${table.cancelledAt} IS NULL) OR (${table.status} = 'superseded' AND ${table.acceptedAt} IS NOT NULL AND ${table.supersededAt} IS NOT NULL AND ${table.cancelledAt} IS NULL) OR (${table.status} = 'cancelled' AND ${table.acceptedAt} IS NULL AND ${table.supersededAt} IS NULL AND ${table.cancelledAt} IS NOT NULL)`),
    uniqueIndex("uq_article_requirements_article_key_revision").on(table.articleId, table.requirementKey, table.revision),
    uniqueIndex("uq_article_requirements_create_command").on(table.createCommandId),
    uniqueIndex("uq_article_requirements_accepted_key").on(table.articleId, table.requirementKey).where(sql`${table.status} = 'accepted'`),
    uniqueIndex("uq_article_requirements_supersedes_active").on(table.supersedesRequirementId).where(sql`${table.supersedesRequirementId} IS NOT NULL AND ${table.status} <> 'cancelled'`),
    index("idx_article_requirements_article_status_updated_id").on(table.articleId, table.status, table.updatedAt, table.id),
    index("idx_article_requirements_article_package_branch_base_revision").on(table.articleId, table.packageId, table.branchId, table.baseRevisionId),
  ],
);

export const humanAnnotations = sqliteTable(
  "human_annotations",
  {
    id: text("id").primaryKey(), articleId: text("article_id").notNull(), requirementId: text("requirement_id").notNull(), subjectType: text("subject_type", { enum: ["article_revision", "publication_version", "build"] }).notNull(), subjectId: text("subject_id").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(), labelSchemaVersion: integer("label_schema_version").notNull(), labelKind: text("label_kind", { enum: ["requirement_fit", "quality", "defect", "preference"] }).notNull(), verdict: text("verdict", { enum: ["pass", "fail", "inconclusive", "not_applicable"] }).notNull(), severity: text("severity", { enum: ["info", "minor", "major", "critical"] }).notNull(),
    note: text("note").notNull().default(""), detailsJson: text("details_json").notNull().default("{}"), evidenceRefsJson: text("evidence_refs_json").notNull().default("[]"), annotationSha256: text("annotation_sha256").notNull(), supersedesAnnotationId: text("supersedes_annotation_id"),
    inputSha256: text("input_sha256").notNull(), humanActorId: text("human_actor_id").notNull(), commandId: text("command_id").notNull(), createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("human_annotations_subject_type_check", sql`${table.subjectType} IN ('article_revision','publication_version','build')`),
    check("human_annotations_label_schema_version_check", sql`${table.labelSchemaVersion} >= 1`),
    check("human_annotations_label_kind_check", sql`${table.labelKind} IN ('requirement_fit','quality','defect','preference')`),
    check("human_annotations_verdict_check", sql`${table.verdict} IN ('pass','fail','inconclusive','not_applicable')`),
    check("human_annotations_severity_check", sql`${table.severity} IN ('info','minor','major','critical')`),
    check("human_annotations_json_check", sql`json_valid(${table.detailsJson}) AND json_type(${table.detailsJson}) = 'object' AND json_valid(${table.evidenceRefsJson}) AND json_type(${table.evidenceRefsJson}) = 'array'`),
    check("human_annotations_sha_check", sql`length(${table.snapshotSha256}) = 64 AND ${table.snapshotSha256} NOT GLOB '*[^0-9a-f]*' AND length(${table.annotationSha256}) = 64 AND ${table.annotationSha256} NOT GLOB '*[^0-9a-f]*' AND length(${table.inputSha256}) = 64 AND ${table.inputSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("human_annotations_self_supersede_check", sql`${table.supersedesAnnotationId} IS NULL OR ${table.supersedesAnnotationId} <> ${table.id}`),
    uniqueIndex("uq_human_annotations_command").on(table.commandId),
    uniqueIndex("uq_human_annotations_supersedes").on(table.supersedesAnnotationId).where(sql`${table.supersedesAnnotationId} IS NOT NULL`),
    index("idx_human_annotations_article_created_id").on(table.articleId, table.createdAt, table.id),
    index("idx_human_annotations_requirement_created_id").on(table.requirementId, table.createdAt, table.id),
    index("idx_human_annotations_subject_created_id").on(table.subjectType, table.subjectId, table.snapshotSha256, table.createdAt, table.id),
  ],
);

/** Article-scoped RSI proposals, human-approved immutable baselines, and advisory evidence. */
export const annotationRsiRuleCandidates = sqliteTable("annotation_rsi_rule_candidates", {
  id: text("id").primaryKey(), articleId: text("article_id").notNull(), projectId: text("project_id"), variantScopeJson: text("variant_scope_json").notNull().default("[]"), sourceBindingsJson: text("source_bindings_json").notNull(), sourceSetSha256: text("source_set_sha256").notNull(), canonicalRuleJson: text("canonical_rule_json").notNull(), canonicalRuleSha256: text("canonical_rule_sha256").notNull(), candidateSha256: text("candidate_sha256").notNull(), status: text("status", { enum: ["candidate", "approved"] }).notNull().default("candidate"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), decidedBy: text("decided_by"), decidedAt: text("decided_at"), decisionNote: text("decision_note"), lockVersion: integer("lock_version").notNull().default(1),
}, (t) => [
  uniqueIndex("uq_annotation_rsi_rule_candidate_sha").on(t.articleId, t.candidateSha256),
  check("annotation_rsi_rule_candidate_status_check", sql`${t.status} IN ('candidate','approved')`),
  check("annotation_rsi_rule_candidate_json_check", sql`json_valid(${t.variantScopeJson}) AND json_type(${t.variantScopeJson}) = 'array' AND json_valid(${t.sourceBindingsJson}) AND json_type(${t.sourceBindingsJson}) = 'array' AND json_array_length(${t.sourceBindingsJson}) > 0 AND json_valid(${t.canonicalRuleJson}) AND json_type(${t.canonicalRuleJson}) = 'object'`),
  check("annotation_rsi_rule_candidate_sha_check", sql`length(${t.sourceSetSha256}) = 64 AND ${t.sourceSetSha256} NOT GLOB '*[^0-9a-f]*' AND length(${t.canonicalRuleSha256}) = 64 AND ${t.canonicalRuleSha256} NOT GLOB '*[^0-9a-f]*' AND length(${t.candidateSha256}) = 64 AND ${t.candidateSha256} NOT GLOB '*[^0-9a-f]*'`),
  check("annotation_rsi_rule_candidate_decision_check", sql`(${t.status}='candidate' AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL AND ${t.decisionNote} IS NULL) OR (${t.status}='approved' AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL AND ${t.decisionNote} IS NOT NULL)`),
  index("idx_annotation_rsi_rule_candidate_article_status").on(t.articleId, t.status, t.createdAt),
]);

export const annotationRsiBaselineRevisions = sqliteTable("annotation_rsi_baseline_revisions", {
  id: text("id").primaryKey(), candidateId: text("candidate_id").notNull(), candidateSha256: text("candidate_sha256").notNull(), articleId: text("article_id").notNull(), revision: integer("revision").notNull(), parentRevisionId: text("parent_revision_id"), parentRevisionSha256: text("parent_revision_sha256"), revisionJson: text("revision_json").notNull(), revisionSha256: text("revision_sha256").notNull(), approvalCommandId: text("approval_command_id").notNull(), approvalActorId: text("approval_actor_id").notNull(), approvalPrincipalId: text("approval_principal_id").notNull(), approvalAuthBasis: text("approval_auth_basis").notNull(), approvalNote: text("approval_note").notNull(), approvedAt: text("approved_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.candidateId], foreignColumns: [annotationRsiRuleCandidates.id] }).onDelete("restrict"),
  foreignKey({ columns: [t.parentRevisionId], foreignColumns: [t.id] }).onDelete("restrict"),
  uniqueIndex("uq_annotation_rsi_baseline_candidate").on(t.candidateId),
  uniqueIndex("uq_annotation_rsi_baseline_article_revision").on(t.articleId, t.revision),
  uniqueIndex("uq_annotation_rsi_baseline_revision_sha").on(t.revisionSha256),
  check("annotation_rsi_baseline_revision_check", sql`${t.revision} >= 1`),
  check("annotation_rsi_baseline_json_check", sql`json_valid(${t.revisionJson}) AND json_type(${t.revisionJson}) = 'object'`),
  check("annotation_rsi_baseline_sha_check", sql`length(${t.revisionSha256}) = 64 AND ${t.revisionSha256} NOT GLOB '*[^0-9a-f]*' AND ((${t.parentRevisionId} IS NULL AND ${t.parentRevisionSha256} IS NULL AND ${t.revision}=1) OR (${t.parentRevisionId} IS NOT NULL AND length(${t.parentRevisionSha256})=64 AND ${t.parentRevisionSha256} NOT GLOB '*[^0-9a-f]*' AND ${t.revision}>1))`),
  check("annotation_rsi_baseline_approval_check", sql`${t.approvalAuthBasis} IN ('owner_pairing','trusted_device')`),
]);

export const annotationRsiDueChecks = sqliteTable("annotation_rsi_due_checks", {
  id: text("id").primaryKey(), articleId: text("article_id").notNull(), projectId: text("project_id").notNull(), triggerKind: text("trigger_kind", { enum: ["new_task", "task_terminal", "review_due", "external_ai_change"] }).notNull(), lastCheckedAt: text("last_checked_at").notNull(), nextDueAt: text("next_due_at").notNull(), sourceSetSha256: text("source_set_sha256").notNull(), sourceSummaryJson: text("source_summary_json").notNull(),
}, (t) => [
  check("annotation_rsi_due_check_trigger_check", sql`${t.triggerKind} IN ('new_task','task_terminal','review_due','external_ai_change')`),
  check("annotation_rsi_due_check_summary_check", sql`json_valid(${t.sourceSummaryJson}) AND json_type(${t.sourceSummaryJson})='object' AND length(${t.sourceSetSha256})=64 AND ${t.sourceSetSha256} NOT GLOB '*[^0-9a-f]*'`),
  index("idx_annotation_rsi_due_check_next_due").on(t.nextDueAt, t.articleId),
]);

export const agentClients = sqliteTable(
  "agent_clients",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    clientKind: text("client_kind", { enum: ["codex", "mcp", "custom"] }).notNull().default("custom"),
    role: text("role", { enum: ["agent", "administrator", "super_admin"] }).notNull().default("agent"),
    credentialPurpose: text("credential_purpose", { enum: ["agent_api", "management_session_exchange", "site_full_control"] }).notNull().default("agent_api"),
    issuedBySourceClientId: text("issued_by_source_client_id"),
    exchangeGeneration: integer("exchange_generation").notNull().default(0),
    tokenSha256: text("token_sha256").notNull(),
    scopesJson: text("scopes_json").notNull().default("[]"),
    articleIdsJson: text("article_ids_json").notNull().default("[]"),
    taskIdsJson: text("task_ids_json").notNull().default("[]"),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    check("agent_clients_client_kind_check", sql`${table.clientKind} IN ('codex','mcp','custom')`),
    check("agent_clients_role_check", sql`${table.role} IN ('agent','administrator','super_admin')`),
    check("agent_clients_credential_purpose_check", sql`${table.credentialPurpose} IN ('agent_api','management_session_exchange','site_full_control')`),
    check("agent_clients_lineage_not_self_check", sql`${table.issuedBySourceClientId} IS NULL OR ${table.issuedBySourceClientId} <> ${table.id}`),
    check("agent_clients_status_check", sql`${table.status} IN ('active','revoked')`),
    uniqueIndex("idx_agent_clients_token_sha256").on(table.tokenSha256),
    index("idx_agent_clients_status_expiry").on(table.status, table.expiresAt),
    index("idx_agent_clients_management_exchange").on(table.credentialPurpose, table.status, table.expiresAt),
    index("idx_agent_clients_source_client").on(table.issuedBySourceClientId),
  ],
);

/** Immutable v3 permission profile bound to a privileged Agent client. */
export const agentClientPermissionSnapshots = sqliteTable(
  "agent_client_permission_snapshots",
  {
    clientId: text("client_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(3),
    catalogVersion: text("catalog_version").notNull(),
    presetId: text("preset_id").notNull(),
    role: text("role").notNull(),
    scopesJson: text("scopes_json").notNull(),
    actionIdsJson: text("action_ids_json").notNull(),
    articleIdsJson: text("article_ids_json").notNull(),
    taskIdsJson: text("task_ids_json").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [check("agent_client_permission_snapshots_schema_check", sql`${table.schemaVersion} = 3`)],
);

export const agentTasks = sqliteTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id"),
    articleId: text("article_id").notNull(),
    projectId: text("project_id"),
    targetBranchId: text("target_branch_id"),
    packageId: text("package_id"),
    baseCompositionId: text("base_composition_id"),
    baseCompositionSha256: text("base_composition_sha256"),
    baseRevisionId: text("base_revision_id"),
    baseBranchLockVersion: integer("base_branch_lock_version"),
    currentContextSnapshotId: text("current_context_snapshot_id"),
    activeAttemptId: text("active_attempt_id"),
    assignedClientId: text("assigned_client_id"),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    instructionsMd: text("instructions_md").notNull().default(""),
    acceptanceJson: text("acceptance_json").notNull().default("[]"),
    contextSpecJson: text("context_spec_json").notNull().default("{}"),
    permissionCeilingJson: text("permission_ceiling_json").notNull().default("{}"),
    priority: text("priority", { enum: ["P0", "P1", "P2", "P3"] }).notNull().default("P2"),
    state: text("state", { enum: ["draft", "queued", "claimed", "running", "awaiting_human", "blocked", "review", "succeeded", "failed", "cancelled"] })
      .notNull()
      .default("queued"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdBy: text("created_by").notNull().default("user"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
    cancelledAt: text("cancelled_at"),
  },
  (table) => [
    check("agent_tasks_priority_check", sql`${table.priority} IN ('P0','P1','P2','P3')`),
    check("agent_tasks_state_check", sql`${table.state} IN ('draft','queued','claimed','running','awaiting_human','blocked','review','succeeded','failed','cancelled')`),
    index("idx_agent_tasks_article_state").on(table.articleId, table.state, table.updatedAt),
    index("idx_agent_tasks_package_state").on(table.packageId, table.state, table.updatedAt),
    index("idx_agent_tasks_assignee_state").on(table.assignedClientId, table.state, table.updatedAt),
    uniqueIndex("idx_agent_tasks_active_attempt").on(table.activeAttemptId).where(sql`${table.activeAttemptId} IS NOT NULL`),
  ],
);

export const agentContextSnapshots = sqliteTable(
  "agent_context_snapshots",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    articleId: text("article_id").notNull(),
    branchId: text("branch_id"),
    revisionId: text("revision_id").notNull(),
    bodySha256: text("body_sha256").notNull(),
    packageId: text("package_id"),
    compositionId: text("composition_id"),
    compositionSha256: text("composition_sha256"),
    packageDocumentSha256: text("package_document_sha256"),
    packageLockVersion: integer("package_lock_version"),
    branchStateLockVersion: integer("branch_state_lock_version"),
    branchHeadRevisionId: text("branch_head_revision_id"),
    moduleGraphSha256: text("module_graph_sha256"),
    diagnosisSummarySha256: text("diagnosis_summary_sha256"),
    corpusSchemaVersion: text("corpus_schema_version").notNull(),
    corpusAlgorithmVersion: text("corpus_algorithm_version").notNull(),
    corpusGeneratedAt: text("corpus_generated_at").notNull(),
    corpusSha256: text("corpus_sha256").notNull(),
    graphSha256: text("graph_sha256").notNull(),
    rulesSha256: text("rules_sha256").notNull(),
    bundleJson: text("bundle_json").notNull(),
    contextSha256: text("context_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_agent_context_task_created").on(table.taskId, table.createdAt),
    index("idx_agent_context_package_composition").on(table.packageId, table.compositionId),
    uniqueIndex("idx_agent_context_task_sha").on(table.taskId, table.contextSha256),
  ],
);

export const agentTaskAttempts = sqliteTable(
  "agent_task_attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    attempt: integer("attempt").notNull().default(1),
    clientId: text("client_id").notNull(),
    contextSnapshotId: text("context_snapshot_id").notNull(),
    state: text("state", { enum: ["claimed", "running", "awaiting_human", "succeeded", "failed", "released", "cancelled"] })
      .notNull()
      .default("claimed"),
    lastHeartbeatAt: text("last_heartbeat_at"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    errorClass: text("error_class"),
    errorSummary: text("error_summary"),
  },
  (table) => [
    check("agent_task_attempts_state_check", sql`${table.state} IN ('claimed','running','awaiting_human','succeeded','failed','released','cancelled')`),
    uniqueIndex("idx_agent_task_attempt_number").on(table.taskId, table.attempt),
    index("idx_agent_task_attempts_client_state").on(table.clientId, table.state, table.startedAt),
  ],
);

export const agentTaskLeases = sqliteTable(
  "agent_task_leases",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    clientId: text("client_id").notNull(),
    leaseTokenSha256: text("lease_token_sha256").notNull(),
    leasedAt: text("leased_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
    heartbeatSeq: integer("heartbeat_seq").notNull().default(0),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("idx_agent_task_leases_active_attempt").on(table.attemptId).where(sql`${table.revokedAt} IS NULL`),
    index("idx_agent_task_leases_expiry").on(table.expiresAt, table.revokedAt),
    index("idx_agent_task_leases_task").on(table.taskId, table.revokedAt),
  ],
);

export const agentProgressEvents = sqliteTable(
  "agent_progress_events",
  {
    cursor: integer("cursor").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    taskId: text("task_id").notNull(),
    attemptId: text("attempt_id"),
    eventType: text("event_type").notNull(),
    phase: text("phase").notNull().default(""),
    progressPercent: integer("progress_percent"),
    currentAction: text("current_action").notNull().default(""),
    nextAction: text("next_action").notNull().default(""),
    blocker: text("blocker").notNull().default(""),
    message: text("message").notNull().default(""),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    payloadJson: text("payload_json").notNull().default("{}"),
    actorKind: text("actor_kind", { enum: ["user", "agent", "system"] }).notNull(),
    actorId: text("actor_id").notNull(),
    commandId: text("command_id"),
    inputSha256: text("input_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("agent_progress_percent_check", sql`${table.progressPercent} IS NULL OR (${table.progressPercent} >= 0 AND ${table.progressPercent} <= 100)`),
    uniqueIndex("idx_agent_progress_event_id").on(table.id),
    uniqueIndex("idx_agent_progress_command").on(table.commandId).where(sql`${table.commandId} IS NOT NULL`),
    index("idx_agent_progress_task_cursor").on(table.taskId, table.cursor),
  ],
);

export const agentTaskArtifacts = sqliteTable(
  "agent_task_artifacts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    contentRef: text("content_ref").notNull(),
    sha256: text("sha256").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    contextSha256: text("context_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_agent_task_artifact_attempt_sha").on(table.attemptId, table.kind, table.sha256),
    index("idx_agent_task_artifacts_task_created").on(table.taskId, table.createdAt),
  ],
);

export const agentApprovalRequests = sqliteTable(
  "agent_approval_requests",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    question: text("question").notNull(),
    optionsJson: text("options_json").notNull().default("[]"),
    status: text("status", { enum: ["pending", "approved", "rejected", "cancelled"] }).notNull().default("pending"),
    requestedByClientId: text("requested_by_client_id").notNull(),
    decisionNote: text("decision_note").notNull().default(""),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
    decidedBy: text("decided_by"),
  },
  (table) => [
    check("agent_approval_requests_status_check", sql`${table.status} IN ('pending','approved','rejected','cancelled')`),
    index("idx_agent_approval_task_status").on(table.taskId, table.status, table.createdAt),
  ],
);

export const graphProposals = sqliteTable(
  "graph_proposals",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    articleId: text("article_id").notNull(),
    proposalKind: text("proposal_kind", { enum: ["node", "edge", "claim"] }).notNull(),
    sourceId: text("source_id"),
    targetId: text("target_id"),
    relationType: text("relation_type").notNull().default(""),
    label: text("label").notNull().default(""),
    payloadJson: text("payload_json").notNull().default("{}"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    contextSha256: text("context_sha256").notNull(),
    inputSha256: text("input_sha256").notNull(),
    status: text("status", { enum: ["candidate", "confirmed", "rejected"] }).notNull().default("candidate"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdByClientId: text("created_by_client_id").notNull(),
    createdAt: text("created_at").notNull(),
    reviewedAt: text("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    reviewNote: text("review_note").notNull().default(""),
  },
  (table) => [
    check("graph_proposals_kind_check", sql`${table.proposalKind} IN ('node','edge','claim')`),
    check("graph_proposals_status_check", sql`${table.status} IN ('candidate','confirmed','rejected')`),
    index("idx_graph_proposals_article_status").on(table.articleId, table.status, table.createdAt),
    index("idx_graph_proposals_task_status").on(table.taskId, table.status, table.createdAt),
  ],
);

export const articleProjectPackages = sqliteTable(
  "article_project_packages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id"),
    articleId: text("article_id").notNull(),
    title: text("title").notNull(),
    schemaVersion: text("schema_version").notNull().default("wenmai-package-v1"),
    branchModelVersion: integer("branch_model_version"),
    primaryBranchId: text("primary_branch_id"),
    mainCompositionId: text("main_composition_id").notNull(),
    mainCompositionSha256: text("main_composition_sha256").notNull(),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("article_project_packages_status_check", sql`${table.status} IN ('active','archived')`),
    uniqueIndex("idx_article_project_packages_article").on(table.articleId),
    uniqueIndex("idx_article_project_packages_project").on(table.projectId).where(sql`${table.projectId} IS NOT NULL`),
    uniqueIndex("idx_article_project_packages_primary_branch").on(table.primaryBranchId).where(sql`${table.primaryBranchId} IS NOT NULL`),
    index("idx_article_project_packages_status_updated").on(table.status, table.updatedAt),
  ],
);

// ProjectGroup deliberately sits beside, rather than inside, the legacy editorial
// series model.  A member always names both sides of the existing one-to-one
// ArticleProject relation so an ArticleProject cannot be attached to another
// Article by accident.
export const projectGroups = sqliteTable(
  "project_groups",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    topologySha256: text("topology_sha256").notNull(),
    lockVersion: integer("lock_version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (table) => [
    check("project_groups_status_check", sql`${table.status} IN ('active','archived')`),
    check("project_groups_lock_version_check", sql`${table.lockVersion} >= 1`),
    check("project_groups_topology_sha256_check", sql`length(${table.topologySha256}) = 64 AND ${table.topologySha256} NOT GLOB '*[^0-9a-f]*'`),
    index("idx_project_groups_status_updated").on(table.status, table.updatedAt),
  ],
);

export const projectGroupMembers = sqliteTable(
  "project_group_members",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull().references(() => projectGroups.id, { onDelete: "restrict" }),
    articleId: text("article_id").notNull(),
    articleProjectId: text("article_project_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_project_group_members_group_article").on(table.groupId, table.articleId),
    uniqueIndex("idx_project_group_members_group_article_project").on(table.groupId, table.articleProjectId),
    index("idx_project_group_members_article").on(table.articleId, table.groupId),
    foreignKey({ columns: [table.articleProjectId, table.articleId], foreignColumns: [lifecycleArticleProjects.id, lifecycleArticleProjects.articleId] })
      .onDelete("restrict"),
  ],
);

export const projectGroupEdges = sqliteTable(
  "project_group_edges",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull().references(() => projectGroups.id, { onDelete: "restrict" }),
    sourceArticleId: text("source_article_id").notNull(),
    targetArticleId: text("target_article_id").notNull(),
    relationType: text("relation_type", { enum: ["precedes"] }).notNull().default("precedes"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("project_group_edges_relation_type_check", sql`${table.relationType} = 'precedes'`),
    check("project_group_edges_no_self_check", sql`${table.sourceArticleId} <> ${table.targetArticleId}`),
    uniqueIndex("idx_project_group_edges_semantic").on(table.groupId, table.sourceArticleId, table.targetArticleId, table.relationType),
    index("idx_project_group_edges_target").on(table.groupId, table.targetArticleId),
    foreignKey({ columns: [table.groupId, table.sourceArticleId], foreignColumns: [projectGroupMembers.groupId, projectGroupMembers.articleId] }).onDelete("restrict"),
    foreignKey({ columns: [table.groupId, table.targetArticleId], foreignColumns: [projectGroupMembers.groupId, projectGroupMembers.articleId] }).onDelete("restrict"),
  ],
);

export const projectGroupEvents = sqliteTable(
  "project_group_events",
  {
    id: text("id").primaryKey(), groupId: text("group_id").notNull().references(() => projectGroups.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(), actorId: text("actor_id").notNull(), commandId: text("command_id").notNull(),
    requestSha256: text("request_sha256").notNull(), beforeLockVersion: integer("before_lock_version").notNull(),
    afterLockVersion: integer("after_lock_version").notNull(), resultTopologySha256: text("result_topology_sha256").notNull(),
    detailsJson: text("details_json").notNull().default("{}"), createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("project_group_events_request_sha256_check", sql`length(${table.requestSha256}) = 64 AND ${table.requestSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("project_group_events_result_topology_sha256_check", sql`length(${table.resultTopologySha256}) = 64 AND ${table.resultTopologySha256} NOT GLOB '*[^0-9a-f]*'`),
    check("project_group_events_lock_transition_check", sql`${table.afterLockVersion} = ${table.beforeLockVersion} + 1`),
    index("idx_project_group_events_group_created").on(table.groupId, table.createdAt),
  ],
);

export const projectGroupCommandReceipts = sqliteTable(
  "project_group_command_receipts",
  {
    commandId: text("command_id").primaryKey(), action: text("action").notNull(), actorId: text("actor_id").notNull(),
    requestSha256: text("request_sha256").notNull(), mutationReadbackJson: text("mutation_readback_json").notNull(),
    resultLockVersion: integer("result_lock_version").notNull(), topologySha256: text("topology_sha256").notNull(),
    status: text("status", { enum: ["succeeded"] }).notNull().default("succeeded"), statusCode: integer("status_code").notNull(),
    createdAt: text("created_at").notNull(), completedAt: text("completed_at").notNull(),
  },
  (table) => [
    check("project_group_command_receipts_terminal_check", sql`${table.status} = 'succeeded'`),
    check("project_group_command_receipts_lock_version_check", sql`${table.resultLockVersion} >= 1`),
    check("project_group_command_receipts_request_sha256_check", sql`length(${table.requestSha256}) = 64 AND ${table.requestSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("project_group_command_receipts_topology_sha256_check", sql`length(${table.topologySha256}) = 64 AND ${table.topologySha256} NOT GLOB '*[^0-9a-f]*'`),
    check("project_group_command_receipts_status_code_check", sql`${table.statusCode} > 0`),
    index("idx_project_group_command_receipts_actor_created").on(table.actorId, table.createdAt),
  ],
);

export const articlePublicationVersions = sqliteTable(
  "article_publication_versions",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    articleId: text("article_id").notNull(),
    role: text("role", { enum: ["canonical_baseline", "platform_variant"] }).notNull(),
    versionKey: text("version_key").notNull(),
    platform: text("platform"),
    branchId: text("branch_id").notNull(),
    branchLockVersion: integer("branch_lock_version").notNull(),
    revisionId: text("revision_id").notNull(),
    bodySha256: text("body_sha256").notNull(),
    compositionId: text("composition_id").notNull(),
    compositionSha256: text("composition_sha256").notNull(),
    targetProfileId: text("target_profile_id"),
    targetProfileKey: text("target_profile_key"),
    targetProfileSha256: text("target_profile_sha256"),
    baselineVersionId: text("baseline_version_id"),
    baselineBranchId: text("baseline_branch_id"),
    baselineRevisionId: text("baseline_revision_id"),
    baselineBodySha256: text("baseline_body_sha256"),
    baselineCompositionId: text("baseline_composition_id"),
    baselineCompositionSha256: text("baseline_composition_sha256"),
    publicationVersionJson: text("publication_version_json").notNull(),
    registrationSha256: text("registration_sha256").notNull(),
    state: text("state", { enum: ["active", "superseded"] }).notNull().default("active"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("article_publication_versions_role_check", sql`${table.role} IN ('canonical_baseline','platform_variant')`),
    check("article_publication_versions_state_check", sql`${table.state} IN ('active','superseded')`),
    check("article_publication_versions_lock_check", sql`${table.branchLockVersion} >= 1 AND ${table.lockVersion} >= 1`),
    check("article_publication_versions_json_check", sql`json_valid(${table.publicationVersionJson}) AND json_type(${table.publicationVersionJson}) = 'object'`),
    check("article_publication_versions_sha_check", sql`
      length(${table.bodySha256}) = 64
      AND length(${table.compositionSha256}) = 64
      AND length(${table.registrationSha256}) = 64
    `),
    check("article_publication_versions_shape_check", sql`
      (${table.role} = 'canonical_baseline'
        AND ${table.versionKey} = 'canonical'
        AND ${table.platform} IS NULL
        AND ${table.targetProfileId} IS NULL
        AND ${table.targetProfileKey} IS NULL
        AND ${table.targetProfileSha256} IS NULL
        AND ${table.baselineVersionId} IS NULL
        AND ${table.baselineBranchId} IS NULL
        AND ${table.baselineRevisionId} IS NULL
        AND ${table.baselineBodySha256} IS NULL
        AND ${table.baselineCompositionId} IS NULL
        AND ${table.baselineCompositionSha256} IS NULL)
      OR
      (${table.role} = 'platform_variant'
        AND ${table.versionKey} IN ('maimai','xiaohongshu','zhihu','bilibili')
        AND ${table.platform} = ${table.versionKey}
        AND ${table.targetProfileId} IS NOT NULL
        AND ${table.targetProfileKey} IS NOT NULL
        AND length(${table.targetProfileSha256}) = 64
        AND ${table.baselineVersionId} IS NOT NULL
        AND ${table.baselineBranchId} IS NOT NULL
        AND ${table.baselineRevisionId} IS NOT NULL
        AND length(${table.baselineBodySha256}) = 64
        AND ${table.baselineCompositionId} IS NOT NULL
        AND length(${table.baselineCompositionSha256}) = 64)
    `),
    uniqueIndex("idx_article_publication_versions_active_key")
      .on(table.packageId, table.versionKey).where(sql`${table.state} = 'active'`),
    uniqueIndex("idx_article_publication_versions_active_branch")
      .on(table.packageId, table.branchId).where(sql`${table.state} = 'active'`),
    index("idx_article_publication_versions_article_state").on(table.articleId, table.state, table.updatedAt),
  ],
);

export const packageModules = sqliteTable(
  "package_modules",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    moduleKey: text("module_key").notNull(),
    moduleKind: text("module_kind").notNull(),
    schemaKey: text("schema_key").notNull().default("wenmai.module"),
    schemaVersion: text("schema_version").notNull().default("1"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_package_modules_package_key").on(table.packageId, table.moduleKey),
    index("idx_package_modules_package_kind").on(table.packageId, table.moduleKind),
  ],
);

export const packageModuleRevisions = sqliteTable(
  "package_module_revisions",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    moduleId: text("module_id").notNull(),
    parentRevisionId: text("parent_revision_id"),
    title: text("title").notNull(),
    contentFormat: text("content_format", { enum: ["markdown", "text", "json"] }).notNull(),
    contentText: text("content_text").notNull().default(""),
    contentJson: text("content_json").notNull().default("{}"),
    contentSha256: text("content_sha256").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    revisionSha256: text("revision_sha256").notNull(),
    authorKind: text("author_kind", { enum: ["user", "agent", "import", "system"] }).notNull(),
    sourcePatchId: text("source_patch_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("package_module_revisions_format_check", sql`${table.contentFormat} IN ('markdown','text','json')`),
    check("package_module_revisions_author_check", sql`${table.authorKind} IN ('user','agent','import','system')`),
    uniqueIndex("idx_package_module_revisions_module_sha").on(table.moduleId, table.revisionSha256),
    index("idx_package_module_revisions_package_created").on(table.packageId, table.createdAt),
  ],
);

export const packageAssets = sqliteTable(
  "package_assets",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    assetKey: text("asset_key").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    contentRef: text("content_ref").notNull(),
    mediaType: text("media_type").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    rightsJson: text("rights_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_package_assets_package_key").on(table.packageId, table.assetKey),
    uniqueIndex("idx_package_assets_package_sha").on(table.packageId, table.sha256),
  ],
);

export const packageSourceRefs = sqliteTable(
  "package_source_refs",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceKind: text("source_kind").notNull(),
    canonicalRef: text("canonical_ref").notNull(),
    title: text("title").notNull(),
    capturedAt: text("captured_at"),
    contentSha256: text("content_sha256"),
    excerpt: text("excerpt").notNull().default(""),
    metadataJson: text("metadata_json").notNull().default("{}"),
    rightsJson: text("rights_json").notNull().default("{}"),
    refSha256: text("ref_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_package_sources_package_key").on(table.packageId, table.sourceKey),
    uniqueIndex("idx_package_sources_package_sha").on(table.packageId, table.refSha256),
    uniqueIndex("idx_package_source_refs_id_package").on(table.id, table.packageId),
  ],
);

export const packageModuleRevisionRefs = sqliteTable(
  "package_module_revision_refs",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    moduleRevisionId: text("module_revision_id").notNull(),
    refKind: text("ref_kind", { enum: ["asset", "source"] }).notNull(),
    refId: text("ref_id").notNull(),
    relationType: text("relation_type").notNull(),
    anchorJson: text("anchor_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("package_module_revision_refs_kind_check", sql`${table.refKind} IN ('asset','source')`),
    uniqueIndex("idx_package_module_revision_refs_unique").on(table.moduleRevisionId, table.refKind, table.refId, table.relationType),
    index("idx_package_module_revision_refs_ref").on(table.packageId, table.refKind, table.refId),
  ],
);

export const packageCompositions = sqliteTable(
  "package_compositions",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    parentCompositionId: text("parent_composition_id"),
    title: text("title").notNull(),
    schemaVersion: text("schema_version").notNull().default("wenmai-composition-v1"),
    rootModuleId: text("root_module_id").notNull(),
    documentJson: text("document_json").notNull(),
    documentSha256: text("document_sha256").notNull(),
    manifestJson: text("manifest_json").notNull(),
    compositionSha256: text("composition_sha256").notNull(),
    sourceArticleRevisionId: text("source_article_revision_id"),
    authorKind: text("author_kind", { enum: ["user", "agent", "import", "system"] }).notNull(),
    sourcePatchId: text("source_patch_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("package_compositions_author_check", sql`${table.authorKind} IN ('user','agent','import','system')`),
    uniqueIndex("idx_package_compositions_package_sha").on(table.packageId, table.compositionSha256),
    index("idx_package_compositions_package_created").on(table.packageId, table.createdAt),
  ],
);

export const packageCompositionMaterializations = sqliteTable(
  "package_composition_materializations",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    branchId: text("branch_id").notNull(),
    compositionId: text("composition_id").notNull(),
    compositionSha256: text("composition_sha256").notNull(),
    articleRevisionId: text("article_revision_id").notNull(),
    articleBodySha256: text("article_body_sha256").notNull(),
    rendererKey: text("renderer_key").notNull().default("wenmai.package-markdown"),
    rendererVersion: text("renderer_version").notNull().default("1"),
    createdByKind: text("created_by_kind", { enum: ["user", "agent", "import", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("package_composition_materializations_author_check", sql`${table.createdByKind} IN ('user','agent','import','system')`),
    index("idx_package_materializations_branch_composition").on(table.branchId, table.compositionId, table.createdAt),
    uniqueIndex("idx_package_materializations_revision").on(table.articleRevisionId),
    index("idx_package_materializations_package_created").on(table.packageId, table.createdAt),
  ],
);

export const packageBranchStates = sqliteTable(
  "package_branch_states",
  {
    packageId: text("package_id").notNull(),
    branchId: text("branch_id").notNull(),
    headCompositionId: text("head_composition_id").notNull(),
    headCompositionSha256: text("head_composition_sha256").notNull(),
    headRevisionId: text("head_revision_id").notNull(),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.packageId, table.branchId], name: "pk_package_branch_states" }),
    check("package_branch_states_status_check", sql`${table.status} IN ('active','archived')`),
    uniqueIndex("idx_package_branch_states_branch").on(table.branchId),
    index("idx_package_branch_states_package_status").on(table.packageId, table.status, table.updatedAt),
  ],
);

export const packageBranchWorkingCopies = sqliteTable(
  "package_branch_working_copies",
  {
    packageId: text("package_id").notNull(),
    branchId: text("branch_id").notNull(),
    baseCompositionId: text("base_composition_id").notNull(),
    baseRevisionId: text("base_revision_id").notNull(),
    documentJson: text("document_json").notNull(),
    documentSha256: text("document_sha256").notNull(),
    dirty: integer("dirty", { mode: "boolean" }).notNull().default(false),
    lockVersion: integer("lock_version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.packageId, table.branchId], name: "pk_package_branch_working_copies" }),
    index("idx_package_branch_working_dirty").on(table.packageId, table.dirty, table.updatedAt),
  ],
);

export const packageBranchCompositionCommits = sqliteTable(
  "package_branch_composition_commits",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    branchId: text("branch_id").notNull(),
    parentCompositionId: text("parent_composition_id"),
    compositionId: text("composition_id").notNull(),
    compositionSha256: text("composition_sha256").notNull(),
    previousRevisionId: text("previous_revision_id"),
    articleRevisionId: text("article_revision_id").notNull(),
    sourceKind: text("source_kind", { enum: ["attach", "commit", "patch", "import", "system"] }).notNull(),
    sourcePatchId: text("source_patch_id"),
    createdByKind: text("created_by_kind", { enum: ["user", "agent", "import", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("package_branch_commits_source_check", sql`${table.sourceKind} IN ('attach','commit','patch','import','system')`),
    check("package_branch_commits_author_check", sql`${table.createdByKind} IN ('user','agent','import','system')`),
    uniqueIndex("idx_package_branch_commits_revision").on(table.branchId, table.articleRevisionId),
    index("idx_package_branch_commits_history").on(table.packageId, table.branchId, table.createdAt),
  ],
);

export const packageBranchMigrationAudits = sqliteTable(
  "package_branch_migration_audits",
  {
    packageId: text("package_id").primaryKey(),
    state: text("state", { enum: ["legacy_unbound", "migrated_clean", "migrated_dirty", "blocked"] }).notNull(),
    reasonCode: text("reason_code").notNull().default(""),
    detailJson: text("detail_json").notNull().default("{}"),
    sourceSchemaVersion: text("source_schema_version").notNull().default("0009"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("package_branch_migration_audits_state_check", sql`${table.state} IN ('legacy_unbound','migrated_clean','migrated_dirty','blocked')`),
    index("idx_package_branch_migration_audits_state").on(table.state, table.updatedAt),
  ],
);

export const packageCompositionNodes = sqliteTable(
  "package_composition_nodes",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    compositionId: text("composition_id").notNull(),
    moduleId: text("module_id").notNull(),
    moduleRevisionId: text("module_revision_id").notNull(),
    nodeKey: text("node_key").notNull(),
    slot: text("slot").notNull().default("body"),
    ordinal: integer("ordinal").notNull().default(0),
    required: integer("required", { mode: "boolean" }).notNull().default(true),
    configJson: text("config_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_package_composition_nodes_key").on(table.compositionId, table.nodeKey),
    uniqueIndex("idx_package_composition_nodes_module").on(table.compositionId, table.moduleId),
    index("idx_package_composition_nodes_order").on(table.compositionId, table.slot, table.ordinal),
  ],
);

export const packageCompositionEdges = sqliteTable(
  "package_composition_edges",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    compositionId: text("composition_id").notNull(),
    edgeKey: text("edge_key").notNull(),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    relationType: text("relation_type").notNull(),
    ordinal: integer("ordinal").notNull().default(0),
    conditionJson: text("condition_json").notNull().default("{}"),
    edgeSha256: text("edge_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_package_composition_edges_key").on(table.compositionId, table.edgeKey),
    index("idx_package_composition_edges_source").on(table.compositionId, table.sourceNodeId, table.ordinal),
    index("idx_package_composition_edges_target").on(table.compositionId, table.targetNodeId),
  ],
);

export const packageWorkingCopies = sqliteTable(
  "package_working_copies",
  {
    packageId: text("package_id").primaryKey(),
    branchId: text("branch_id"),
    baseCompositionId: text("base_composition_id").notNull(),
    baseRevisionId: text("base_revision_id"),
    documentJson: text("document_json").notNull(),
    documentSha256: text("document_sha256").notNull(),
    dirty: integer("dirty", { mode: "boolean" }).notNull().default(false),
    lockVersion: integer("lock_version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_package_working_copies_updated").on(table.updatedAt)],
);

export const packageSlices = sqliteTable(
  "package_slices",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    branchId: text("branch_id"),
    baseRevisionId: text("base_revision_id"),
    baseBranchLockVersion: integer("base_branch_lock_version"),
    compositionId: text("composition_id").notNull(),
    compositionSha256: text("composition_sha256").notNull(),
    title: text("title").notNull(),
    sliceKind: text("slice_kind", { enum: ["full", "demo", "excerpt", "promo", "custom"] }).notNull(),
    selectorJson: text("selector_json").notNull().default("{}"),
    resolvedManifestJson: text("resolved_manifest_json").notNull(),
    sliceSha256: text("slice_sha256").notNull(),
    createdByKind: text("created_by_kind", { enum: ["user", "agent", "import", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("package_slices_kind_check", sql`${table.sliceKind} IN ('full','demo','excerpt','promo','custom')`),
    uniqueIndex("idx_package_slices_composition_sha").on(table.compositionId, table.sliceSha256),
    index("idx_package_slices_package_created").on(table.packageId, table.createdAt),
    index("idx_package_slices_branch_created").on(table.packageId, table.branchId, table.createdAt),
  ],
);

export const packagePatchProposals = sqliteTable(
  "package_patch_proposals",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    baseCompositionId: text("base_composition_id").notNull(),
    baseCompositionSha256: text("base_composition_sha256").notNull(),
    branchId: text("branch_id"),
    baseRevisionId: text("base_revision_id"),
    basePackageLockVersion: integer("base_package_lock_version"),
    baseBranchLockVersion: integer("base_branch_lock_version"),
    taskId: text("task_id"),
    attemptId: text("attempt_id"),
    contextSha256: text("context_sha256"),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    operationsJson: text("operations_json").notNull(),
    patchSha256: text("patch_sha256").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    diagnosticIssueIdsJson: text("diagnostic_issue_ids_json").notNull().default("[]"),
    status: text("status", { enum: ["candidate", "approved", "rejected", "applied", "stale", "cancelled"] }).notNull().default("candidate"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdByKind: text("created_by_kind", { enum: ["user", "agent", "import", "diagnostic"] }).notNull(),
    createdById: text("created_by_id").notNull(),
    decisionNote: text("decision_note").notNull().default(""),
    decidedByKind: text("decided_by_kind"),
    decidedById: text("decided_by_id"),
    appliedCompositionId: text("applied_composition_id"),
    createdAt: text("created_at").notNull(),
    reviewedAt: text("reviewed_at"),
    appliedAt: text("applied_at"),
  },
  (table) => [
    check("package_patch_proposals_status_check", sql`${table.status} IN ('candidate','approved','rejected','applied','stale','cancelled')`),
    check("package_patch_proposals_creator_check", sql`${table.createdByKind} IN ('user','agent','import','diagnostic')`),
    uniqueIndex("idx_package_patch_proposals_package_sha").on(table.packageId, table.patchSha256),
    index("idx_package_patch_proposals_package_status").on(table.packageId, table.status, table.createdAt),
    index("idx_package_patch_proposals_branch_status").on(table.packageId, table.branchId, table.status, table.createdAt),
  ],
);

export const packageDiagnosisRuns = sqliteTable(
  "package_diagnosis_runs",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    branchId: text("branch_id"),
    baseRevisionId: text("base_revision_id"),
    baseBranchLockVersion: integer("base_branch_lock_version"),
    compositionId: text("composition_id").notNull(),
    compositionSha256: text("composition_sha256").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    result: text("result", { enum: ["pass", "fail", "inconclusive"] }).notNull(),
    issueCount: integer("issue_count").notNull(),
    errorCount: integer("error_count").notNull(),
    warningCount: integer("warning_count").notNull(),
    inputSha256: text("input_sha256").notNull(),
    summarySha256: text("summary_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("package_diagnosis_runs_result_check", sql`${table.result} IN ('pass','fail','inconclusive')`),
    uniqueIndex("idx_package_diagnosis_runs_input").on(table.packageId, table.inputSha256),
    index("idx_package_diagnosis_runs_composition").on(table.compositionId, table.createdAt),
    index("idx_package_diagnosis_runs_branch_created").on(table.packageId, table.branchId, table.createdAt),
  ],
);

export const packageDiagnosticIssues = sqliteTable(
  "package_diagnostic_issues",
  {
    id: text("id").primaryKey(),
    diagnosisRunId: text("diagnosis_run_id").notNull(),
    packageId: text("package_id").notNull(),
    branchId: text("branch_id"),
    compositionId: text("composition_id").notNull(),
    moduleId: text("module_id"),
    nodeId: text("node_id"),
    edgeId: text("edge_id"),
    code: text("code").notNull(),
    severity: text("severity", { enum: ["error", "warning", "info"] }).notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    suggestedPatchJson: text("suggested_patch_json").notNull().default("[]"),
    issueSha256: text("issue_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("package_diagnostic_issues_severity_check", sql`${table.severity} IN ('error','warning','info')`),
    uniqueIndex("idx_package_diagnostic_issues_run_sha").on(table.diagnosisRunId, table.issueSha256),
    index("idx_package_diagnostic_issues_composition").on(table.compositionId, table.severity),
    index("idx_package_diagnostic_issues_branch").on(table.packageId, table.branchId, table.createdAt),
  ],
);

export const packageImportRuns = sqliteTable(
  "package_import_runs",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    branchId: text("branch_id"),
    baseRevisionId: text("base_revision_id"),
    baseBranchLockVersion: integer("base_branch_lock_version"),
    baseCompositionId: text("base_composition_id").notNull(),
    baseCompositionSha256: text("base_composition_sha256").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceRef: text("source_ref").notNull(),
    sourceFingerprintSha256: text("source_fingerprint_sha256").notNull(),
    importerKey: text("importer_key").notNull(),
    importerVersion: text("importer_version").notNull(),
    manifestJson: text("manifest_json").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    patchProposalId: text("patch_proposal_id").notNull(),
    state: text("state", { enum: ["candidate_ready", "applied", "failed", "cancelled"] }).notNull(),
    lockVersion: integer("lock_version").notNull().default(1),
    errorSummary: text("error_summary").notNull().default(""),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    check("package_import_runs_state_check", sql`${table.state} IN ('candidate_ready','applied','failed','cancelled')`),
    uniqueIndex("idx_package_import_runs_manifest").on(table.packageId, table.manifestSha256),
    index("idx_package_import_runs_package_state").on(table.packageId, table.state, table.createdAt),
    index("idx_package_import_runs_branch_state").on(table.packageId, table.branchId, table.state, table.createdAt),
  ],
);

export const packageExportRuns = sqliteTable(
  "package_export_runs",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    branchId: text("branch_id"),
    baseRevisionId: text("base_revision_id"),
    baseBranchLockVersion: integer("base_branch_lock_version"),
    compositionId: text("composition_id").notNull(),
    compositionSha256: text("composition_sha256").notNull(),
    sliceId: text("slice_id"),
    sliceSha256: text("slice_sha256"),
    exportKind: text("export_kind").notNull(),
    exporterKey: text("exporter_key").notNull(),
    exporterVersion: text("exporter_version").notNull(),
    manifestJson: text("manifest_json").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    artifactRef: text("artifact_ref").notNull().default(""),
    artifactSha256: text("artifact_sha256").notNull().default(""),
    artifactMediaType: text("artifact_media_type").notNull().default("application/json"),
    state: text("state", { enum: ["manifest_ready", "verified", "failed", "cancelled"] }).notNull(),
    lockVersion: integer("lock_version").notNull().default(1),
    failureSummary: text("failure_summary").notNull().default(""),
    createdAt: text("created_at").notNull(),
    verifiedAt: text("verified_at"),
  },
  (table) => [
    check("package_export_runs_state_check", sql`${table.state} IN ('manifest_ready','verified','failed','cancelled')`),
    uniqueIndex("idx_package_export_runs_manifest").on(table.packageId, table.manifestSha256),
    index("idx_package_export_runs_package_state").on(table.packageId, table.state, table.createdAt),
    index("idx_package_export_runs_branch_state").on(table.packageId, table.branchId, table.state, table.createdAt),
  ],
);

// Article identity is an additive overlay.  It deliberately does not replace
// immutable revisions, package history, lifecycle evidence, or the read-only
// corpus.  Mutating routes may only change the overlay and the narrowly scoped
// archive/status fields recorded by an auditable operation.
export const articleIdentities = sqliteTable(
  "article_identities",
  {
    id: text("id").primaryKey(),
    canonicalArticleId: text("canonical_article_id").notNull(),
    title: text("title").notNull().default(""),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    visibility: text("visibility", { enum: ["primary", "hidden"] }).notNull().default("primary"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("article_identities_status_check", sql`${table.status} IN ('active','archived')`),
    check("article_identities_visibility_check", sql`${table.visibility} IN ('primary','hidden')`),
    check("article_identities_lock_check", sql`${table.lockVersion} >= 1`),
    uniqueIndex("idx_article_identities_canonical_article").on(table.canonicalArticleId),
    index("idx_article_identities_status_updated").on(table.status, table.updatedAt),
  ],
);

export const articleIdentityMembers = sqliteTable(
  "article_identity_members",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id").notNull(),
    objectKind: text("object_kind", {
      enum: ["article", "branch", "revision", "package", "corpus_article", "corpus_version", "artifact"],
    }).notNull(),
    objectId: text("object_id").notNull(),
    articleId: text("article_id"),
    revisionId: text("revision_id"),
    bodySha256: text("body_sha256"),
    role: text("role", {
      enum: ["canonical", "legacy_root", "branch", "revision", "adaptation", "source", "auxiliary", "owner_repair"],
    }).notNull(),
    state: text("state", { enum: ["active", "superseded", "archived"] }).notNull().default("active"),
    hiddenFromPrimary: integer("hidden_from_primary", { mode: "boolean" }).notNull().default(false),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    inputSha256: text("input_sha256").notNull(),
    operationId: text("operation_id").notNull(),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("article_identity_members_kind_check", sql`${table.objectKind} IN ('article','branch','revision','package','corpus_article','corpus_version','artifact')`),
    check("article_identity_members_role_check", sql`${table.role} IN ('canonical','legacy_root','branch','revision','adaptation','source','auxiliary','owner_repair')`),
    check("article_identity_members_state_check", sql`${table.state} IN ('active','superseded','archived')`),
    check("article_identity_members_sha_check", sql`${table.bodySha256} IS NULL OR (length(${table.bodySha256}) = 64 AND ${table.bodySha256} NOT GLOB '*[^0-9a-f]*')`),
    check("article_identity_members_input_sha_check", sql`length(${table.inputSha256}) = 64 AND ${table.inputSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_identity_members_lock_check", sql`${table.lockVersion} >= 1`),
    uniqueIndex("idx_article_identity_members_object").on(table.objectKind, table.objectId),
    index("idx_article_identity_members_identity_state").on(table.identityId, table.state, table.objectKind),
    index("idx_article_identity_members_article").on(table.articleId, table.state),
    index("idx_article_identity_members_operation").on(table.operationId),
  ],
);

export const articleLineageLinks = sqliteTable(
  "article_lineage_links",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id"),
    relationType: text("relation_type").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceArticleId: text("source_article_id"),
    sourceRevisionId: text("source_revision_id"),
    sourceBodySha256: text("source_body_sha256"),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    targetArticleId: text("target_article_id"),
    targetRevisionId: text("target_revision_id"),
    targetBodySha256: text("target_body_sha256"),
    status: text("status", { enum: ["candidate", "confirmed", "rejected", "superseded"] }).notNull().default("candidate"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    inputSha256: text("input_sha256").notNull(),
    operationId: text("operation_id").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("article_lineage_links_status_check", sql`${table.status} IN ('candidate','confirmed','rejected','superseded')`),
    check("article_lineage_links_source_sha_check", sql`${table.sourceBodySha256} IS NULL OR (length(${table.sourceBodySha256}) = 64 AND ${table.sourceBodySha256} NOT GLOB '*[^0-9a-f]*')`),
    check("article_lineage_links_target_sha_check", sql`${table.targetBodySha256} IS NULL OR (length(${table.targetBodySha256}) = 64 AND ${table.targetBodySha256} NOT GLOB '*[^0-9a-f]*')`),
    check("article_lineage_links_input_sha_check", sql`length(${table.inputSha256}) = 64 AND ${table.inputSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_lineage_links_lock_check", sql`${table.lockVersion} >= 1`),
    uniqueIndex("idx_article_lineage_links_relation").on(table.relationType, table.sourceKind, table.sourceId, table.targetKind, table.targetId),
    index("idx_article_lineage_links_identity_status").on(table.identityId, table.status, table.updatedAt),
    index("idx_article_lineage_links_operation").on(table.operationId),
    index("idx_article_lineage_links_articles").on(table.sourceArticleId, table.targetArticleId),
  ],
);

export const articleIdentityOperations = sqliteTable(
  "article_identity_operations",
  {
    id: text("id").primaryKey(),
    operationKind: text("operation_kind", { enum: ["candidate_scan", "consolidation", "source_owner_repair", "candidate_decision"] }).notNull(),
    status: text("status", { enum: ["planned", "applied", "rolled_back"] }).notNull().default("planned"),
    identityId: text("identity_id"),
    commandId: text("command_id").notNull(),
    actorId: text("actor_id").notNull(),
    appliedBy: text("applied_by"),
    rolledBackBy: text("rolled_back_by"),
    planJson: text("plan_json").notNull(),
    planSha256: text("plan_sha256").notNull(),
    preconditionsJson: text("preconditions_json").notNull(),
    preconditionsSha256: text("preconditions_sha256").notNull(),
    inverseJson: text("inverse_json").notNull(),
    resultJson: text("result_json").notNull().default("{}"),
    sentinel: text("sentinel").notNull(),
    lockVersion: integer("lock_version").notNull().default(1),
    plannedAt: text("planned_at").notNull(),
    appliedAt: text("applied_at"),
    rolledBackAt: text("rolled_back_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("article_identity_operations_kind_check", sql`${table.operationKind} IN ('candidate_scan','consolidation','source_owner_repair','candidate_decision')`),
    check("article_identity_operations_status_check", sql`${table.status} IN ('planned','applied','rolled_back')`),
    check("article_identity_operations_plan_sha_check", sql`length(${table.planSha256}) = 64 AND ${table.planSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_identity_operations_precondition_sha_check", sql`length(${table.preconditionsSha256}) = 64 AND ${table.preconditionsSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_identity_operations_lock_check", sql`${table.lockVersion} >= 1`),
    uniqueIndex("idx_article_identity_operations_command").on(table.commandId),
    uniqueIndex("idx_article_identity_operations_sentinel").on(table.sentinel),
    index("idx_article_identity_operations_identity_status").on(table.identityId, table.status, table.updatedAt),
  ],
);

export const managementBootstrapChallenges = sqliteTable(
  "management_bootstrap_challenges",
  {
    id: text("id").primaryKey(),
    pairingSha256: text("pairing_sha256").notNull(),
    status: text("status", { enum: ["active", "consumed", "locked", "expired"] }).notNull().default("active"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    consumedSessionId: text("consumed_session_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("management_bootstrap_status_check", sql`${table.status} IN ('active','consumed','locked','expired')`),
    uniqueIndex("idx_management_bootstrap_pairing_sha").on(table.pairingSha256),
    index("idx_management_bootstrap_status_expiry").on(table.status, table.expiresAt),
  ],
);

export const managementSessions = sqliteTable(
  "management_sessions",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id").notNull(),
    tokenSha256: text("token_sha256").notNull(),
    browserBindingSha256: text("browser_binding_sha256").notNull(),
    trustedDeviceId: text("trusted_device_id"),
    authBasis: text("auth_basis", { enum: ["owner_pairing", "trusted_device", "site_full_control_key"] }).notNull().default("owner_pairing"),
    authorityClass: text("authority_class").notNull().default("owner"),
    sourceClientId: text("source_client_id"),
    sourceKeyExpiresAt: text("source_key_expires_at"),
    sourceExchangeGeneration: integer("source_exchange_generation"),
    sourcePermissionSnapshotSha256: text("source_permission_snapshot_sha256"),
    scopesJson: text("scopes_json").notNull().default("[]"),
    articleIdsJson: text("article_ids_json").notNull().default("[]"),
    objectBoundaryJson: text("object_boundary_json").notNull().default("{}"),
    status: text("status", { enum: ["active", "revoked", "expired"] }).notNull().default("active"),
    absoluteExpiresAt: text("absolute_expires_at").notNull(),
    idleExpiresAt: text("idle_expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
    revokeReason: text("revoke_reason").notNull().default(""),
  },
  (table) => [
    check("management_sessions_status_check", sql`${table.status} IN ('active','revoked','expired')`),
    uniqueIndex("idx_management_sessions_token_sha").on(table.tokenSha256),
    index("idx_management_sessions_principal_status").on(table.principalId, table.status, table.absoluteExpiresAt),
    index("idx_management_sessions_expiry").on(table.status, table.idleExpiresAt, table.absoluteExpiresAt),
    index("idx_management_sessions_trusted_device").on(table.trustedDeviceId, table.status, table.createdAt),
    index("idx_management_sessions_source_client").on(table.sourceClientId, table.status, table.sourceExchangeGeneration),
  ],
);

export const managementBrowserDevices = sqliteTable(
  "management_browser_devices",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id").notNull(),
    publicKeyJwkJson: text("public_key_jwk_json").notNull(),
    publicKeySha256: text("public_key_sha256").notNull(),
    browserBindingSha256: text("browser_binding_sha256").notNull(),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    enrolledSessionId: text("enrolled_session_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    revokeReason: text("revoke_reason").notNull().default(""),
  },
  (table) => [
    check("management_browser_devices_status_check", sql`${table.status} IN ('active','revoked')`),
    uniqueIndex("idx_management_browser_devices_public_key").on(table.publicKeySha256),
    index("idx_management_browser_devices_binding_status").on(table.browserBindingSha256, table.status, table.updatedAt),
  ],
);

export const managementDeviceChallenges = sqliteTable(
  "management_device_challenges",
  {
    id: text("id").primaryKey(),
    bootId: text("boot_id").notNull(),
    deviceId: text("device_id").notNull(),
    nonceSha256: text("nonce_sha256").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    browserBindingSha256: text("browser_binding_sha256").notNull(),
    status: text("status", { enum: ["active", "consumed", "locked", "expired"] }).notNull().default("active"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    consumedSessionId: text("consumed_session_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("management_device_challenges_status_check", sql`${table.status} IN ('active','consumed','locked','expired')`),
    uniqueIndex("idx_management_device_challenges_nonce").on(table.nonceSha256),
    uniqueIndex("idx_management_device_challenges_payload").on(table.payloadSha256),
    index("idx_management_device_challenges_device_status").on(table.deviceId, table.status, table.expiresAt),
    index("idx_management_device_challenges_boot_status").on(table.bootId, table.status, table.expiresAt),
  ],
);

export const managementAuthEvents = sqliteTable(
  "management_auth_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    principalId: text("principal_id"),
    sessionId: text("session_id"),
    outcome: text("outcome", { enum: ["accepted", "rejected", "expired", "revoked"] }).notNull(),
    requestId: text("request_id").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("management_auth_events_outcome_check", sql`${table.outcome} IN ('accepted','rejected','expired','revoked')`),
    index("idx_management_auth_events_created").on(table.createdAt),
    index("idx_management_auth_events_session").on(table.sessionId, table.createdAt),
  ],
);

export const metaSkillVersions = sqliteTable(
  "meta_skill_versions",
  {
    id: text("id").primaryKey(),
    skillKey: text("skill_key").notNull(),
    version: text("version").notNull(),
    role: text("role", { enum: ["proposer", "execution", "reviewer", "orchestrator"] }).notNull(),
    parentVersionId: text("parent_version_id"),
    promptText: text("prompt_text").notNull(),
    promptSha256: text("prompt_sha256").notNull(),
    contractJson: text("contract_json").notNull().default("{}"),
    contractSha256: text("contract_sha256").notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdByKind: text("created_by_kind", { enum: ["human", "model", "system"] }).notNull(),
    createdByProvider: text("created_by_provider", { enum: ["deepseek", "qwen", "openai", "ollama"] }),
    sourceInvocationId: text("source_invocation_id"),
    isCandidate: integer("is_candidate", { mode: "boolean" }).notNull().default(true),
    status: text("status", { enum: ["candidate", "adopted", "superseded", "rejected"] }).notNull().default("candidate"),
    decisionExperimentId: text("decision_experiment_id"),
    activatedAt: text("activated_at"),
    decidedAt: text("decided_at"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("meta_skill_versions_role_check", sql`${table.role} IN ('proposer','execution','reviewer','orchestrator')`),
    check("meta_skill_versions_creator_check", sql`${table.createdByKind} IN ('human','model','system')`),
    check("meta_skill_versions_provider_check", sql`${table.createdByProvider} IS NULL OR ${table.createdByProvider} IN ('deepseek','qwen','openai','ollama')`),
    check("meta_skill_versions_model_candidate_check", sql`${table.createdByKind} <> 'model' OR ${table.isCandidate} = 1`),
    check("meta_skill_versions_status_check", sql`${table.status} IN ('candidate','adopted','superseded','rejected')`),
    check("meta_skill_versions_lock_check", sql`${table.lockVersion} >= 1`),
    check("meta_skill_versions_decision_check", sql`${table.status} = 'candidate' OR (${table.decisionExperimentId} IS NOT NULL AND ${table.decidedAt} IS NOT NULL)`),
    check("meta_skill_versions_activation_check", sql`${table.status} <> 'adopted' OR ${table.activatedAt} IS NOT NULL`),
    uniqueIndex("idx_meta_skill_versions_key_version").on(table.skillKey, table.version),
    uniqueIndex("idx_meta_skill_versions_key_content").on(table.skillKey, table.contentSha256),
    uniqueIndex("idx_meta_skill_versions_active_key").on(table.skillKey).where(sql`${table.status} = 'adopted'`),
    index("idx_meta_skill_versions_key_created").on(table.skillKey, table.createdAt),
    index("idx_meta_skill_versions_parent").on(table.parentVersionId, table.createdAt),
  ],
);

// The activation row is the CAS authority for runtime prompt selection. Version
// status remains an immutable-history/display concern and must not be used as
// the concurrent active-version pointer.
export const metaSkillActivations = sqliteTable(
  "meta_skill_activations",
  {
    skillKey: text("skill_key").primaryKey(),
    activeVersionId: text("active_version_id").notNull(),
    lockVersion: integer("lock_version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
    decisionExperimentId: text("decision_experiment_id").notNull(),
  },
  (table) => [
    check("meta_skill_activations_lock_check", sql`${table.lockVersion} >= 1`),
    uniqueIndex("idx_meta_skill_activations_active_version").on(table.activeVersionId),
    index("idx_meta_skill_activations_experiment").on(table.decisionExperimentId, table.updatedAt),
  ],
);

export const metaImprovementExperiments = sqliteTable(
  "meta_improvement_experiments",
  {
    id: text("id").primaryKey(),
    targetSkillKey: text("target_skill_key").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    hypothesis: text("hypothesis").notNull(),
    baselineVersionId: text("baseline_version_id").notNull(),
    baselineContentSha256: text("baseline_content_sha256").notNull(),
    candidateVersionId: text("candidate_version_id"),
    casesJson: text("cases_json").notNull(),
    casesSha256: text("cases_sha256").notNull(),
    holdoutCasesJson: text("holdout_cases_json").notNull(),
    holdoutCasesSha256: text("holdout_cases_sha256").notNull(),
    providerPolicyJson: text("provider_policy_json").notNull(),
    providerPolicySha256: text("provider_policy_sha256").notNull(),
    budgetJson: text("budget_json").notNull(),
    budgetSha256: text("budget_sha256").notNull(),
    evaluationContractJson: text("evaluation_contract_json").notNull(),
    evaluationContractSha256: text("evaluation_contract_sha256").notNull(),
    frozenInputSha256: text("frozen_input_sha256").notNull(),
    proposerInvocationId: text("proposer_invocation_id"),
    reviewerInvocationId: text("reviewer_invocation_id"),
    state: text("state", {
      enum: ["draft", "baselined", "generating", "candidate_ready", "evaluating", "awaiting_human", "blocked", "completed", "failed", "cancelled"],
    }).notNull().default("draft"),
    decision: text("decision", { enum: ["pending", "adopt", "reject", "defer", "rollback"] }).notNull().default("pending"),
    humanDecisionNote: text("human_decision_note").notNull().default(""),
    humanDecidedBy: text("human_decided_by"),
    humanDecidedAt: text("human_decided_at"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    check("meta_improvement_experiments_state_check", sql`${table.state} IN ('draft','baselined','generating','candidate_ready','evaluating','awaiting_human','blocked','completed','failed','cancelled')`),
    check("meta_improvement_experiments_decision_check", sql`${table.decision} IN ('pending','adopt','reject','defer','rollback')`),
    check("meta_improvement_experiments_lock_check", sql`${table.lockVersion} >= 1`),
    check("meta_improvement_experiments_human_decision_check", sql`${table.decision} = 'pending' OR (${table.humanDecidedBy} IS NOT NULL AND length(trim(${table.humanDecisionNote})) > 0)`),
    index("idx_meta_improvement_experiments_target_state").on(table.targetSkillKey, table.state, table.updatedAt),
    index("idx_meta_improvement_experiments_baseline").on(table.baselineVersionId, table.createdAt),
    index("idx_meta_improvement_experiments_candidate").on(table.candidateVersionId, table.createdAt),
  ],
);

export const modelInvocations = sqliteTable(
  "model_invocations",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id"),
    lineageCandidateId: text("lineage_candidate_id"),
    lineagePreparationId: text("lineage_preparation_id"),
    commandId: text("command_id").notNull(),
    purpose: text("purpose", { enum: ["provider_probe", "meta_experiment", "lineage_review"] }).notNull(),
    role: text("role", { enum: ["probe", "proposer", "execution", "reviewer"] }).notNull(),
    provider: text("provider", { enum: ["deepseek", "qwen", "openai", "ollama"] }).notNull(),
    modelId: text("model_id").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    promptVersionId: text("prompt_version_id"),
    providerPolicySha256: text("provider_policy_sha256"),
    egressManifestSha256: text("egress_manifest_sha256").notNull(),
    egressApprovalSha256: text("egress_approval_sha256").notNull(),
    requestSha256: text("request_sha256").notNull(),
    inputSha256: text("input_sha256").notNull(),
    responseSha256: text("response_sha256"),
    outputRef: text("output_ref").notNull().default(""),
    state: text("state", { enum: ["queued", "running", "succeeded", "failed", "inconclusive", "cancelled"] }).notNull().default("queued"),
    attempt: integer("attempt").notNull().default(1),
    budgetReservationJson: text("budget_reservation_json").notNull().default("{}"),
    budgetReservationSha256: text("budget_reservation_sha256").notNull(),
    usageJson: text("usage_json").notNull().default("{}"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    estimatedCostCnyMicros: integer("estimated_cost_cny_micros"),
    latencyMs: integer("latency_ms"),
    httpStatus: integer("http_status"),
    finishReason: text("finish_reason"),
    providerRequestId: text("provider_request_id"),
    errorClass: text("error_class"),
    errorSummary: text("error_summary"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    check("model_invocations_purpose_check", sql`${table.purpose} IN ('provider_probe','meta_experiment','lineage_review')`),
    check("model_invocations_role_check", sql`${table.role} IN ('probe','proposer','execution','reviewer')`),
    check("model_invocations_purpose_role_check", sql`(${table.purpose} = 'provider_probe' AND ${table.role} = 'probe') OR (${table.purpose} = 'meta_experiment' AND ${table.role} IN ('proposer','execution','reviewer')) OR (${table.purpose} = 'lineage_review' AND ${table.role} = 'reviewer' AND ${table.provider} = 'deepseek')`),
    check("model_invocations_experiment_binding_check", sql`${table.purpose} = 'provider_probe' OR (${table.purpose} = 'meta_experiment' AND ${table.experimentId} IS NOT NULL AND ${table.promptVersionId} IS NOT NULL AND ${table.providerPolicySha256} IS NOT NULL) OR (${table.purpose} = 'lineage_review' AND ${table.experimentId} IS NULL AND ${table.lineageCandidateId} IS NOT NULL AND ${table.lineagePreparationId} IS NOT NULL AND ${table.promptVersionId} IS NOT NULL AND ${table.providerPolicySha256} IS NOT NULL)`),
    check("model_invocations_lineage_binding_check", sql`(${table.purpose} = 'lineage_review' AND ${table.lineageCandidateId} IS NOT NULL AND ${table.lineagePreparationId} IS NOT NULL) OR (${table.purpose} <> 'lineage_review' AND ${table.lineageCandidateId} IS NULL AND ${table.lineagePreparationId} IS NULL)`),
    check("model_invocations_provider_check", sql`${table.provider} IN ('deepseek','qwen','openai','ollama')`),
    check("model_invocations_state_check", sql`${table.state} IN ('queued','running','succeeded','failed','inconclusive','cancelled')`),
    check("model_invocations_attempt_check", sql`${table.attempt} >= 1`),
    check("model_invocations_usage_check", sql`(${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0) AND (${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0) AND (${table.totalTokens} IS NULL OR ${table.totalTokens} >= 0) AND (${table.estimatedCostCnyMicros} IS NULL OR ${table.estimatedCostCnyMicros} >= 0)`),
    check("model_invocations_transport_check", sql`(${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0) AND (${table.httpStatus} IS NULL OR (${table.httpStatus} >= 100 AND ${table.httpStatus} <= 599))`),
    uniqueIndex("idx_model_invocations_command").on(table.commandId),
    index("idx_model_invocations_experiment_role").on(table.experimentId, table.role, table.createdAt),
    index("idx_model_invocations_purpose_state").on(table.purpose, table.state, table.createdAt),
    index("idx_model_invocations_provider_state").on(table.provider, table.state, table.createdAt),
    index("idx_model_invocations_lineage_candidate").on(table.lineageCandidateId, table.createdAt),
  ],
);

// A provider response is checkpointed here before any candidate/evaluation
// materialization begins. The invocation primary key makes the checkpoint
// idempotent, while the lease + lock fields let a crashed local materializer
// be recovered without paying for the same model response again.
export const modelInvocationOutputs = sqliteTable(
  "model_invocation_outputs",
  {
    invocationId: text("invocation_id").primaryKey(),
    materializationKind: text("materialization_kind", {
      enum: ["probe", "candidate", "evaluation", "review"],
    }).notNull(),
    responseJson: text("response_json").notNull(),
    responseSha256: text("response_sha256").notNull(),
    usageJson: text("usage_json").notNull().default("{}"),
    usageSha256: text("usage_sha256").notNull(),
    materializationState: text("materialization_state", {
      enum: ["checkpointed", "materializing", "materialized", "blocked"],
    }).notNull().default("checkpointed"),
    materializationRef: text("materialization_ref").notNull().default(""),
    materializationLeaseOwner: text("materialization_lease_owner"),
    materializationLeaseExpiresAt: text("materialization_lease_expires_at"),
    materializationAttempts: integer("materialization_attempts").notNull().default(0),
    materializationLockVersion: integer("materialization_lock_version").notNull().default(1),
    lastErrorClass: text("last_error_class"),
    lastErrorSummary: text("last_error_summary"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    materializedAt: text("materialized_at"),
  },
  (table) => [
    check("model_invocation_outputs_kind_check", sql`${table.materializationKind} IN ('probe','candidate','evaluation','review')`),
    check("model_invocation_outputs_state_check", sql`${table.materializationState} IN ('checkpointed','materializing','materialized','blocked')`),
    check("model_invocation_outputs_response_json_check", sql`json_valid(${table.responseJson}) AND json_type(${table.responseJson}) = 'object' AND length(CAST(${table.responseJson} AS BLOB)) BETWEEN 2 AND 262144`),
    check("model_invocation_outputs_usage_json_check", sql`json_valid(${table.usageJson}) AND json_type(${table.usageJson}) = 'object' AND length(CAST(${table.usageJson} AS BLOB)) BETWEEN 2 AND 8192`),
    check("model_invocation_outputs_response_sha_check", sql`length(${table.responseSha256}) = 64 AND ${table.responseSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("model_invocation_outputs_usage_sha_check", sql`length(${table.usageSha256}) = 64 AND ${table.usageSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("model_invocation_outputs_attempt_check", sql`${table.materializationAttempts} >= 0 AND ${table.materializationLockVersion} >= 1`),
    check("model_invocation_outputs_ref_check", sql`length(CAST(${table.materializationRef} AS BLOB)) <= 512`),
    check("model_invocation_outputs_error_check", sql`(${table.lastErrorClass} IS NULL OR length(CAST(${table.lastErrorClass} AS BLOB)) BETWEEN 1 AND 80) AND (${table.lastErrorSummary} IS NULL OR length(CAST(${table.lastErrorSummary} AS BLOB)) BETWEEN 1 AND 512)`),
    check("model_invocation_outputs_lease_check", sql`(${table.materializationState} = 'materializing' AND ${table.materializationLeaseOwner} IS NOT NULL AND length(trim(${table.materializationLeaseOwner})) > 0 AND ${table.materializationLeaseExpiresAt} IS NOT NULL) OR (${table.materializationState} <> 'materializing' AND ${table.materializationLeaseOwner} IS NULL AND ${table.materializationLeaseExpiresAt} IS NULL)`),
    check("model_invocation_outputs_materialized_check", sql`(${table.materializationState} = 'materialized' AND ${table.materializedAt} IS NOT NULL AND (${table.materializationKind} = 'probe' OR length(trim(${table.materializationRef})) > 0)) OR (${table.materializationState} <> 'materialized' AND ${table.materializedAt} IS NULL)`),
    index("idx_model_invocation_outputs_state_updated").on(table.materializationState, table.updatedAt),
  ],
);

// A free preparation freezes only identity/revision digests, titles,
// deterministic similarity signals and a bounded diff summary. Full article
// bodies never enter this table or the provider request.
export const articleLineageReviewPreparations = sqliteTable(
  "article_lineage_review_preparations",
  {
    id: text("id").primaryKey(),
    candidateId: text("candidate_id").notNull(),
    candidateLockVersion: integer("candidate_lock_version").notNull(),
    candidateInputSha256: text("candidate_input_sha256").notNull(),
    sourceRevisionId: text("source_revision_id").notNull(),
    sourceBodySha256: text("source_body_sha256").notNull(),
    targetRevisionId: text("target_revision_id").notNull(),
    targetBodySha256: text("target_body_sha256").notNull(),
    frozenInputJson: text("frozen_input_json").notNull(),
    inputSha256: text("input_sha256").notNull(),
    inputTokenEstimate: integer("input_token_estimate").notNull(),
    budgetEstimateJson: text("budget_estimate_json").notNull(),
    state: text("state", { enum: ["prepared", "consumed", "superseded"] }).notNull().default("prepared"),
    lockVersion: integer("lock_version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("article_lineage_review_preparations_candidate_lock_check", sql`${table.candidateLockVersion} >= 1`),
    check("article_lineage_review_preparations_candidate_sha_check", sql`length(${table.candidateInputSha256}) = 64 AND ${table.candidateInputSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_lineage_review_preparations_source_sha_check", sql`length(${table.sourceBodySha256}) = 64 AND ${table.sourceBodySha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_lineage_review_preparations_target_sha_check", sql`length(${table.targetBodySha256}) = 64 AND ${table.targetBodySha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_lineage_review_preparations_input_sha_check", sql`length(${table.inputSha256}) = 64 AND ${table.inputSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_lineage_review_preparations_input_json_check", sql`json_valid(${table.frozenInputJson}) AND json_type(${table.frozenInputJson}) = 'object' AND length(CAST(${table.frozenInputJson} AS BLOB)) BETWEEN 2 AND 131072`),
    check("article_lineage_review_preparations_budget_json_check", sql`json_valid(${table.budgetEstimateJson}) AND json_type(${table.budgetEstimateJson}) = 'object' AND length(CAST(${table.budgetEstimateJson} AS BLOB)) BETWEEN 2 AND 8192`),
    check("article_lineage_review_preparations_token_check", sql`${table.inputTokenEstimate} BETWEEN 1 AND 64000`),
    check("article_lineage_review_preparations_state_check", sql`${table.state} IN ('prepared','consumed','superseded')`),
    check("article_lineage_review_preparations_lock_check", sql`${table.lockVersion} >= 1`),
    uniqueIndex("idx_lineage_review_preparation_input").on(table.candidateId, table.inputSha256),
    index("idx_lineage_review_preparation_state").on(table.state, table.updatedAt),
  ],
);

// Provider output remains a candidate artifact. There is intentionally no
// adopted/confirmed state and no mutation pointer to the article body.
export const articleLineageModelReviews = sqliteTable(
  "article_lineage_model_reviews",
  {
    id: text("id").primaryKey(),
    preparationId: text("preparation_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    candidateLockVersion: integer("candidate_lock_version").notNull(),
    inputSha256: text("input_sha256").notNull(),
    invocationId: text("invocation_id").notNull(),
    provider: text("provider", { enum: ["deepseek"] }).notNull(),
    modelId: text("model_id").notNull(),
    outputSchemaVersion: text("output_schema_version").notNull(),
    outputJson: text("output_json").notNull(),
    outputSha256: text("output_sha256").notNull(),
    relationRecommendation: text("relation_recommendation", {
      enum: ["same_root", "version_of", "adaptation_of", "split_from", "reference_only", "not_related", "inconclusive"],
    }).notNull(),
    confidenceMicros: integer("confidence_micros").notNull(),
    candidateOnly: integer("candidate_only", { mode: "boolean" }).notNull().default(true),
    state: text("state", { enum: ["candidate", "superseded"] }).notNull().default("candidate"),
    maxInputTokens: integer("max_input_tokens").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    maxCostCnyMicros: integer("max_cost_cny_micros").notNull(),
    reservedCostCnyMicros: integer("reserved_cost_cny_micros").notNull(),
    usageJson: text("usage_json").notNull().default("{}"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("article_lineage_model_reviews_candidate_lock_check", sql`${table.candidateLockVersion} >= 1`),
    check("article_lineage_model_reviews_input_sha_check", sql`length(${table.inputSha256}) = 64 AND ${table.inputSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_lineage_model_reviews_output_sha_check", sql`length(${table.outputSha256}) = 64 AND ${table.outputSha256} NOT GLOB '*[^0-9a-f]*'`),
    check("article_lineage_model_reviews_provider_check", sql`${table.provider} = 'deepseek'`),
    check("article_lineage_model_reviews_output_json_check", sql`json_valid(${table.outputJson}) AND json_type(${table.outputJson}) = 'object' AND length(CAST(${table.outputJson} AS BLOB)) BETWEEN 2 AND 32768`),
    check("article_lineage_model_reviews_relation_check", sql`${table.relationRecommendation} IN ('same_root','version_of','adaptation_of','split_from','reference_only','not_related','inconclusive')`),
    check("article_lineage_model_reviews_confidence_check", sql`${table.confidenceMicros} BETWEEN 0 AND 1000000`),
    check("article_lineage_model_reviews_candidate_only_check", sql`${table.candidateOnly} = 1`),
    check("article_lineage_model_reviews_state_check", sql`${table.state} IN ('candidate','superseded')`),
    check("article_lineage_model_reviews_input_token_check", sql`${table.maxInputTokens} BETWEEN 1 AND 64000`),
    check("article_lineage_model_reviews_output_token_check", sql`${table.maxOutputTokens} BETWEEN 128 AND 4096`),
    check("article_lineage_model_reviews_cost_check", sql`${table.maxCostCnyMicros} BETWEEN 1 AND 100000000 AND ${table.reservedCostCnyMicros} >= 0`),
    check("article_lineage_model_reviews_usage_json_check", sql`json_valid(${table.usageJson}) AND json_type(${table.usageJson}) = 'object' AND length(CAST(${table.usageJson} AS BLOB)) BETWEEN 2 AND 8192`),
    uniqueIndex("idx_lineage_model_reviews_invocation").on(table.invocationId),
    uniqueIndex("idx_lineage_model_reviews_preparation").on(table.preparationId),
    index("idx_lineage_model_reviews_candidate").on(table.candidateId, table.state, table.createdAt),
  ],
);

export const metaImprovementEvaluations = sqliteTable(
  "meta_improvement_evaluations",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id").notNull(),
    pairId: text("pair_id").notNull(),
    caseId: text("case_id").notNull(),
    arm: text("arm", { enum: ["baseline", "candidate", "pair"] }).notNull(),
    versionId: text("version_id"),
    evaluatorKind: text("evaluator_kind", { enum: ["deterministic", "model", "human"] }).notNull(),
    evaluatorKey: text("evaluator_key").notNull(),
    provider: text("provider", { enum: ["deepseek", "qwen", "openai", "ollama"] }),
    modelId: text("model_id"),
    invocationId: text("invocation_id"),
    result: text("result", { enum: ["pass", "fail", "inconclusive"] }).notNull(),
    contractSha256: text("contract_sha256").notNull(),
    inputSha256: text("input_sha256").notNull(),
    outputSha256: text("output_sha256").notNull(),
    signalsJson: text("signals_json").notNull().default("[]"),
    signalsSha256: text("signals_sha256").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    evidenceSha256: text("evidence_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("meta_improvement_evaluations_arm_check", sql`${table.arm} IN ('baseline','candidate','pair')`),
    check("meta_improvement_evaluations_kind_check", sql`${table.evaluatorKind} IN ('deterministic','model','human')`),
    check("meta_improvement_evaluations_provider_check", sql`${table.provider} IS NULL OR ${table.provider} IN ('deepseek','qwen','openai','ollama')`),
    check("meta_improvement_evaluations_result_check", sql`${table.result} IN ('pass','fail','inconclusive')`),
    check("meta_improvement_evaluations_model_provider_check", sql`${table.evaluatorKind} <> 'model' OR ${table.provider} IS NOT NULL`),
    uniqueIndex("idx_meta_improvement_evaluations_identity").on(
      table.experimentId,
      table.pairId,
      table.arm,
      table.evaluatorKey,
      table.inputSha256,
    ),
    index("idx_meta_improvement_evaluations_experiment_result").on(table.experimentId, table.result, table.createdAt),
    index("idx_meta_improvement_evaluations_case").on(table.experimentId, table.caseId, table.createdAt),
  ],
);

export const metaImprovementEvents = sqliteTable(
  "meta_improvement_events",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id").notNull(),
    eventType: text("event_type").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    actorKind: text("actor_kind", { enum: ["human", "model", "system"] }).notNull(),
    actorId: text("actor_id").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    inputSha256: text("input_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("meta_improvement_events_actor_check", sql`${table.actorKind} IN ('human','model','system')`),
    index("idx_meta_improvement_events_experiment_created").on(table.experimentId, table.createdAt),
  ],
);

// Release Control V2 is deliberately separate from the legacy publish capability
// tables.  Its rows bind a single, short-lived, auditable release path.
export const releaseReadinessSnapshots = sqliteTable(
  "release_readiness_snapshots",
  {
    id: text("id").primaryKey(), articleId: text("article_id").notNull(), runId: text("run_id").notNull(),
    releaseId: text("release_id").notNull(), buildId: text("build_id").notNull(), platform: text("platform").notNull(),
    artifactSha256: text("artifact_sha256").notNull(), targetAccount: text("target_account").notNull(),
    publicationVersionSha256: text("publication_version_sha256").notNull(), profileSha256: text("profile_sha256").notNull(),
    contractSha256: text("contract_sha256").notNull(), prepareReceiptHeadSha256: text("prepare_receipt_head_sha256").notNull(),
    domContractSha256: text("dom_contract_sha256").notNull(), snapshotSha256: text("snapshot_sha256").notNull().unique(),
    state: text("state").notNull().default("ready_to_submit"), createdAt: text("created_at").notNull(), expiresAt: text("expires_at").notNull(),
    staleReason: text("stale_reason"), revokedAt: text("revoked_at"),
  },
  (table) => [
    check("release_readiness_snapshots_platform_check", sql`${table.platform} IN ('xiaohongshu','maimai','zhihu','bilibili')`),
    check("release_readiness_snapshots_state_check", sql`${table.state} IN ('ready_to_submit','stale','revoked')`),
    check("release_readiness_snapshots_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    index("idx_release_readiness_snapshots_release_state_expiry").on(table.releaseId, table.state, table.expiresAt),
  ],
);

export const articlePublishConfirmations = sqliteTable(
  "article_publish_confirmations",
  {
    id: text("id").primaryKey(), articleId: text("article_id").notNull(), runId: text("run_id").notNull(),
    contractSha256: text("contract_sha256").notNull(), ownerSessionId: text("owner_session_id").notNull(),
    itemSetSha256: text("item_set_sha256").notNull(), confirmationSha256: text("confirmation_sha256").notNull().unique(),
    state: text("state").notNull().default("confirmed"), confirmedAt: text("confirmed_at").notNull(), expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"), createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("article_publish_confirmations_state_check", sql`${table.state} IN ('confirmed','expired','revoked','consumed')`),
    check("article_publish_confirmations_expiry_check", sql`${table.expiresAt} > ${table.confirmedAt}`),
    index("idx_article_publish_confirmations_article_state_expiry").on(table.articleId, table.state, table.expiresAt),
  ],
);

export const articlePublishConfirmationItems = sqliteTable(
  "article_publish_confirmation_items",
  {
    id: text("id").primaryKey(), confirmationId: text("confirmation_id").notNull(), platform: text("platform").notNull(),
    releaseId: text("release_id").notNull(), buildId: text("build_id").notNull(), artifactSha256: text("artifact_sha256").notNull(),
    targetAccount: text("target_account").notNull(), readinessSnapshotSha256: text("readiness_snapshot_sha256").notNull(), createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("article_publish_confirmation_items_platform_check", sql`${table.platform} IN ('xiaohongshu','maimai','zhihu','bilibili')`),
    uniqueIndex("idx_confirmation_items_confirmation_platform").on(table.confirmationId, table.platform),
    uniqueIndex("idx_confirmation_items_confirmation_release").on(table.confirmationId, table.releaseId),
    index("idx_confirmation_items_release").on(table.releaseId, table.platform),
  ],
);

export const releasePublishCapabilitiesV2 = sqliteTable(
  "release_publish_capabilities_v2",
  {
    id: text("id").primaryKey(), confirmationId: text("confirmation_id").notNull(), articleId: text("article_id").notNull(), runId: text("run_id").notNull(), buildId: text("build_id").notNull(), releaseId: text("release_id").notNull(),
    platform: text("platform").notNull(), executionPacketJson: text("execution_packet_json").notNull(), packetJsonSha256: text("packet_json_sha256").notNull().unique(), packetSha256: text("packet_sha256").notNull().unique(), artifactSha256: text("artifact_sha256").notNull(),
    readinessSnapshotSha256: text("readiness_snapshot_sha256").notNull(), domContractSha256: text("dom_contract_sha256").notNull(), targetAccount: text("target_account").notNull(),
    nonceSha256: text("nonce_sha256").notNull().unique(), maxClicks: integer("max_clicks").notNull().default(1),
    status: text("status").notNull().default("issued"), issuedAt: text("issued_at").notNull(), expiresAt: text("expires_at").notNull(), consumedAt: text("consumed_at"),
  },
  (table) => [
    check("release_publish_capabilities_v2_platform_check", sql`${table.platform} IN ('xiaohongshu','maimai','zhihu','bilibili')`),
    check("release_publish_capabilities_v2_max_clicks_check", sql`${table.maxClicks} = 1`),
    check("release_publish_capabilities_v2_status_check", sql`${table.status} IN ('issued','leased','consumed','expired','revoked','frozen')`),
    check("release_publish_capabilities_v2_expiry_check", sql`${table.expiresAt} > ${table.issuedAt}`),
    check("release_publish_capabilities_v2_dom_contract_sha256_check", sql`length(${table.domContractSha256}) = 64 AND ${table.domContractSha256} NOT GLOB '*[^0-9A-Fa-f]*'`),
    uniqueIndex("idx_release_publish_capabilities_v2_confirmation_release").on(table.confirmationId, table.releaseId),
    index("idx_release_publish_capabilities_v2_status_expiry").on(table.status, table.expiresAt),
  ],
);

export const publishClickLeasesV2 = sqliteTable(
  "publish_click_leases_v2",
  {
    id: text("id").primaryKey(), capabilityId: text("capability_id").notNull().unique(), confirmationId: text("confirmation_id").notNull(), articleId: text("article_id").notNull(), runId: text("run_id").notNull(), buildId: text("build_id").notNull(), releaseId: text("release_id").notNull(), platform: text("platform").notNull(), targetAccount: text("target_account").notNull(), leaseTokenSha256: text("lease_token_sha256").notNull().unique(),
    receiptChainId: text("receipt_chain_id").notNull().unique(), hostId: text("host_id").notNull(), routeAttestationSha256: text("route_attestation_sha256").notNull(), domContractSha256: text("dom_contract_sha256").notNull(),
    packetSha256: text("packet_sha256").notNull(), artifactSha256: text("artifact_sha256").notNull(), readinessSnapshotSha256: text("readiness_snapshot_sha256").notNull(),
    maxClicks: integer("max_clicks").notNull().default(1), status: text("status").notNull().default("active"), issuedAt: text("issued_at").notNull(), expiresAt: text("expires_at").notNull(), consumedAt: text("consumed_at"), revokedAt: text("revoked_at"),
  },
  (table) => [
    check("publish_click_leases_v2_platform_check", sql`${table.platform} IN ('xiaohongshu','maimai','zhihu','bilibili')`),
    check("publish_click_leases_v2_max_clicks_check", sql`${table.maxClicks} = 1`),
    check("publish_click_leases_v2_status_check", sql`${table.status} IN ('active','consumed','expired','revoked','frozen')`),
    check("publish_click_leases_v2_expiry_check", sql`${table.expiresAt} > ${table.issuedAt}`),
    index("idx_publish_click_leases_v2_status_expiry").on(table.status, table.expiresAt),
  ],
);

export const publishExecutionReceiptEventsV2 = sqliteTable(
  "publish_execution_receipt_events_v2",
  {
    id: text("id").primaryKey(), receiptChainId: text("receipt_chain_id").notNull(), capabilityId: text("capability_id").notNull(), leaseId: text("lease_id").notNull(), confirmationId: text("confirmation_id").notNull(), articleId: text("article_id").notNull(), runId: text("run_id").notNull(), buildId: text("build_id").notNull(), releaseId: text("release_id").notNull(), platform: text("platform").notNull(), targetAccount: text("target_account").notNull(), domContractSha256: text("dom_contract_sha256").notNull(),
    sequence: integer("sequence").notNull(), previousEventSha256: text("previous_event_sha256"), eventSha256: text("event_sha256").notNull().unique(),
    eventType: text("event_type").notNull(), hostId: text("host_id").notNull(), hostInvocationId: text("host_invocation_id").notNull().unique(),
    packetSha256: text("packet_sha256").notNull(), artifactSha256: text("artifact_sha256").notNull(), readinessSnapshotSha256: text("readiness_snapshot_sha256").notNull(),
    resultJson: text("result_json").notNull().default("{}"), evidenceJson: text("evidence_json").notNull().default("{}"),
    writeDisposition: text("write_disposition").notNull(), recoveryMode: text("recovery_mode").notNull(), observedAt: text("observed_at").notNull(), createdAt: text("created_at").notNull(), serverSha256: text("server_sha256").notNull(), signatureSha256: text("signature_sha256").notNull(),
  },
  (table) => [
    check("publish_execution_receipt_events_v2_platform_check", sql`${table.platform} IN ('xiaohongshu','maimai','zhihu','bilibili')`),
    check("publish_execution_receipt_events_v2_type_check", sql`${table.eventType} IN ('capability_consumed','click_invocation_started','click_invoked','click_not_invoked','result_unknown','read_only_probe')`),
    check("publish_execution_receipt_events_v2_disposition_check", sql`${table.writeDisposition} IN ('continue','freeze_writes','stop_writes')`),
    check("publish_execution_receipt_events_v2_recovery_check", sql`${table.recoveryMode} IN ('none','probe_first')`),
    uniqueIndex("idx_receipt_events_v2_chain_sequence").on(table.receiptChainId, table.sequence),
    uniqueIndex("idx_receipt_events_v2_capability_sequence").on(table.capabilityId, table.sequence),
    index("idx_receipt_events_v2_capability_created").on(table.capabilityId, table.createdAt),
  ],
);

export const releaseExternalActionFreezesV2 = sqliteTable(
  "release_external_action_freezes_v2",
  {
    releaseId: text("release_id").primaryKey(), reason: text("reason").notNull(), status: text("status").notNull().default("frozen"),
    capabilityId: text("capability_id"), leaseId: text("lease_id"), frozenAt: text("frozen_at").notNull(), clearedAt: text("cleared_at"), clearedBy: text("cleared_by"),
  },
  (table) => [check("release_external_action_freezes_v2_status_check", sql`${table.status} IN ('frozen','cleared')`)],
);

export const releaseAuthoritativeReadbacksV2 = sqliteTable(
  "release_authoritative_readbacks_v2",
  {
    id: text("id").primaryKey(), releaseId: text("release_id").notNull(), capabilityId: text("capability_id"), leaseId: text("lease_id"), confirmationId: text("confirmation_id").notNull(), articleId: text("article_id").notNull(), runId: text("run_id").notNull(), buildId: text("build_id").notNull(), platform: text("platform").notNull(), targetAccount: text("target_account").notNull(), domContractSha256: text("dom_contract_sha256").notNull(), hostId: text("host_id").notNull(),
    receiptChainId: text("receipt_chain_id"), packetSha256: text("packet_sha256").notNull(), artifactSha256: text("artifact_sha256").notNull(), readinessSnapshotSha256: text("readiness_snapshot_sha256").notNull(), readbackKind: text("readback_kind").notNull(), result: text("result").notNull(), evidenceJson: text("evidence_json").notNull().default("{}"),
    sourceUrl: text("source_url").notNull().default(""), observedAt: text("observed_at").notNull(), evidenceSha256: text("evidence_sha256").notNull(), responseSha256: text("response_sha256").notNull(), createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("release_authoritative_readbacks_v2_platform_check", sql`${table.platform} IN ('xiaohongshu','maimai','zhihu','bilibili')`),
    check("release_authoritative_readbacks_v2_kind_check", sql`${table.readbackKind} IN ('submission','destination_record','public_access','outcome','read_only_probe')`),
    check("release_authoritative_readbacks_v2_result_check", sql`${table.result} IN ('verified','not_found','not_public','inconclusive','failed')`),
    index("idx_release_authoritative_readbacks_v2_release_kind_observed").on(table.releaseId, table.readbackKind, table.observedAt),
  ],
);

export const releaseControlV2CommandReceipts = sqliteTable(
  "release_control_v2_command_receipts",
  {
    commandId: text("command_id").primaryKey(), commandType: text("command_type").notNull(), actorId: text("actor_id").notNull(),
    requestSha256: text("request_sha256").notNull(), status: text("status").notNull().default("received"), responseJson: text("response_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(), completedAt: text("completed_at"),
  },
  (table) => [
    check("release_control_v2_command_receipts_status_check", sql`${table.status} IN ('received','succeeded','rejected','failed')`),
    index("idx_release_control_v2_command_receipts_actor_created").on(table.actorId, table.createdAt),
  ],
);

// Shared sources are provider-neutral records. Provider identifiers are an
// optional provenance tuple, deliberately separate from a content hash.
export const sharedSources = sqliteTable(
  "shared_sources",
  {
    id: text("id").primaryKey(), sourceKey: text("source_key").notNull(),
    originKind: text("origin_kind", { enum: ["manual_upload", "manual_reference"] }).notNull(),
    providerNamespace: text("provider_namespace"), providerTenantKeySha256: text("provider_tenant_key_sha256"), externalObjectKeySha256: text("external_object_key_sha256"),
    ownerKind: text("owner_kind").notNull(), ownerRef: text("owner_ref").notNull(),
    status: text("status", { enum: ["active", "access_suspended", "tombstoned"] }).notNull().default("active"),
    lockVersion: integer("lock_version").notNull().default(1), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), tombstonedAt: text("tombstoned_at"),
  },
  (table) => [
    uniqueIndex("idx_shared_sources_source_key").on(table.sourceKey),
    uniqueIndex("idx_shared_sources_provider_identity").on(table.providerNamespace, table.providerTenantKeySha256, table.externalObjectKeySha256).where(sql`${table.providerNamespace} IS NOT NULL`),
    check("shared_sources_origin_kind_check", sql`${table.originKind} IN ('manual_upload','manual_reference')`),
    check("shared_sources_provider_tuple_check", sql`(${table.providerNamespace} IS NULL AND ${table.providerTenantKeySha256} IS NULL AND ${table.externalObjectKeySha256} IS NULL) OR (${table.providerNamespace} IS NOT NULL AND ${table.providerTenantKeySha256} IS NOT NULL AND ${table.externalObjectKeySha256} IS NOT NULL AND length(${table.providerTenantKeySha256}) = 64 AND ${table.providerTenantKeySha256} NOT GLOB '*[^0-9a-f]*' AND length(${table.externalObjectKeySha256}) = 64 AND ${table.externalObjectKeySha256} NOT GLOB '*[^0-9a-f]*')`),
    check("shared_sources_status_check", sql`${table.status} IN ('active','access_suspended','tombstoned')`),
    check("shared_sources_time_check", sql`${table.updatedAt} >= ${table.createdAt} AND ((${table.status} = 'tombstoned' AND ${table.tombstonedAt} = ${table.updatedAt}) OR (${table.status} <> 'tombstoned' AND ${table.tombstonedAt} IS NULL))`),
    check("shared_sources_lock_version_check", sql`${table.lockVersion} >= 1`),
  ],
);

export const sharedSourceVersions = sqliteTable(
  "shared_source_versions",
  {
    id: text("id").primaryKey(), sourceId: text("source_id").notNull().references(() => sharedSources.id, { onDelete: "restrict" }), versionNo: integer("version_no").notNull(),
    materializationKind: text("materialization_kind", { enum: ["local_copy", "reference_only"] }).notNull(), contentRef: text("content_ref"), mediaType: text("media_type").notNull(), sizeBytes: integer("size_bytes"), contentSha256: text("content_sha256"), metadataJson: text("metadata_json").notNull().default("{}"), snapshotSha256: text("snapshot_sha256").notNull(), providerRevisionKeySha256: text("provider_revision_key_sha256"), capturedAt: text("captured_at").notNull(), uploaderKind: text("uploader_kind").notNull(), uploaderRef: text("uploader_ref").notNull(), createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_shared_source_versions_id_source").on(table.id, table.sourceId), uniqueIndex("idx_shared_source_versions_source_no").on(table.sourceId, table.versionNo), uniqueIndex("idx_shared_source_versions_source_snapshot").on(table.sourceId, table.snapshotSha256), uniqueIndex("idx_shared_source_versions_source_provider_revision").on(table.sourceId, table.providerRevisionKeySha256).where(sql`${table.providerRevisionKeySha256} IS NOT NULL`),
    check("shared_source_versions_materialization_check", sql`${table.materializationKind} IN ('local_copy','reference_only')`), check("shared_source_versions_version_no_check", sql`${table.versionNo} >= 1`), check("shared_source_versions_content_shape_check", sql`(${table.materializationKind} = 'local_copy' AND ${table.contentRef} IS NOT NULL AND ${table.contentSha256} IS NOT NULL AND length(${table.contentSha256}) = 64 AND ${table.contentSha256} NOT GLOB '*[^0-9a-f]*') OR (${table.materializationKind} = 'reference_only' AND ${table.contentRef} IS NULL AND ${table.contentSha256} IS NULL)`), check("shared_source_versions_size_check", sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`), check("shared_source_versions_metadata_json_check", sql`json_valid(${table.metadataJson}) AND json_type(${table.metadataJson}) = 'object'`), check("shared_source_versions_snapshot_sha_check", sql`length(${table.snapshotSha256}) = 64 AND ${table.snapshotSha256} NOT GLOB '*[^0-9a-f]*'`), check("shared_source_versions_provider_revision_sha_check", sql`${table.providerRevisionKeySha256} IS NULL OR (length(${table.providerRevisionKeySha256}) = 64 AND ${table.providerRevisionKeySha256} NOT GLOB '*[^0-9a-f]*')`),
  ],
);

export const sharedSourceRightsAssertions = sqliteTable("shared_source_rights_assertions", {
  id: text("id").primaryKey(), sourceId: text("source_id").notNull(), versionId: text("version_id").notNull(), rightsHolderKind: text("rights_holder_kind"), rightsHolderRef: text("rights_holder_ref"), decision: text("decision", { enum: ["allow", "deny", "unknown"] }).notNull(), basis: text("basis").notNull(), allowedUsesJson: text("allowed_uses_json").notNull().default("[]"), restrictionsJson: text("restrictions_json").notNull().default("[]"), validFrom: text("valid_from").notNull(), validUntil: text("valid_until"), assertedByKind: text("asserted_by_kind").notNull(), assertedByRef: text("asserted_by_ref").notNull(), evidenceSha256: text("evidence_sha256").notNull(), supersedesAssertionId: text("supersedes_assertion_id"), createdAt: text("created_at").notNull(),
}, (table) => [foreignKey({ columns: [table.versionId, table.sourceId], foreignColumns: [sharedSourceVersions.id, sharedSourceVersions.sourceId] }).onDelete("restrict"), foreignKey({ columns: [table.supersedesAssertionId, table.sourceId, table.versionId], foreignColumns: [table.id, table.sourceId, table.versionId] }).onDelete("restrict"), uniqueIndex("idx_shared_source_rights_id_source_version").on(table.id, table.sourceId, table.versionId), uniqueIndex("idx_shared_source_rights_initial").on(table.sourceId, table.versionId).where(sql`${table.supersedesAssertionId} IS NULL`), uniqueIndex("idx_shared_source_rights_successor").on(table.supersedesAssertionId).where(sql`${table.supersedesAssertionId} IS NOT NULL`), check("shared_source_rights_assertions_decision_check", sql`${table.decision} IN ('allow','deny','unknown')`), check("shared_source_rights_assertions_holder_tuple_check", sql`(${table.rightsHolderKind} IS NULL AND ${table.rightsHolderRef} IS NULL) OR (${table.rightsHolderKind} IS NOT NULL AND ${table.rightsHolderRef} IS NOT NULL)`), check("shared_source_rights_assertions_json_check", sql`json_valid(${table.allowedUsesJson}) AND json_type(${table.allowedUsesJson}) = 'array' AND json_valid(${table.restrictionsJson}) AND json_type(${table.restrictionsJson}) = 'array'`), check("shared_source_rights_assertions_evidence_sha_check", sql`length(${table.evidenceSha256}) = 64 AND ${table.evidenceSha256} NOT GLOB '*[^0-9a-f]*'`), check("shared_source_rights_assertions_time_check", sql`${table.validUntil} IS NULL OR ${table.validUntil} >= ${table.validFrom}`), index("idx_shared_source_rights_source_version_created").on(table.sourceId, table.versionId, table.createdAt)]);

export const sharedSourceAccessSnapshots = sqliteTable("shared_source_access_snapshots", {
  id: text("id").primaryKey(), sourceId: text("source_id").notNull(), versionId: text("version_id").notNull(), subjectKind: text("subject_kind").notNull(), subjectRef: text("subject_ref").notNull(), capability: text("capability", { enum: ["metadata", "content", "bind"] }).notNull(), result: text("result", { enum: ["granted", "denied", "unknown"] }).notNull(), authzFingerprintSha256: text("authz_fingerprint_sha256").notNull(), evidenceKind: text("evidence_kind", { enum: ["manual_declaration", "local_readback", "provider_readback"] }).notNull(), providerAccountRefSha256: text("provider_account_ref_sha256"), observedAt: text("observed_at").notNull(), validUntil: text("valid_until"), snapshotJson: text("snapshot_json").notNull(), snapshotSha256: text("snapshot_sha256").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [foreignKey({ columns: [table.versionId, table.sourceId], foreignColumns: [sharedSourceVersions.id, sharedSourceVersions.sourceId] }).onDelete("restrict"), uniqueIndex("idx_shared_source_access_observation").on(table.sourceId, table.versionId, table.subjectKind, table.subjectRef, table.capability, table.observedAt), check("shared_source_access_snapshots_capability_check", sql`${table.capability} IN ('metadata','content','bind')`), check("shared_source_access_snapshots_result_check", sql`${table.result} IN ('granted','denied','unknown')`), check("shared_source_access_snapshots_evidence_kind_check", sql`${table.evidenceKind} IN ('manual_declaration','local_readback','provider_readback')`), check("shared_source_access_snapshots_json_check", sql`json_valid(${table.snapshotJson}) AND json_type(${table.snapshotJson}) = 'object'`), check("shared_source_access_snapshots_sha_check", sql`length(${table.authzFingerprintSha256}) = 64 AND ${table.authzFingerprintSha256} NOT GLOB '*[^0-9a-f]*' AND length(${table.snapshotSha256}) = 64 AND ${table.snapshotSha256} NOT GLOB '*[^0-9a-f]*' AND (${table.providerAccountRefSha256} IS NULL OR (length(${table.providerAccountRefSha256}) = 64 AND ${table.providerAccountRefSha256} NOT GLOB '*[^0-9a-f]*'))`), check("shared_source_access_snapshots_time_check", sql`(${table.result} <> 'granted' AND (${table.validUntil} IS NULL OR ${table.validUntil} > ${table.observedAt})) OR (${table.result} = 'granted' AND ${table.validUntil} IS NOT NULL AND ${table.validUntil} > ${table.observedAt})`), index("idx_shared_source_access_source_version_observed").on(table.sourceId, table.versionId, table.observedAt)]);

export const sharedSourceBindings = sqliteTable("shared_source_bindings", {
  id: text("id").primaryKey(), sourceId: text("source_id").notNull(), versionId: text("version_id").notNull(), packageId: text("package_id"), projectGroupId: text("project_group_id"), packageSourceRefId: text("package_source_ref_id"), targetKey: text("target_key").notNull(), generation: integer("generation").notNull(), action: text("action", { enum: ["attach", "tombstone"] }).notNull(), supersedesBindingId: text("supersedes_binding_id"), actor: text("actor").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [foreignKey({ columns: [table.versionId, table.sourceId], foreignColumns: [sharedSourceVersions.id, sharedSourceVersions.sourceId] }).onDelete("restrict"), foreignKey({ columns: [table.projectGroupId], foreignColumns: [projectGroups.id] }).onDelete("restrict"), foreignKey({ columns: [table.packageSourceRefId, table.packageId], foreignColumns: [packageSourceRefs.id, packageSourceRefs.packageId] }).onDelete("restrict"), foreignKey({ columns: [table.supersedesBindingId], foreignColumns: [table.id] }).onDelete("restrict"), uniqueIndex("idx_shared_source_bindings_package_generation").on(table.packageId, table.targetKey, table.generation).where(sql`${table.packageId} IS NOT NULL`), uniqueIndex("idx_shared_source_bindings_group_generation").on(table.projectGroupId, table.targetKey, table.generation).where(sql`${table.projectGroupId} IS NOT NULL`), uniqueIndex("idx_shared_source_bindings_successor").on(table.supersedesBindingId).where(sql`${table.supersedesBindingId} IS NOT NULL`), check("shared_source_bindings_target_check", sql`(${table.packageId} IS NOT NULL AND ${table.projectGroupId} IS NULL AND ${table.packageSourceRefId} IS NOT NULL) OR (${table.packageId} IS NULL AND ${table.projectGroupId} IS NOT NULL AND ${table.packageSourceRefId} IS NULL)`), check("shared_source_bindings_generation_check", sql`${table.generation} >= 1`), check("shared_source_bindings_action_check", sql`${table.action} IN ('attach','tombstone')`), index("idx_shared_source_bindings_source_version_created").on(table.sourceId, table.versionId, table.createdAt)]);

export const sharedSourceEvents = sqliteTable("shared_source_events", {
  id: text("id").primaryKey(), commandId: text("command_id").notNull(), sourceId: text("source_id"), versionId: text("version_id"), bindingId: text("binding_id"), eventType: text("event_type").notNull(), actor: text("actor").notNull(), requestSha256: text("request_sha256").notNull(), beforeStatus: text("before_status"), afterStatus: text("after_status"), readbackJson: text("readback_json").notNull().default("{}"), createdAt: text("created_at").notNull(), completedAt: text("completed_at").notNull(),
}, (table) => [uniqueIndex("idx_shared_source_events_command").on(table.commandId), foreignKey({ columns: [table.sourceId], foreignColumns: [sharedSources.id] }).onDelete("restrict"), foreignKey({ columns: [table.versionId, table.sourceId], foreignColumns: [sharedSourceVersions.id, sharedSourceVersions.sourceId] }).onDelete("restrict"), foreignKey({ columns: [table.bindingId], foreignColumns: [sharedSourceBindings.id] }).onDelete("restrict"), check("shared_source_events_source_presence_check", sql`(${table.versionId} IS NULL OR ${table.sourceId} IS NOT NULL) AND ((${table.beforeStatus} IS NULL AND ${table.afterStatus} IS NULL) OR ${table.sourceId} IS NOT NULL) AND (${table.bindingId} IS NULL OR ${table.sourceId} IS NOT NULL)`), check("shared_source_events_request_sha_check", sql`length(${table.requestSha256}) = 64 AND ${table.requestSha256} NOT GLOB '*[^0-9a-f]*'`), check("shared_source_events_status_check", sql`(${table.beforeStatus} IS NULL OR ${table.beforeStatus} IN ('active','access_suspended','tombstoned')) AND (${table.afterStatus} IS NULL OR ${table.afterStatus} IN ('active','access_suspended','tombstoned'))`), check("shared_source_events_readback_json_check", sql`json_valid(${table.readbackJson}) AND json_type(${table.readbackJson}) = 'object'`), check("shared_source_events_time_check", sql`${table.completedAt} >= ${table.createdAt}`), index("idx_shared_source_events_source_created").on(table.sourceId, table.createdAt)]);

// Shared-source v1 records immutable remote metadata observations without a connector.
// Partial and expression unique indexes are represented by the frozen SQL migration.
export const sharedSourceObjectProfiles = sqliteTable("shared_source_object_profiles", {
  id: text("id").primaryKey(), sourceId: text("source_id").notNull().references(() => sharedSources.id, { onDelete: "restrict" }), objectKind: text("object_kind").notNull(), ingestionSurface: text("ingestion_surface").notNull(), spaceKind: text("space_kind").notNull(), providerNamespace: text("provider_namespace"), providerTenantHmacSha256: text("provider_tenant_hmac_sha256"), providerObjectHmacSha256: text("provider_object_hmac_sha256"), providerAccountHmacSha256: text("provider_account_hmac_sha256"), providerOccurrenceHmacSha256: text("provider_occurrence_hmac_sha256"), hmacKeyId: text("hmac_key_id"), createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("idx_shared_source_object_profile_source").on(t.sourceId), uniqueIndex("idx_shared_source_object_profile_provider_identity").on(t.providerNamespace, t.providerTenantHmacSha256, t.providerObjectHmacSha256, t.providerAccountHmacSha256, t.providerOccurrenceHmacSha256, t.hmacKeyId).where(sql`${t.providerNamespace} IS NOT NULL`), check("shared_source_object_profiles_kind_check", sql`${t.objectKind} IN ('file','folder','collection')`), check("shared_source_object_profiles_surface_check", sql`${t.ingestionSurface} IN ('manual','chatgpt_library','google_drive','unknown')`), check("shared_source_object_profiles_space_check", sql`${t.spaceKind} IN ('local','chatgpt_library','google_my_drive','google_shared_with_me','google_shared_drive','unknown')`), check("shared_source_object_profiles_provider_tuple_check", sql`(${t.providerNamespace} IS NULL AND ${t.providerTenantHmacSha256} IS NULL AND ${t.providerObjectHmacSha256} IS NULL AND ${t.providerAccountHmacSha256} IS NULL AND ${t.providerOccurrenceHmacSha256} IS NULL AND ${t.hmacKeyId} IS NULL) OR (${t.providerNamespace} IS NOT NULL AND length(${t.providerNamespace}) BETWEEN 1 AND 80 AND ${t.hmacKeyId} IS NOT NULL AND length(${t.hmacKeyId}) BETWEEN 1 AND 80 AND length(${t.providerTenantHmacSha256}) = 64 AND ${t.providerTenantHmacSha256} NOT GLOB '*[^0-9a-f]*' AND length(${t.providerObjectHmacSha256}) = 64 AND ${t.providerObjectHmacSha256} NOT GLOB '*[^0-9a-f]*' AND length(${t.providerAccountHmacSha256}) = 64 AND ${t.providerAccountHmacSha256} NOT GLOB '*[^0-9a-f]*' AND length(${t.providerOccurrenceHmacSha256}) = 64 AND ${t.providerOccurrenceHmacSha256} NOT GLOB '*[^0-9a-f]*')`)]);
export const sharedSourceProviderCapabilitySnapshots = sqliteTable("shared_source_provider_capability_snapshots", { id: text("id").primaryKey(), surface: text("surface").notNull(), spaceKind: text("space_kind").notNull(), providerNamespace: text("provider_namespace"), providerAccountHmacSha256: text("provider_account_hmac_sha256"), hmacKeyId: text("hmac_key_id"), capability: text("capability").notNull(), result: text("result").notNull(), conditionsJson: text("conditions_json").notNull().default("{}"), evidenceKind: text("evidence_kind").notNull(), evidenceSha256: text("evidence_sha256").notNull(), observedAt: text("observed_at").notNull(), validUntil: text("valid_until"), snapshotSha256: text("snapshot_sha256").notNull(), createdAt: text("created_at").notNull() }, (t) => [uniqueIndex("idx_shared_source_provider_capability_observation").on(t.surface, t.spaceKind, t.providerNamespace, t.providerAccountHmacSha256, t.hmacKeyId, t.capability, t.observedAt), check("shared_source_provider_capability_surface_check", sql`${t.surface} IN ('chatgpt_library_ui','google_drive_ui','general_api','wenmai_connector')`), check("shared_source_provider_capability_space_check", sql`${t.spaceKind} IN ('local','chatgpt_library','google_my_drive','google_shared_with_me','google_shared_drive','unknown')`), check("shared_source_provider_capability_name_check", sql`${t.capability} IN ('file_reuse','folder_selection','my_drive','shared_with_me','shared_drive','metadata','content','children','bind','edit_metadata','edit_content')`), check("shared_source_provider_capability_result_check", sql`${t.result} IN ('supported','unsupported','conditional','unverified','unconfigured','blocked')`), check("shared_source_provider_capability_provider_check", sql`(${t.providerNamespace} IS NULL AND ${t.providerAccountHmacSha256} IS NULL AND ${t.hmacKeyId} IS NULL) OR (${t.providerNamespace} IS NOT NULL AND length(${t.providerAccountHmacSha256}) = 64 AND ${t.providerAccountHmacSha256} NOT GLOB '*[^0-9a-f]*' AND length(${t.hmacKeyId}) BETWEEN 1 AND 80)`), check("shared_source_provider_capability_json_check", sql`json_valid(${t.conditionsJson}) AND json_type(${t.conditionsJson}) = 'object'`), check("shared_source_provider_capability_sha_check", sql`length(${t.evidenceSha256}) = 64 AND ${t.evidenceSha256} NOT GLOB '*[^0-9a-f]*' AND length(${t.snapshotSha256}) = 64 AND ${t.snapshotSha256} NOT GLOB '*[^0-9a-f]*'`), check("shared_source_provider_capability_evidence_check", sql`${t.evidenceKind} IN ('official_release_notes','official_help','provider_readback','local_readback','manual_declaration')`), check("shared_source_provider_capability_time_check", sql`(${t.validUntil} IS NULL OR ${t.validUntil} > ${t.observedAt}) AND ${t.observedAt} <= ${t.createdAt}`)]);
export const sharedSourceEffectiveAccessSnapshots = sqliteTable("shared_source_effective_access_snapshots", { id: text("id").primaryKey(), sourceId: text("source_id").notNull(), versionId: text("version_id").notNull(), subjectKind: text("subject_kind").notNull(), subjectRefHmacSha256: text("subject_ref_hmac_sha256").notNull(), hmacKeyId: text("hmac_key_id").notNull(), authorityPlane: text("authority_plane").notNull(), capability: text("capability").notNull(), result: text("result").notNull(), grantOrigin: text("grant_origin").notNull(), inheritedFromSourceId: text("inherited_from_source_id"), inheritedFromVersionId: text("inherited_from_version_id"), authzFingerprintSha256: text("authz_fingerprint_sha256").notNull(), evidenceKind: text("evidence_kind").notNull(), observedAt: text("observed_at").notNull(), validUntil: text("valid_until"), snapshotSha256: text("snapshot_sha256").notNull(), createdAt: text("created_at").notNull() }, (t) => [foreignKey({ columns: [t.versionId, t.sourceId], foreignColumns: [sharedSourceVersions.id, sharedSourceVersions.sourceId] }).onDelete("restrict"), foreignKey({ columns: [t.inheritedFromVersionId, t.inheritedFromSourceId], foreignColumns: [sharedSourceVersions.id, sharedSourceVersions.sourceId] }).onDelete("restrict"), uniqueIndex("idx_shared_source_effective_access_observation").on(t.sourceId, t.versionId, t.subjectKind, t.subjectRefHmacSha256, t.hmacKeyId, t.authorityPlane, t.capability, t.observedAt), check("shared_source_effective_access_subject_check", sql`${t.subjectKind} IN ('agent_client','management_principal','service') AND length(${t.subjectRefHmacSha256}) = 64 AND ${t.subjectRefHmacSha256} NOT GLOB '*[^0-9a-f]*' AND length(${t.hmacKeyId}) BETWEEN 1 AND 80`), check("shared_source_effective_access_plane_check", sql`${t.authorityPlane} IN ('provider','wenmai')`), check("shared_source_effective_access_capability_check", sql`${t.capability} IN ('metadata','content','children','bind','edit_metadata','edit_content')`), check("shared_source_effective_access_result_check", sql`${t.result} IN ('granted','denied','unknown','expired','not_applicable')`), check("shared_source_effective_access_origin_check", sql`${t.grantOrigin} IN ('direct','inherited','owner','local_policy','unknown') AND ((${t.grantOrigin} = 'inherited' AND ${t.inheritedFromSourceId} IS NOT NULL AND ${t.inheritedFromVersionId} IS NOT NULL) OR (${t.grantOrigin} <> 'inherited' AND ${t.inheritedFromSourceId} IS NULL AND ${t.inheritedFromVersionId} IS NULL))`), check("shared_source_effective_access_fingerprint_check", sql`length(${t.authzFingerprintSha256}) = 64 AND ${t.authzFingerprintSha256} NOT GLOB '*[^0-9a-f]*' AND length(${t.snapshotSha256}) = 64 AND ${t.snapshotSha256} NOT GLOB '*[^0-9a-f]*'`), check("shared_source_effective_access_evidence_check", sql`${t.evidenceKind} IN ('provider_readback','local_readback','manual_declaration')`), check("shared_source_effective_access_grant_check", sql`${t.result} <> 'granted' OR (${t.validUntil} IS NOT NULL AND ${t.validUntil} > ${t.observedAt})`), check("shared_source_effective_access_provider_check", sql`${t.authorityPlane} <> 'provider' OR ${t.result} <> 'granted' OR ${t.evidenceKind} = 'provider_readback'`), check("shared_source_effective_access_time_check", sql`(${t.validUntil} IS NULL OR ${t.validUntil} > ${t.observedAt}) AND ${t.observedAt} <= ${t.createdAt}`)]);
export const sharedSourceRemoteStateSnapshots = sqliteTable("shared_source_remote_state_snapshots", { id: text("id").primaryKey(), sourceId: text("source_id").notNull(), versionId: text("version_id").notNull(), state: text("state").notNull(), evidenceKind: text("evidence_kind").notNull(), evidenceSha256: text("evidence_sha256").notNull(), observedAt: text("observed_at").notNull(), snapshotSha256: text("snapshot_sha256").notNull(), createdAt: text("created_at").notNull() }, (t) => [foreignKey({ columns: [t.versionId, t.sourceId], foreignColumns: [sharedSourceVersions.id, sharedSourceVersions.sourceId] }).onDelete("restrict"), index("idx_shared_source_remote_state_version_observed").on(t.sourceId, t.versionId, t.observedAt, t.createdAt, t.id), check("shared_source_remote_state_name_check", sql`${t.state} IN ('present','deleted','access_lost','unknown')`), check("shared_source_remote_state_evidence_check", sql`${t.evidenceKind} IN ('provider_readback','local_readback','manual_declaration')`), check("shared_source_remote_state_sha_check", sql`length(${t.evidenceSha256}) = 64 AND ${t.evidenceSha256} NOT GLOB '*[^0-9a-f]*' AND length(${t.snapshotSha256}) = 64 AND ${t.snapshotSha256} NOT GLOB '*[^0-9a-f]*'`), check("shared_source_remote_state_time_check", sql`${t.observedAt} <= ${t.createdAt}`)]);
