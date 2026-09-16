export type ModelInvocationMaterializationKind = "probe" | "candidate" | "evaluation" | "review";

type CheckpointRow = Record<string, string | number | null>;

export class ModelInvocationCheckpointError extends Error {
  code: "CHECKPOINT_NOT_WRITTEN" | "CHECKPOINT_DIGEST_CONFLICT" | "CHECKPOINT_MATERIALIZATION_CONFLICT";

  constructor(
    code: ModelInvocationCheckpointError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ModelInvocationCheckpointError";
    this.code = code;
  }
}

export async function checkpointModelInvocationOutput(
  db: D1Database,
  input: Readonly<{
    invocationId: string;
    materializationKind: ModelInvocationMaterializationKind;
    responseJson: string;
    responseSha256: string;
    usageJson: string;
    usageSha256: string;
    now: string;
  }>,
) {
  await db.prepare(`INSERT INTO model_invocation_outputs
    (invocation_id, materialization_kind, response_json, response_sha256,
     usage_json, usage_sha256, materialization_state, materialization_ref,
     materialization_attempts, materialization_lock_version, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, 'checkpointed', '', 0, 1, ?, ?
    FROM model_invocations WHERE id = ? AND state = 'running'
    ON CONFLICT(invocation_id) DO NOTHING`)
    .bind(input.invocationId, input.materializationKind, input.responseJson,
      input.responseSha256, input.usageJson, input.usageSha256, input.now, input.now,
      input.invocationId).run();

  const row = await db.prepare(`SELECT invocation_id, materialization_kind,
      response_sha256, usage_sha256, materialization_state, materialization_ref
    FROM model_invocation_outputs WHERE invocation_id = ? LIMIT 1`)
    .bind(input.invocationId).first<CheckpointRow>();
  if (!row) {
    throw new ModelInvocationCheckpointError(
      "CHECKPOINT_NOT_WRITTEN",
      "模型响应未能写入恢复 checkpoint",
    );
  }
  if (row.response_sha256 !== input.responseSha256
    || row.usage_sha256 !== input.usageSha256
    || row.materialization_kind !== input.materializationKind) {
    throw new ModelInvocationCheckpointError(
      "CHECKPOINT_DIGEST_CONFLICT",
      "同一模型调用的恢复 checkpoint 摘要冲突",
    );
  }
  return row;
}

export async function markModelInvocationOutputMaterialized(
  db: D1Database,
  input: Readonly<{
    invocationId: string;
    materializationRef: string;
    now: string;
  }>,
) {
  const updated = await db.prepare(`UPDATE model_invocation_outputs
    SET materialization_state = 'materialized', materialization_ref = ?,
      materialized_at = ?, updated_at = ?, materialization_lock_version = materialization_lock_version + 1,
      materialization_lease_owner = NULL, materialization_lease_expires_at = NULL
    WHERE invocation_id = ? AND materialization_state IN ('checkpointed','materializing')`)
    .bind(input.materializationRef, input.now, input.now, input.invocationId).run();
  if (Number(updated.meta.changes ?? 0) === 1) return;
  const row = await db.prepare(`SELECT materialization_state, materialization_ref
    FROM model_invocation_outputs WHERE invocation_id = ? LIMIT 1`)
    .bind(input.invocationId).first<CheckpointRow>();
  if (row?.materialization_state === "materialized" && row.materialization_ref === input.materializationRef) return;
  throw new ModelInvocationCheckpointError(
    "CHECKPOINT_MATERIALIZATION_CONFLICT",
    "模型响应 checkpoint 无法绑定到当前物化工件",
  );
}

export async function blockModelInvocationOutput(
  db: D1Database,
  input: Readonly<{
    invocationId: string;
    errorClass: string;
    errorSummary: string;
    now: string;
  }>,
) {
  await db.prepare(`UPDATE model_invocation_outputs
    SET materialization_state = 'blocked', last_error_class = ?, last_error_summary = ?,
      updated_at = ?, materialization_lock_version = materialization_lock_version + 1,
      materialization_lease_owner = NULL, materialization_lease_expires_at = NULL
    WHERE invocation_id = ? AND materialization_state <> 'materialized'`)
    .bind(input.errorClass.slice(0, 80), input.errorSummary.slice(0, 512), input.now,
      input.invocationId).run();
}
