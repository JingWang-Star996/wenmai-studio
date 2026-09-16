"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { managementFetch } from "./management-fetch";

type GroupMember = {
  articleId: string;
  articleProjectId: string;
};

type GroupEdge = {
  sourceArticleId: string;
  targetArticleId: string;
  relationType: "precedes";
};

type ProjectGroupDetail = {
  group: {
    id: string;
    title: string;
    status: "active" | "archived";
    lockVersion: number;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
  };
  members: GroupMember[];
  edges: GroupEdge[];
  topology: {
    schemaVersion: string;
    groupId: string;
    members: GroupMember[];
    edges: GroupEdge[];
  };
  storedTopologySha256: string;
  recomputedTopologySha256: string;
  integrityStatus: "valid" | "drifted";
};

type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
};

type ProjectGroupPanelProps = {
  articles: Array<{ id: string; title: string }>;
  selectedArticleId: string;
  notify: (message: string) => void;
};

class ProjectGroupApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

function apiMessage(payload: ApiEnvelope<unknown> | null, fallback: string) {
  return payload?.error?.message || payload?.error?.code || fallback;
}

async function readEnvelope<T>(response: Response) {
  return await response.json().catch(() => null) as ApiEnvelope<T> | null;
}

export default function ProjectGroupPanel({
  articles,
  selectedArticleId,
  notify,
}: ProjectGroupPanelProps) {
  const [groups, setGroups] = useState<ProjectGroupDetail[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [detail, setDetail] = useState<ProjectGroupDetail | null>(null);
  const [filterMode, setFilterMode] = useState<"all" | "article">("article");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busyAction, setBusyAction] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [uncertainCommand, setUncertainCommand] = useState<{
    commandId: string;
    action: string;
    groupId: string;
  } | null>(null);
  const [newGroupId, setNewGroupId] = useState("");
  const [newGroupTitle, setNewGroupTitle] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [memberArticleId, setMemberArticleId] = useState(selectedArticleId);
  const [memberProjectId, setMemberProjectId] = useState("");
  const [edgeSource, setEdgeSource] = useState("");
  const [edgeTarget, setEdgeTarget] = useState("");
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);

  const articleTitle = useMemo(
    () => new Map(articles.map((article) => [article.id, article.title])),
    [articles],
  );

  const loadGroups = useCallback(async (signal?: AbortSignal) => {
    setState("loading");
    const params = new URLSearchParams({
      view: filterMode === "article" ? "by-article" : "list",
      includeArchived: String(includeArchived),
      limit: "100",
    });
    if (filterMode === "article") params.set("articleId", selectedArticleId);
    const response = await managementFetch(
      "/api/project-group/v1?" + params.toString(),
      { method: "GET", cache: "no-store", signal },
    );
    const payload = await readEnvelope<{ groups: ProjectGroupDetail[] }>(response);
    if (!response.ok || !payload?.ok || !payload.data) {
      throw new ProjectGroupApiError(
        apiMessage(payload, "ProjectGroup 列表读取失败"),
        response.status,
        payload?.error?.code ?? "READ_FAILED",
      );
    }
    if (signal?.aborted) return payload.data.groups;
    const nextGroups = payload.data.groups;
    setGroups(nextGroups);
    setSelectedGroupId((current) => (
      nextGroups.some((group) => group.group.id === current)
        ? current
        : nextGroups[0]?.group.id ?? ""
    ));
    if (nextGroups.length === 0) setDetail(null);
    setState("ready");
    setError("");
    return nextGroups;
  }, [filterMode, includeArchived, selectedArticleId]);

  const loadDetail = useCallback(async (groupId: string, signal?: AbortSignal) => {
    if (!groupId) {
      setDetail(null);
      return null;
    }
    const params = new URLSearchParams({ view: "detail", groupId });
    const response = await managementFetch(
      "/api/project-group/v1?" + params.toString(),
      { method: "GET", cache: "no-store", signal },
    );
    const payload = await readEnvelope<ProjectGroupDetail>(response);
    if (!response.ok || !payload?.ok || !payload.data) {
      throw new ProjectGroupApiError(
        apiMessage(payload, "ProjectGroup 详情读取失败"),
        response.status,
        payload?.error?.code ?? "READ_FAILED",
      );
    }
    const nextDetail = payload.data;
    if (signal?.aborted) return nextDetail;
    setDetail(nextDetail);
    setTitleDraft(nextDetail.group.title);
    setArchiveConfirmed(false);
    setEdgeSource((current) => (
      nextDetail.members.some((member) => member.articleId === current)
        ? current
        : nextDetail.members[0]?.articleId ?? ""
    ));
    setEdgeTarget((current) => (
      nextDetail.members.some((member) => member.articleId === current)
        ? current
        : nextDetail.members[1]?.articleId ?? ""
    ));
    setError("");
    return nextDetail;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const task = window.setTimeout(() => {
      void loadGroups(controller.signal).catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setState("error");
        setError(reason instanceof Error ? reason.message : "ProjectGroup 列表读取失败");
      });
    }, 0);
    return () => {
      window.clearTimeout(task);
      controller.abort();
    };
  }, [loadGroups]);

  useEffect(() => {
    const controller = new AbortController();
    const task = window.setTimeout(() => {
      void loadDetail(selectedGroupId, controller.signal).catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setError(reason instanceof Error ? reason.message : "ProjectGroup 详情读取失败");
      });
    }, 0);
    return () => {
      window.clearTimeout(task);
      controller.abort();
    };
  }, [loadDetail, selectedGroupId]);

  useEffect(() => {
    const task = window.setTimeout(() => setMemberArticleId(selectedArticleId), 0);
    return () => window.clearTimeout(task);
  }, [selectedArticleId]);

  const refreshServerState = useCallback(async () => {
    const nextGroups = await loadGroups();
    const targetId = nextGroups.some((group) => group.group.id === selectedGroupId)
      ? selectedGroupId
      : nextGroups[0]?.group.id ?? "";
    if (targetId) await loadDetail(targetId);
    else setDetail(null);
    setSelectedGroupId(targetId);
    setUncertainCommand(null);
    setMessage("已从服务器重新读取当前状态。");
  }, [loadDetail, loadGroups, selectedGroupId]);

  const mutate = useCallback(async (
    action: string,
    payload: Record<string, unknown>,
  ) => {
    if (uncertainCommand) {
      setError("上一条写入结果仍不明确，请先读取服务器现状。");
      return false;
    }
    const groupId = String(payload.groupId ?? "");
    const commandId = "pgui-" + action + "-" + crypto.randomUUID();
    const requestBody = JSON.stringify({ action, commandId, payload });
    setBusyAction(action);
    setError("");
    setMessage("");
    try {
      const response = await managementFetch("/api/project-group/v1", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
      const result = await readEnvelope<Record<string, unknown>>(response);
      if (!response.ok || !result?.ok) {
        const apiError = new ProjectGroupApiError(
          apiMessage(result, "ProjectGroup 写入失败"),
          response.status,
          result?.error?.code ?? "WRITE_FAILED",
        );
        if (response.status === 409) {
          const nextGroups = await loadGroups();
          if (groupId && (
            nextGroups.some((group) => group.group.id === groupId)
            || action !== "create_group"
          )) {
            await loadDetail(groupId).catch(() => null);
          }
          setError("服务器状态已经变化，已重新读取；请核对后再操作。");
          return false;
        }
        throw apiError;
      }

      const confirmed = await loadDetail(groupId);
      if (!confirmed) throw new Error("写入后未能读回 ProjectGroup。");
      setSelectedGroupId(groupId);
      setGroups((current) => [
        confirmed,
        ...current.filter((group) => group.group.id !== groupId),
      ]);
      if (action === "create_group") setFilterMode("all");
      if (action === "archive_group") setIncludeArchived(true);
      setUncertainCommand(null);
      setMessage("写入已由服务器读回确认。");
      notify("ProjectGroup 已更新并完成服务端读回");
      return true;
    } catch (reason) {
      if (reason instanceof ProjectGroupApiError) {
        setError(reason.message + (reason.code ? "（" + reason.code + "）" : ""));
      } else {
        setUncertainCommand({ commandId, action, groupId });
        setError("写入请求结果不明确，已冻结继续写入；请先读取服务器现状。");
      }
      return false;
    } finally {
      setBusyAction("");
    }
  }, [loadDetail, loadGroups, notify, uncertainCommand]);

  const active = detail?.group.status === "active";
  const mutationsDisabled = Boolean(
    busyAction || uncertainCommand || !active || detail?.integrityStatus !== "valid",
  );

  return (
    <section className="project-group-panel">
      <header className="project-group-hero">
        <div>
          <span className="eyebrow">文章开发关系 · 人类后备控制面</span>
          <h2>项目组与开发顺序</h2>
          <p>
            Agent 默认通过只读接口取完整拓扑；这里供人校正文章归组和先后关系。
            每次写入都绑定当前锁版本，成功后再从服务器读回。
          </p>
        </div>
        <button type="button" onClick={() => void refreshServerState()} disabled={state === "loading"}>
          读取服务器现状
        </button>
      </header>

      <div className="project-group-status" aria-live="polite">
        {state === "loading" && <span>正在读取 ProjectGroup…</span>}
        {message && <span className="success">{message}</span>}
        {error && <span className="error">{error}</span>}
      </div>
      {uncertainCommand && (
        <aside className="project-group-uncertain" role="alert">
          <strong>写入结果不明，已冻结新写入</strong>
          <span>动作：{uncertainCommand.action}</span>
          <code>{uncertainCommand.commandId}</code>
          <button type="button" onClick={() => void refreshServerState()}>
            只读核对服务器
          </button>
        </aside>
      )}

      <div className="project-group-layout">
        <aside className="project-group-sidebar">
          <fieldset>
            <legend>查看范围</legend>
            <label>
              <input
                type="radio"
                name="project-group-filter"
                checked={filterMode === "article"}
                onChange={() => setFilterMode("article")}
              />
              当前文章
            </label>
            <label>
              <input
                type="radio"
                name="project-group-filter"
                checked={filterMode === "all"}
                onChange={() => setFilterMode("all")}
              />
              全部项目组
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              包含已归档
            </label>
          </fieldset>

          <div className="project-group-list" aria-label="ProjectGroup 列表">
            {state === "ready" && groups.length === 0 && (
              <p>当前范围还没有项目组。</p>
            )}
            {groups.map((group) => (
              <button
                type="button"
                key={group.group.id}
                className={selectedGroupId === group.group.id ? "active" : ""}
                onClick={() => setSelectedGroupId(group.group.id)}
              >
                <strong>{group.group.title}</strong>
                <span>{group.members.length} 篇 · {group.edges.length} 条边</span>
                <small>{group.group.status === "active" ? "进行中" : "已归档"} · v{group.group.lockVersion}</small>
              </button>
            ))}
          </div>

          <form
            className="project-group-create"
            onSubmit={async (event) => {
              event.preventDefault();
              const created = await mutate("create_group", {
                groupId: newGroupId,
                title: newGroupTitle,
                expectedLockVersion: 1,
              });
              if (created) {
                setNewGroupId("");
                setNewGroupTitle("");
              }
            }}
          >
            <h3>新建项目组</h3>
            <label htmlFor="new-project-group-id">稳定 ID</label>
            <input
              id="new-project-group-id"
              required
              pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,199}"
              value={newGroupId}
              onChange={(event) => setNewGroupId(event.target.value)}
              placeholder="series-ai-practice"
            />
            <label htmlFor="new-project-group-title">名称</label>
            <input
              id="new-project-group-title"
              required
              maxLength={240}
              value={newGroupTitle}
              onChange={(event) => setNewGroupTitle(event.target.value)}
              placeholder="AI 实践系列"
            />
            <button type="submit" disabled={Boolean(busyAction || uncertainCommand)}>
              {busyAction === "create_group" ? "正在创建…" : "创建并读回"}
            </button>
          </form>
        </aside>

        <main className="project-group-detail">
          {!detail && (
            <div className="project-group-empty">
              <h3>选择一个项目组</h3>
              <p>可以查看完整成员、开发顺序、锁版本与拓扑摘要。</p>
            </div>
          )}
          {detail && (
            <>
              <header>
                <div>
                  <span className="eyebrow">{detail.group.id}</span>
                  <h2>{detail.group.title}</h2>
                  <p>
                    {detail.group.status === "active" ? "进行中" : "已归档"}
                    {" · "}锁版本 {detail.group.lockVersion}
                    {" · "}更新 {new Date(detail.group.updatedAt).toLocaleString("zh-CN")}
                  </p>
                </div>
                <span className={"project-group-integrity " + detail.integrityStatus}>
                  {detail.integrityStatus === "valid" ? "拓扑有效" : "摘要漂移 · 只读"}
                </span>
              </header>

              <dl className="project-group-hashes">
                <div>
                  <dt>已存摘要</dt>
                  <dd><code title={detail.storedTopologySha256}>{detail.storedTopologySha256}</code></dd>
                </div>
                <div>
                  <dt>重算摘要</dt>
                  <dd><code title={detail.recomputedTopologySha256}>{detail.recomputedTopologySha256}</code></dd>
                </div>
              </dl>

              <form
                className="project-group-inline-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  await mutate("update_group", {
                    groupId: detail.group.id,
                    title: titleDraft,
                    expectedLockVersion: detail.group.lockVersion,
                  });
                }}
              >
                <label htmlFor="project-group-title">项目组名称</label>
                <input
                  id="project-group-title"
                  required
                  maxLength={240}
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  disabled={mutationsDisabled}
                />
                <button
                  type="submit"
                  disabled={mutationsDisabled || titleDraft.trim() === detail.group.title}
                >
                  {busyAction === "update_group" ? "保存中…" : "保存名称"}
                </button>
              </form>

              <section className="project-group-danger">
                <label>
                  <input
                    type="checkbox"
                    checked={archiveConfirmed}
                    onChange={(event) => setArchiveConfirmed(event.target.checked)}
                    disabled={mutationsDisabled}
                  />
                  我确认归档后该组将只读
                </label>
                <button
                  type="button"
                  disabled={mutationsDisabled || !archiveConfirmed}
                  onClick={() => void mutate("archive_group", {
                    groupId: detail.group.id,
                    expectedLockVersion: detail.group.lockVersion,
                  })}
                >
                  {busyAction === "archive_group" ? "归档中…" : "归档项目组"}
                </button>
              </section>

              <section className="project-group-section">
                <header>
                  <div>
                    <span className="eyebrow">成员</span>
                    <h3>{detail.members.length} 篇文章</h3>
                  </div>
                  <p>Article 与 lifecycle ArticleProject 必须一一对应。</p>
                </header>
                <div className="project-group-member-list">
                  {detail.members.length === 0 && <p>这是一个空组，可以从下方添加首篇文章。</p>}
                  {detail.members.map((member, index) => (
                    <article key={member.articleId}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{articleTitle.get(member.articleId) ?? member.articleId}</strong>
                        <small>{member.articleId}</small>
                        <code>{member.articleProjectId}</code>
                      </div>
                      <button
                        type="button"
                        disabled={mutationsDisabled}
                        onClick={() => {
                          if (!window.confirm("确认从项目组移除此文章？关联边必须先删除。")) return;
                          void mutate("remove_member", {
                            groupId: detail.group.id,
                            articleId: member.articleId,
                            expectedLockVersion: detail.group.lockVersion,
                          });
                        }}
                      >
                        移除
                      </button>
                    </article>
                  ))}
                </div>
                <form
                  className="project-group-grid-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const added = await mutate("add_member", {
                      groupId: detail.group.id,
                      articleId: memberArticleId,
                      articleProjectId: memberProjectId,
                      expectedLockVersion: detail.group.lockVersion,
                    });
                    if (added) setMemberProjectId("");
                  }}
                >
                  <label htmlFor="project-group-member-article">Article ID</label>
                  <input
                    id="project-group-member-article"
                    list="project-group-article-options"
                    required
                    value={memberArticleId}
                    onChange={(event) => setMemberArticleId(event.target.value)}
                    disabled={mutationsDisabled}
                  />
                  <datalist id="project-group-article-options">
                    {articles.map((article) => (
                      <option key={article.id} value={article.id}>{article.title}</option>
                    ))}
                  </datalist>
                  <label htmlFor="project-group-member-project">ArticleProject ID</label>
                  <input
                    id="project-group-member-project"
                    required
                    value={memberProjectId}
                    onChange={(event) => setMemberProjectId(event.target.value)}
                    placeholder="lifecycle-project-id"
                    disabled={mutationsDisabled}
                  />
                  <button type="submit" disabled={mutationsDisabled}>
                    {busyAction === "add_member" ? "添加中…" : "添加成员"}
                  </button>
                </form>
              </section>

              <section className="project-group-section">
                <header>
                  <div>
                    <span className="eyebrow">开发图</span>
                    <h3>{detail.edges.length} 条 precedes 边</h3>
                  </div>
                  <p>箭头表示“先完成左侧文章，再进入右侧文章”。形成环的写入会被服务器拒绝。</p>
                </header>
                <ol className="project-group-edge-list">
                  {detail.edges.length === 0 && <li className="empty">尚未定义文章开发顺序。</li>}
                  {detail.edges.map((edge) => (
                    <li key={edge.sourceArticleId + ">" + edge.targetArticleId}>
                      <span>{articleTitle.get(edge.sourceArticleId) ?? edge.sourceArticleId}</span>
                      <strong aria-label="先于">→</strong>
                      <span>{articleTitle.get(edge.targetArticleId) ?? edge.targetArticleId}</span>
                      <button
                        type="button"
                        disabled={mutationsDisabled}
                        onClick={() => {
                          if (!window.confirm("确认删除这条开发顺序边？")) return;
                          void mutate("remove_edge", {
                            groupId: detail.group.id,
                            sourceArticleId: edge.sourceArticleId,
                            targetArticleId: edge.targetArticleId,
                            expectedLockVersion: detail.group.lockVersion,
                          });
                        }}
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ol>
                <form
                  className="project-group-edge-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    await mutate("add_edge", {
                      groupId: detail.group.id,
                      sourceArticleId: edgeSource,
                      targetArticleId: edgeTarget,
                      expectedLockVersion: detail.group.lockVersion,
                    });
                  }}
                >
                  <label htmlFor="project-group-edge-source">先完成</label>
                  <select
                    id="project-group-edge-source"
                    required
                    value={edgeSource}
                    onChange={(event) => setEdgeSource(event.target.value)}
                    disabled={mutationsDisabled}
                  >
                    <option value="">选择文章</option>
                    {detail.members.map((member) => (
                      <option key={member.articleId} value={member.articleId}>
                        {articleTitle.get(member.articleId) ?? member.articleId}
                      </option>
                    ))}
                  </select>
                  <span aria-hidden="true">→</span>
                  <label htmlFor="project-group-edge-target">再进入</label>
                  <select
                    id="project-group-edge-target"
                    required
                    value={edgeTarget}
                    onChange={(event) => setEdgeTarget(event.target.value)}
                    disabled={mutationsDisabled}
                  >
                    <option value="">选择文章</option>
                    {detail.members.map((member) => (
                      <option key={member.articleId} value={member.articleId}>
                        {articleTitle.get(member.articleId) ?? member.articleId}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    disabled={mutationsDisabled || !edgeSource || !edgeTarget || edgeSource === edgeTarget}
                  >
                    {busyAction === "add_edge" ? "添加中…" : "添加顺序"}
                  </button>
                </form>
              </section>

              <aside className="project-group-boundary">
                <strong>权限边界</strong>
                <p>
                  此面板只调用 owner management API。Agent/MCP 仍是只读；归组和拓扑写入不会自动改正文、
                  完成任务、合并分支或发布文章。
                </p>
              </aside>
            </>
          )}
        </main>
      </div>
    </section>
  );
}
