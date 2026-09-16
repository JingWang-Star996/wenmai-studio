"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BaselineRadar, KnowledgeGraphCanvas } from "./studio-charts";
import { managementFetch } from "./management-fetch";
import {
  articleMatches,
  confidenceClass,
  currentVersion,
  diffBlocks,
  diffSummary,
  evidenceHealthFor,
  formatCompact,
  formatDate,
  formatNumber,
  gateStateFor,
  relativeDate,
} from "./studio-utils";
import type {
  ArticleOverride,
  ArticleRecord,
  CorpusData,
  EditorialDecision,
  EditorialItem,
  OpportunityRecord,
  StudioView,
} from "./types";

type SaveOverridePayload = Omit<ArticleOverride, "updatedAt"> & { ruleVersion: string; inputSha256: string };

const NAV_ITEMS: Array<{ id: StudioView; label: string; mark: string; hint: string }> = [
  { id: "dashboard", label: "今日工作台", mark: "今", hint: "先做什么，注意什么" },
  { id: "library", label: "文章库", mark: "文", hint: "作品、版本与来源" },
  { id: "compare", label: "版本对比", mark: "差", hint: "并排查看两版" },
  { id: "baseline", label: "创作基线", mark: "准", hint: "结构信号与待审项" },
  { id: "graph", label: "内容图谱", mark: "图", hint: "候选关系及其依据" },
  { id: "topics", label: "选题雷达", mark: "题", hint: "待看的选题线索" },
  { id: "series", label: "系列看板", mark: "系", hint: "读者问题与缺口" },
  { id: "rules", label: "数据与规则", mark: "则", hint: "索引范围与证据边界" },
];

const EDITORIAL_STATE_OPTIONS = [
  ["inbox", "待归类"],
  ["planned", "已计划"],
  ["researching", "研究中"],
  ["drafting", "写作中"],
  ["review", "审阅中"],
  ["approved", "人工批准"],
  ["maintaining", "持续维护"],
  ["retired", "停止维护"],
] as const;

function editorialStateLabel(value: string): string {
  return EDITORIAL_STATE_OPTIONS.find(([key]) => key === value)?.[1] ?? value;
}

function readHash(): { view?: StudioView; article?: string; from?: string; to?: string } {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const view = params.get("view") as StudioView | null;
  return {
    view: NAV_ITEMS.some((item) => item.id === view) ? view ?? undefined : undefined,
    article: params.get("article") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  };
}

export default function StudioShell({ corpus }: { corpus: CorpusData }) {
  const articleWorks = useMemo(() => corpus.articles.filter((article) => article.kind === "文章"), [corpus.articles]);
  const firstComparable = articleWorks.find((article) => article.versionCount > 1) ?? articleWorks[0] ?? corpus.articles[0];
  const [view, setView] = useState<StudioView>("dashboard");
  const [selectedArticleId, setSelectedArticleId] = useState(firstComparable?.id ?? "");
  const [compareArticleId, setCompareArticleId] = useState(firstComparable?.id ?? "");
  const [fromVersionId, setFromVersionId] = useState(firstComparable?.versions[0]?.id ?? "");
  const [toVersionId, setToVersionId] = useState(firstComparable?.representativeVersionId ?? "");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [editorialItems, setEditorialItems] = useState<EditorialItem[]>([]);
  const [overrides, setOverrides] = useState<ArticleOverride[]>([]);
  const [decisions, setDecisions] = useState<EditorialDecision[]>([]);
  const [storageState, setStorageState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [toast, setToast] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedArticle = corpus.articles.find((article) => article.id === selectedArticleId) ?? firstComparable;
  const compareArticle = corpus.articles.find((article) => article.id === compareArticleId) ?? firstComparable;
  const validFromVersionId = compareArticle?.versions.some((version) => version.id === fromVersionId)
    ? fromVersionId
    : compareArticle?.versions[0]?.id ?? "";
  const validToVersionId = compareArticle?.versions.some((version) => version.id === toVersionId)
    ? toVersionId
    : compareArticle?.representativeVersionId ?? "";

  const loadEditorialState = useCallback(async () => {
    try {
      const response = await managementFetch("/api/editorial", { cache: "no-store" });
      if (!response.ok) throw new Error("local database unavailable");
      const payload = await response.json() as { items?: EditorialItem[]; overrides?: ArticleOverride[]; decisions?: EditorialDecision[] };
      setEditorialItems(payload.items ?? []);
      setOverrides(payload.overrides ?? []);
      setDecisions(payload.decisions ?? []);
      setStorageState("ready");
    } catch {
      setStorageState("unavailable");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadEditorialState();
      const initial = readHash();
      if (initial.view) setView(initial.view);
      if (initial.article && corpus.articles.some((article) => article.id === initial.article)) {
        setSelectedArticleId(initial.article);
        setCompareArticleId(initial.article);
      }
      if (initial.from) setFromVersionId(initial.from);
      if (initial.to) setToVersionId(initial.to);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [corpus.articles, loadEditorialState]);

  useEffect(() => {
    const params = new URLSearchParams({ view });
    if (selectedArticleId) params.set("article", view === "compare" ? compareArticleId : selectedArticleId);
    if (view === "compare") {
      if (validFromVersionId) params.set("from", validFromVersionId);
      if (validToVersionId) params.set("to", validToVersionId);
    }
    const next = `#${params.toString()}`;
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
  }, [compareArticleId, selectedArticleId, validFromVersionId, validToVersionId, view]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        setSearchOpen(true);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const openArticle = useCallback((article: ArticleRecord, destination: StudioView = "library") => {
    setSelectedArticleId(article.id);
    if (destination === "compare") {
      setCompareArticleId(article.id);
      setFromVersionId(article.versions[0]?.id ?? "");
      setToVersionId(article.representativeVersionId);
    }
    setView(destination);
    setSearchOpen(false);
  }, []);

  const saveOverride = useCallback(async (payload: SaveOverridePayload) => {
    const response = await managementFetch("/api/editorial", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_override", ...payload }),
    });
    if (!response.ok) throw new Error("未能保存文章状态");
    const result = await response.json() as { override: ArticleOverride; decision: EditorialDecision };
    setOverrides((items) => [result.override, ...items.filter((item) => item.articleId !== result.override.articleId)]);
    setDecisions((items) => [result.decision, ...items]);
    setStorageState("ready");
    showToast("已将文章状态保存到本地计划库");
  }, [showToast]);

  const recordOpportunity = useCallback(async (opportunity: OpportunityRecord, status: "已入候选池" | "稍后" | "不做") => {
    const response = await managementFetch("/api/editorial", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "accept_opportunity",
        status,
        sourceOpportunityId: opportunity.id,
        kind: "topic",
        title: opportunity.title,
        summary: opportunity.rationale,
        rationale: opportunity.evidence.join("；"),
        confidence: opportunity.signalStrength,
        linkedArticleIds: opportunity.relatedArticleIds,
        nextAction: opportunity.nextAction,
      }),
    });
    if (!response.ok) throw new Error("未能记录选题决定");
    const result = await response.json() as { item: EditorialItem };
    setEditorialItems((items) => [result.item, ...items.filter((item) => item.id !== result.item.id && item.sourceOpportunityId !== opportunity.id)]);
    setStorageState("ready");
    showToast(status === "已入候选池" ? "已加入选题候选池，尚未创建委托或系列" : `已记录为“${status}”`);
  }, [showToast]);

  const recordIdentityDecision = useCallback(async (article: ArticleRecord, decision: "confirm_group" | "review_split") => {
    const response = await managementFetch("/api/editorial", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "record_identity_decision",
        articleId: article.id,
        decision,
        ruleVersion: article.identityRuleVersion,
        inputSha256: article.identityInputDigest,
      }),
    });
    if (!response.ok) throw new Error("未能保存身份判断");
    const result = await response.json() as { decision: EditorialDecision };
    setDecisions((items) => [result.decision, ...items]);
    showToast(decision === "confirm_group" ? "已确认当前候选组，并绑定这次输入摘要" : "已标记为待拆分，不会把这一组当作正式身份");
  }, [showToast]);

  const searchResults = useMemo(
    () => query.trim() ? corpus.articles.filter((article) => articleMatches(article, query)).slice(0, 9) : [],
    [corpus.articles, query],
  );
  const overridesByArticle = useMemo(() => new Map(overrides.map((item) => [item.articleId, item])), [overrides]);
  const decisionsByArticle = useMemo(() => {
    const grouped = new Map<string, EditorialDecision[]>();
    decisions.filter((item) => item.subjectType === "article" || item.subjectType === "identity").forEach((item) => grouped.set(item.subjectId, [...(grouped.get(item.subjectId) ?? []), item]));
    return grouped;
  }, [decisions]);

  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-seal" aria-hidden="true">文</div>
          <div>
            <strong>文脉</strong>
            <span>个人编辑工作台</span>
          </div>
        </div>
        <nav className="primary-nav" aria-label="主要导航">
          {NAV_ITEMS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={view === item.id ? "nav-item active" : "nav-item"}
              onClick={() => setView(item.id)}
            >
              <span className="nav-mark" aria-hidden="true">{item.mark}</span>
              <span className="nav-copy"><b>{item.label}</b><small>{item.hint}</small></span>
              {item.id === "topics" && corpus.opportunities.length ? <span className="nav-count">{corpus.opportunities.length}</span> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`storage-dot ${storageState}`} aria-hidden="true" />
          <div><b>{storageState === "ready" ? "可记录本地计划" : storageState === "loading" ? "正在连接计划库" : "当前只能查看索引"}</b><small>不会改动源稿</small></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="search-wrap">
            <label htmlFor="global-search">搜索文章、主题、版本或来源</label>
            <input
              ref={searchRef}
              id="global-search"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
              placeholder="输入标题、主题、版本或来源…"
              autoComplete="off"
            />
            <kbd>Ctrl K</kbd>
            {searchOpen && query.trim() ? (
              <div className="search-results" role="dialog" aria-label="搜索结果">
                <div className="search-result-head"><span>{searchResults.length ? `前 ${searchResults.length} 条匹配` : "没有匹配"}</span><button type="button" onClick={() => setSearchOpen(false)}>关闭</button></div>
                {searchResults.map((article) => (
                  <button type="button" key={article.id} className="search-result" onClick={() => openArticle(article)}>
                    <span className="search-result-kind">{article.kind}</span>
                    <span><b>{article.title}</b><small>{article.tags.slice(0, 3).join(" · ")} · {article.versionCount} 个版本</small></span>
                  </button>
                ))}
                {!searchResults.length ? <p className="empty-search">试试别的关键词，或到“文章库”按类型和状态筛选。</p> : null}
              </div>
            ) : null}
          </div>
          <div className="index-meta">
            <span>索引 {relativeDate(corpus.generatedAt)}</span>
            <b>{corpus.algorithmVersion}</b>
          </div>
        </header>

        <main className="main-canvas">
          {view === "dashboard" ? (
            <DashboardView corpus={corpus} items={editorialItems} onView={setView} onOpenArticle={openArticle} onRecordOpportunity={recordOpportunity} storageState={storageState} />
          ) : null}
          {view === "library" ? (
            <LibraryView
              corpus={corpus}
              query={query}
              selectedArticle={selectedArticle}
              override={selectedArticle ? overridesByArticle.get(selectedArticle.id) : undefined}
              decisions={selectedArticle ? decisionsByArticle.get(selectedArticle.id) ?? [] : []}
              onSelect={setSelectedArticleId}
              onOpenView={(destination) => {
                if (destination === "compare" && selectedArticle) {
                  setCompareArticleId(selectedArticle.id);
                  setFromVersionId(selectedArticle.versions[0]?.id ?? "");
                  setToVersionId(selectedArticle.representativeVersionId);
                }
                setView(destination);
              }}
              onSaveOverride={saveOverride}
              onRecordIdentity={recordIdentityDecision}
              storageState={storageState}
            />
          ) : null}
          {view === "compare" && compareArticle ? (
            <CompareView key={compareArticle.id} corpus={corpus} article={compareArticle} onArticleChange={(id) => { const article = corpus.articles.find((item) => item.id === id); setCompareArticleId(id); setSelectedArticleId(id); setFromVersionId(article?.versions[0]?.id ?? ""); setToVersionId(article?.representativeVersionId ?? ""); }} fromVersionId={validFromVersionId} toVersionId={validToVersionId} onFromChange={setFromVersionId} onToChange={setToVersionId} />
          ) : null}
          {view === "baseline" && selectedArticle ? (
            <BaselineView corpus={corpus} article={selectedArticle} onArticleChange={setSelectedArticleId} />
          ) : null}
          {view === "graph" ? (
            <GraphView corpus={corpus} initialSelectedId={selectedArticle?.id ?? null} onOpenArticle={(article) => openArticle(article, "library")} />
          ) : null}
          {view === "topics" ? (
            <TopicsView corpus={corpus} items={editorialItems} onRecord={recordOpportunity} storageState={storageState} onOpenArticle={openArticle} />
          ) : null}
          {view === "series" ? (
            <SeriesView corpus={corpus} items={editorialItems} onViewTopics={() => setView("topics")} onOpenArticle={openArticle} />
          ) : null}
          {view === "rules" ? <RulesView corpus={corpus} showToast={showToast} /> : null}
        </main>
      </section>
      <div className={toast ? "toast visible" : "toast"} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

function ViewHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return (
    <div className="view-header">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {actions ? <div className="view-actions">{actions}</div> : null}
    </div>
  );
}

function StatusPill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" | "danger" | "blue" }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function ConfidencePill({ value }: { value: string }) {
  return <span className={`confidence-pill ${confidenceClass(value)}`}>{value}置信</span>;
}

function SignalPill({ value }: { value: string }) {
  return <span className={`confidence-pill ${confidenceClass(value)}`}>{value}信号</span>;
}

interface DashboardProps {
  corpus: CorpusData;
  items: EditorialItem[];
  storageState: "loading" | "ready" | "unavailable";
  onView: (view: StudioView) => void;
  onOpenArticle: (article: ArticleRecord, destination?: StudioView) => void;
  onRecordOpportunity: (opportunity: OpportunityRecord, status: "已入候选池" | "稍后" | "不做") => Promise<void>;
}

function DashboardView({ corpus, items, storageState, onView, onOpenArticle, onRecordOpportunity }: DashboardProps) {
  const articleWorks = corpus.articles.filter((article) => article.kind === "文章");
  const totalVersions = articleWorks.reduce((sum, article) => sum + article.versionCount, 0);
  const pendingIdentity = corpus.articles.filter((article) => article.identityConfidence !== "高").length;
  const lead = corpus.opportunities[0];
  const statusEntries = Object.entries(corpus.stats.publicationStateCounts);
  const recent = articleWorks.slice(0, 5);
  const acceptedIds = new Set(items.map((item) => item.sourceOpportunityId).filter(Boolean));

  return (
    <div className="view-stack dashboard-view">
      <ViewHeader eyebrow="今日编辑提示 · 自动整理" title="今天先处理哪件事？" description="这里汇总值得查看的缺口、风险和已有积累；文件数量不等于工作进展。" actions={<button type="button" className="button secondary" onClick={() => onView("topics")}>查看全部选题线索</button>} />

      {lead ? (
        <section className="editorial-brief">
          <div className="brief-number" aria-hidden="true">01</div>
          <div className="brief-main">
            <div className="brief-kicker"><span>{lead.type}</span><SignalPill value={lead.signalStrength} /></div>
            <h2>{lead.title}</h2>
            <p>{lead.rationale}</p>
            <div className="brief-evidence">
              {lead.evidence.slice(0, 2).map((item) => <span key={item}>{item}</span>)}
            </div>
          </div>
          <aside className="brief-action">
            <small>建议先做</small>
            <p>{lead.nextAction}</p>
            <div className="button-row">
              <button type="button" className="button primary" disabled={storageState !== "ready" || acceptedIds.has(lead.id)} onClick={() => void onRecordOpportunity(lead, "已入候选池")}>{acceptedIds.has(lead.id) ? "已记录" : "加入候选池"}</button>
              <button type="button" className="button text" onClick={() => onView("topics")}>查看建议依据</button>
            </div>
          </aside>
        </section>
      ) : null}

      <section className="metric-ledger" aria-label="当前索引概况">
        <div><span>文章族候选</span><b>{formatNumber(corpus.stats.articleFamilies)}</b><small>身份关系仍待人工确认</small></div>
        <div><span>版本快照</span><b>{formatNumber(totalVersions)}</b><small>仅从源稿读取</small></div>
        <div><span>主题节点</span><b>{formatNumber(corpus.stats.topicCount)}</b><small>{formatNumber(corpus.stats.relationEdges)} 条候选关系，含 {formatNumber(corpus.stats.workRelationEdges)} 条作品邻接</small></div>
        <div><span>待确认身份</span><b>{formatNumber(pendingIdentity)}</b><small>来自中、低置信度归组</small></div>
        <div><span>已留存候选</span><b>{formatNumber(items.filter((item) => item.status === "已入候选池" || item.status === "已采纳").length)}</b><small>{storageState === "ready" ? "已写入本地计划库" : "尚未写入计划库"}</small></div>
      </section>

      <div className="dashboard-grid">
        <section className="paper-panel action-list-panel">
          <div className="panel-heading"><div><span className="eyebrow">优先查看</span><h2>把线索变成下一步</h2></div><button type="button" className="text-link" onClick={() => onView("topics")}>查看全部 {corpus.opportunities.length} 项</button></div>
          <ol className="ranked-actions">
            {corpus.opportunities.slice(0, 3).map((opportunity, index) => (
              <li key={opportunity.id}>
                <span className="rank-index">0{index + 1}</span>
                <div><div className="action-meta"><span>{opportunity.type}</span><SignalPill value={opportunity.signalStrength} /></div><h3>{opportunity.title}</h3><p>{opportunity.nextAction}</p></div>
                <button type="button" aria-label={`打开${opportunity.title}`} onClick={() => onView("topics")}>→</button>
              </li>
            ))}
          </ol>
        </section>

        <section className="paper-panel publication-panel">
          <div className="panel-heading"><div><span className="eyebrow">发布证据</span><h2>提交、记录与公开访问分别核验</h2></div></div>
          <div className="state-bars">
            {statusEntries.map(([label, count]) => {
              const ratio = count / Math.max(1, corpus.stats.articleFamilies);
              return (
                <div className="state-bar" key={label}>
                  <div><span>{label}</span><b>{count}</b></div>
                  <i><em style={{ width: `${Math.max(4, ratio * 100)}%` }} /></i>
                </div>
              );
            })}
          </div>
          <p className="panel-note">“已打包”仅表示 publish / release / package manifest 按路径或哈希列出了该制品；草稿、素材和 QA manifest 不会提升发布状态。</p>
        </section>

        <section className="paper-panel recent-panel">
          <div className="panel-heading"><div><span className="eyebrow">最近更新</span><h2>刚有新版本的作品</h2></div><button type="button" className="text-link" onClick={() => onView("library")}>打开文章库</button></div>
          <div className="recent-list">
            {recent.map((article) => (
              <button type="button" key={article.id} onClick={() => onOpenArticle(article)}>
                <span className="recent-date">{relativeDate(article.updatedAt)}</span>
                <span className="recent-copy"><b>{article.title}</b><small>{article.versionCount} 个版本 · {article.platforms.join(" / ")}</small></span>
                <span className="recent-status">{article.editorialState}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="paper-panel identity-panel">
          <div className="panel-heading"><div><span className="eyebrow">导入前先核对身份</span><h2>这些文件是不是同一件作品？</h2></div></div>
          <div className="identity-figure"><b>{formatNumber(corpus.stats.contentFamilies)}</b><span>个内容对象候选</span></div>
          <p>扫描器读取 {formatNumber(corpus.stats.sourceFiles)} 个正文文件和 {formatNumber(corpus.stats.metadataFiles)} 个结构化元数据文件。标题、路径、哈希和相似度只能提出分组建议，不能自动确认作品身份。</p>
          <button type="button" className="button secondary full" onClick={() => onView("rules")}>查看索引依据与刷新方法</button>
        </section>
      </div>
    </div>
  );
}

interface LibraryProps {
  corpus: CorpusData;
  query: string;
  selectedArticle?: ArticleRecord;
  override?: ArticleOverride;
  decisions: EditorialDecision[];
  storageState: "loading" | "ready" | "unavailable";
  onSelect: (id: string) => void;
  onOpenView: (view: StudioView) => void;
  onSaveOverride: (payload: SaveOverridePayload) => Promise<void>;
  onRecordIdentity: (article: ArticleRecord, decision: "confirm_group" | "review_split") => Promise<void>;
}

function LibraryView({ corpus, query, selectedArticle, override, decisions, storageState, onSelect, onOpenView, onSaveOverride, onRecordIdentity }: LibraryProps) {
  const [kind, setKind] = useState("文章");
  const [status, setStatus] = useState("全部");
  const [sort, setSort] = useState<"updated" | "versions" | "title">("updated");
  const rows = useMemo(() => {
    const filtered = corpus.articles.filter((article) =>
      (kind === "全部" || article.kind === kind) &&
      (status === "全部" || article.editorialState === status) &&
      articleMatches(article, query),
    );
    return [...filtered].sort((left, right) => {
      if (sort === "versions") return right.versionCount - left.versionCount;
      if (sort === "title") return left.title.localeCompare(right.title, "zh-CN");
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }, [corpus.articles, kind, query, sort, status]);
  const statuses = [...new Set(corpus.articles.filter((article) => kind === "全部" || article.kind === kind).map((article) => article.editorialState))];

  return (
    <div className="view-stack library-view">
      <ViewHeader eyebrow="作品、来源与治理资料" title="文章库" description="在这里核对逻辑作品与物理文件的关系：文件名只是线索，稳定 ID 才标识作品。" actions={<span className="result-count">已显示 {rows.length} / {corpus.articles.length} 个对象</span>} />
      <div className="library-layout">
        <section className="library-index">
          <div className="filter-rail">
            <div className="segmented" aria-label="内容类型">
              {["全部", "文章", "来源材料", "创作工具", "研究与治理"].map((value) => <button type="button" key={value} className={kind === value ? "active" : ""} onClick={() => { setKind(value); setStatus("全部"); }}>{value}</button>)}
            </div>
            <div className="compact-selects">
              <label>按状态筛选<select value={status} onChange={(event) => setStatus(event.target.value)}><option>全部</option>{statuses.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label>排序方式<select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="updated">最近更新</option><option value="versions">版本数量</option><option value="title">标题</option></select></label>
            </div>
          </div>

          <div className="article-table" role="table" aria-label="文章对象列表">
            <div className="article-table-head" role="row"><span>作品</span><span>四轴状态</span><span>版本</span><span>更新</span></div>
            {rows.map((article) => (
              <button type="button" key={article.id} role="row" className={selectedArticle?.id === article.id ? "article-row selected" : "article-row"} onClick={() => onSelect(article.id)}>
                <span className="article-primary"><small>{article.id} · {article.kind}</small><b>{article.title}</b><em>{article.tags.slice(0, 3).join(" · ") || "未识别主题"}</em></span>
                <span className="state-stack"><i>{article.editorialState}</i><i>{article.publicationState}</i><i>身份 {article.identityConfidence}</i></span>
                <span className="version-cell"><b>{article.versionCount}</b><small>{formatCompact(article.charCount)} 字</small></span>
                <span className="updated-cell">{relativeDate(article.updatedAt)}</span>
              </button>
            ))}
            {!rows.length ? <div className="empty-state"><b>没有找到匹配对象</b><p>清除搜索词，或换一个内容类型和状态筛选。</p></div> : null}
          </div>
        </section>

        {selectedArticle ? (
          <ArticleDetailPanel key={`${selectedArticle.id}:${override?.updatedAt ?? "unloaded"}`} article={selectedArticle} override={override} decisions={decisions} storageState={storageState} onOpenView={onOpenView} onSave={onSaveOverride} onRecordIdentity={onRecordIdentity} />
        ) : <aside className="article-detail empty-detail"><span>先选择一篇文章</span><p>随后可查看它的身份依据、四轴状态、候选文件关系和来源路径。</p></aside>}
      </div>
    </div>
  );
}

function ArticleDetailPanel({ article, override, decisions, storageState, onOpenView, onSave, onRecordIdentity }: { article: ArticleRecord; override?: ArticleOverride; decisions: EditorialDecision[]; storageState: "loading" | "ready" | "unavailable"; onOpenView: (view: StudioView) => void; onSave: (payload: SaveOverridePayload) => Promise<void>; onRecordIdentity: (article: ArticleRecord, decision: "confirm_group" | "review_split") => Promise<void> }) {
  const [editorialState, setEditorialState] = useState(override?.editorialState ?? "inbox");
  const [notes, setNotes] = useState(override?.notes ?? "");
  const [favorite, setFavorite] = useState(override?.favorite ?? false);
  const [saving, setSaving] = useState(false);
  const [identitySaving, setIdentitySaving] = useState(false);
  const machineGate = gateStateFor(article);
  const identityDecision = decisions.find((item) => item.subjectType === "identity" && item.inputSha256 === article.identityInputDigest);
  const identityDisposition = identityDecision?.value.decision === "confirm_group" ? "人工确认" : identityDecision?.value.decision === "review_split" ? "待拆分" : article.identityStatus === "bound-explicit" ? "显式绑定" : "候选";

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        articleId: article.id,
        editorialState,
        gateState: machineGate.label,
        evidenceHealth: evidenceHealthFor(article),
        favorite,
        notes,
        seriesId: override?.seriesId ?? null,
        ruleVersion: article.stateRuleVersion,
        inputSha256: article.stateInputDigest,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="article-detail">
      <div className="detail-topline"><span>{article.id}</span><button type="button" className={favorite ? "favorite active" : "favorite"} aria-label={favorite ? "取消重点" : "标为重点"} onClick={() => setFavorite((value) => !value)}>重点</button></div>
      <h2>{article.title}</h2>
      <p className="detail-summary">{article.summary}</p>
      <div className="detail-tags">{article.tags.slice(0, 6).map((tag) => <span key={tag}>{tag}</span>)}</div>

      <section className="four-axis">
        <h3>四轴状态</h3>
        <div><span>编辑</span><b>{override ? editorialStateLabel(override.editorialState) : article.editorialState}</b><small>{override ? "人工记录的状态" : "根据文件角色推断"}</small></div>
        <div><span>门禁</span><b>{machineGate.label}</b><small>自动信号只提示待看事项，不代表通过</small></div>
        <div><span>发布</span><b>{article.publicationState}</b><small>汇总自 {article.publicationVariants.length} 条版本与渠道记录</small></div>
        <div><span>证据</span><b>{article.evidenceHealth}</b><small>{article.stateRuleVersion} · 输入 {article.stateInputDigest.slice(0, 8)}…</small></div>
      </section>

      <details className="source-files publication-breakdown"><summary>查看各版本、各渠道的发布证据</summary>{article.publicationVariants.map((item) => {
        const version = article.versions.find((candidate) => candidate.id === item.versionId);
        return <div key={item.id}>
          <code>{item.platform} · {item.state}{item.conflict ? " · 证据冲突" : ""}</code>
          <small>版本：{version?.name ?? item.versionId}</small>
          <small>SHA-256：{version?.contentHash ?? "未知"}</small>
          {item.evidence.length ? item.evidence.map((event) => <span className="publication-event" key={event.id}>
            <b>{event.state}</b>
            <small>{event.bindingStrength === "strong" ? "制品级绑定" : "弱绑定候选"} · {event.qualifiesForRollup ? "计入汇总" : "不计入汇总"}</small>
            <small>依据：{event.bindingBasis.join("；")}</small>
            <small>来源：{event.sourcePath}</small>
            <small>时间：{event.observedAt ?? "未记录"} · 方法：{event.verificationMethod ?? "未记录"}</small>
            <small>{event.url ? `URL：${event.url}` : "URL：未记录"}</small>
            <small>{event.explanation}</small>
          </span>) : <small>尚未找到绑定到该制品的 manifest、提交回执、后台记录或公开核验记录。</small>}
        </div>;
      })}</details>

      <section className="identity-proof">
        <div><h3>身份归组 · {identityDisposition}</h3><ConfidencePill value={article.identityConfidence} /></div>
        <ul>{article.identityBasis.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <small>规则 {article.identityRuleVersion} · 输入 {article.identityInputDigest.slice(0, 8)}…</small>
        <div className="identity-actions"><button type="button" disabled={storageState !== "ready" || identitySaving} onClick={() => { setIdentitySaving(true); void onRecordIdentity(article, "confirm_group").finally(() => setIdentitySaving(false)); }}>确认当前分组</button><button type="button" disabled={storageState !== "ready" || identitySaving} onClick={() => { setIdentitySaving(true); void onRecordIdentity(article, "review_split").finally(() => setIdentitySaving(false)); }}>标记待拆分</button></div>
      </section>

      <section className="version-mini-tree">
        <div><h3>候选制品与渠道变体</h3><span>{article.variants.length} 个渠道变体 · {article.versionCount} 个不可变制品</span></div>
        <ol>
          {article.versions.slice(-5).reverse().map((version) => (
            <li key={version.id} className={version.id === article.representativeVersionId ? "current" : ""}>
              <i aria-hidden="true" />
              <div><b>{version.name}</b><small>{version.role} · {formatDate(version.modifiedAt)} · {version.pathAliases.length} 个路径别名</small></div>
              {version.id === article.representativeVersionId ? <span>索引推荐稿</span> : null}
            </li>
          ))}
        </ol>
        {article.versionCount > 5 ? <small>另有 {article.versionCount - 5} 个较早节点</small> : null}
      </section>

      <div className="detail-actions">
        <button type="button" className="button primary" onClick={() => onOpenView("compare")} disabled={article.versionCount < 2}>比较版本</button>
        <button type="button" className="button secondary" onClick={() => onOpenView("baseline")}>查看基线</button>
        <button type="button" className="button secondary" onClick={() => onOpenView("graph")}>打开图谱</button>
      </div>

      <section className="editor-note">
        <div className="editor-note-head"><h3>人工编辑记录</h3><span>{storageState === "ready" ? "本地保存" : "当前只读"}</span></div>
        <label>编辑阶段<select value={editorialState} disabled={storageState !== "ready"} onChange={(event) => setEditorialState(event.target.value)}>{EDITORIAL_STATE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>下一步或判断<textarea value={notes} disabled={storageState !== "ready"} onChange={(event) => setNotes(event.target.value)} placeholder="例如：先补充一个反例，再确认唯一主版本。" /></label>
        <button type="button" className="button dark full" disabled={storageState !== "ready" || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存人工状态"}</button>
        <div className="decision-history"><b>不可变决策记录</b>{decisions.slice(0, 3).map((decision) => <small key={decision.id}>{formatDate(decision.createdAt)} · {decision.ruleVersion} · 输入 {decision.inputSha256.slice(0, 8)}…</small>)}{!decisions.length ? <small>尚未保存人工决定</small> : null}</div>
      </section>

      <details className="source-files"><summary>查看内容制品、路径别名与哈希</summary>{article.versions.flatMap((version) => version.pathAliases.map((path) => <div key={`${version.id}:${path}`}><code>{path}</code><small>{version.artifactId} · SHA-256 {version.contentHash.slice(0, 12)}…</small></div>))}</details>
    </aside>
  );
}

interface CompareProps {
  corpus: CorpusData;
  article: ArticleRecord;
  onArticleChange: (id: string) => void;
  fromVersionId: string;
  toVersionId: string;
  onFromChange: (id: string) => void;
  onToChange: (id: string) => void;
}

function CompareView({ corpus, article, onArticleChange, fromVersionId, toVersionId, onFromChange, onToChange }: CompareProps) {
  const [mode, setMode] = useState<"text" | "structure" | "metadata">("text");
  const [layout, setLayout] = useState<"unified" | "split">("split");
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(500);
  const [versionTexts, setVersionTexts] = useState<Record<string, string>>({});
  const [contentError, setContentError] = useState("");
  const from = article.versions.find((version) => version.id === fromVersionId) ?? article.versions[0];
  const to = article.versions.find((version) => version.id === toVersionId) ?? article.versions.at(-1)!;
  const fromCached = versionTexts[from.id];
  const toCached = versionTexts[to.id];
  const fromText = from.text ?? fromCached ?? "";
  const toText = to.text ?? toCached ?? "";
  const contentReady = (typeof from.text === "string" || fromCached !== undefined) && (typeof to.text === "string" || toCached !== undefined);
  const operations = useMemo(() => diffBlocks(fromText, toText), [fromText, toText]);
  const summary = useMemo(() => diffSummary(operations), [operations]);
  const filteredOperations = useMemo(() => operations.filter((operation) => showUnchanged || operation.kind !== "same"), [operations, showUnchanged]);
  const comparableArticles = corpus.articles.filter((item) => item.versionCount > 1);

  useEffect(() => {
    const missingIds = [from, to]
      .filter((version) => typeof version.text !== "string" && versionTexts[version.id] === undefined)
      .map((version) => version.id);
    if (!missingIds.length) return;

    const controller = new AbortController();
    const params = new URLSearchParams();
    missingIds.forEach((id) => params.append("id", id));
    managementFetch(`/api/version-text?${params.toString()}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("正文读取失败");
        return response.json() as Promise<{ versions: Record<string, { text: string }> }>;
      })
      .then((payload) => {
        setVersionTexts((current) => ({
          ...current,
          ...Object.fromEntries(Object.entries(payload.versions).map(([id, record]) => [id, record.text])),
        }));
        setContentError("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setContentError("未能读取版本正文。你仍可查看元数据对比，并稍后重新打开文本差异。");
      });
    return () => controller.abort();
  }, [from, to, versionTexts]);

  const structure = (text: string) => {
    const markdownHeadings = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({ level: match[1].length, title: match[2].trim() }));
    if (markdownHeadings.length) return markdownHeadings;
    return text.split(/\n\s*\n/).map((value) => value.trim()).filter((value) => value.length >= 3 && value.length <= 36 && !/[。！？]$/.test(value)).slice(0, 30).map((title) => ({ level: 2, title }));
  };
  const fromOutline = structure(fromText);
  const toOutline = structure(toText);

  const metadataRows: Array<[string, string, string]> = [
    ["稿件角色", from.role, to.role],
    ["格式", from.format.toUpperCase(), to.format.toUpperCase()],
    ["字数", formatNumber(from.charCount), formatNumber(to.charCount)],
    ["段落", String(from.metrics.paragraphCount), String(to.metrics.paragraphCount)],
    ["标题层级", String(from.metrics.headingCount), String(to.metrics.headingCount)],
    ["平均句长", String(from.metrics.averageSentenceLength), String(to.metrics.averageSentenceLength)],
    ["证据提示", String(from.metrics.evidenceMarkerCount), String(to.metrics.evidenceMarkerCount)],
    ["案例提示", String(from.metrics.exampleMarkerCount), String(to.metrics.exampleMarkerCount)],
    ["平台", from.platforms.join(" / "), to.platforms.join(" / ")],
    ["修改时间", formatDate(from.modifiedAt), formatDate(to.modifiedAt)],
    ["内容摘要", `${from.contentHash.slice(0, 12)}…`, `${to.contentHash.slice(0, 12)}…`],
  ];

  return (
    <div className="view-stack compare-view">
      <ViewHeader eyebrow="版本对比" title="把两个版本放在一起看" description="先查看文本差异，再分别核对结构与元数据；整个比较过程只读，不会改写源文件。" />
      <section className="compare-controls paper-panel">
        <label className="wide-select">作品<select value={article.id} onChange={(event) => onArticleChange(event.target.value)}>{comparableArticles.map((item) => <option key={item.id} value={item.id}>{item.title}（{item.versionCount} 版）</option>)}</select></label>
        <div className="version-pair-select">
          <label><span>从</span><select value={from.id} onChange={(event) => { onFromChange(event.target.value); setVisibleLimit(500); }}>{article.versions.map((version) => <option key={version.id} value={version.id}>{formatDate(version.modifiedAt)} · {version.name}</option>)}</select><small>{from.role} · {formatCompact(from.charCount)} 字</small></label>
          <button type="button" className="swap-button" aria-label="交换两个版本" onClick={() => { onFromChange(to.id); onToChange(from.id); setVisibleLimit(500); }}>⇄</button>
          <label><span>到</span><select value={to.id} onChange={(event) => { onToChange(event.target.value); setVisibleLimit(500); }}>{article.versions.map((version) => <option key={version.id} value={version.id}>{formatDate(version.modifiedAt)} · {version.name}</option>)}</select><small>{to.role} · {formatCompact(to.charCount)} 字</small></label>
        </div>
        {from.id === to.id ? <p className="inline-warning">当前选中了同一版本两次。请选择另一版本后再看差异。</p> : null}
        {from.textTruncated || to.textTruncated ? <p className="inline-warning">至少一份索引正文经过明确降采样；本次差异不能代表完整原文。请按默认参数重新刷新后再比较。</p> : null}
      </section>

      <section className="diff-workbench">
        <div className="diff-toolbar">
          <div className="segmented compact"><button type="button" className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>文本差异</button><button type="button" className={mode === "structure" ? "active" : ""} onClick={() => setMode("structure")}>结构差异</button><button type="button" className={mode === "metadata" ? "active" : ""} onClick={() => setMode("metadata")}>元数据</button></div>
          {mode === "text" ? <div className="diff-options"><button type="button" className={layout === "split" ? "active" : ""} onClick={() => setLayout("split")}>并排</button><button type="button" className={layout === "unified" ? "active" : ""} onClick={() => setLayout("unified")}>统一</button><label><input type="checkbox" checked={showUnchanged} onChange={(event) => { setShowUnchanged(event.target.checked); setVisibleLimit(500); }} /> 显示未改段落</label></div> : null}
        </div>

        <div className="diff-summary-strip">
          <span><i className="added" /> 新增 <b>{summary.added}</b></span>
          <span><i className="removed" /> 删除 <b>{summary.removed}</b></span>
          <span><i className="same" /> 未变 <b>{summary.same}</b></span>
          <em>完整计算 {formatNumber(operations.length)} 个操作 · 字数变化 {to.charCount - from.charCount >= 0 ? "+" : ""}{formatNumber(to.charCount - from.charCount)}</em>
        </div>

        {!contentReady && mode !== "metadata" ? <div className="compare-loading"><b>正在读取这两个版本的正文</b><span>首屏只加载目录、证据和指标；打开比较时才读取正文。</span></div> : null}
        {contentError && mode !== "metadata" ? <p className="inline-warning">{contentError}</p> : null}

        {mode === "text" && contentReady ? (
          <div className={`diff-body ${layout}`}>
            {filteredOperations.slice(0, visibleLimit).map((operation, index) => (
              layout === "unified" ? (
                <div className={`diff-block ${operation.kind}`} key={`${operation.kind}-${index}`}><span>{operation.kind === "added" ? "+" : operation.kind === "removed" ? "−" : " "}</span><p>{operation.text}</p></div>
              ) : (
                <div className={`diff-row ${operation.kind}`} key={`${operation.kind}-${index}`}>
                  <div className={operation.kind === "added" ? "blank" : operation.kind}><span>{operation.leftIndex !== undefined ? operation.leftIndex + 1 : ""}</span><p>{operation.kind === "added" ? "" : operation.text}</p></div>
                  <div className={operation.kind === "removed" ? "blank" : operation.kind}><span>{operation.rightIndex !== undefined ? operation.rightIndex + 1 : ""}</span><p>{operation.kind === "removed" ? "" : operation.text}</p></div>
                </div>
              )
            ))}
            {visibleLimit < filteredOperations.length ? <button type="button" className="show-context" onClick={() => setVisibleLimit((value) => value + 500)}>再显示 {Math.min(500, filteredOperations.length - visibleLimit)} 个操作（尚有 {filteredOperations.length - visibleLimit} 个）</button> : null}
            {!showUnchanged && summary.same > 0 ? <button type="button" className="show-context" onClick={() => { setShowUnchanged(true); setVisibleLimit(500); }}>展开 {summary.same} 个未改段落作为上下文</button> : null}
          </div>
        ) : null}

        {mode === "structure" && contentReady ? (
          <div className="outline-compare">
            <div><header><span>旧版大纲</span><b>{fromOutline.length} 节</b></header>{fromOutline.map((item, index) => <p key={`${item.title}-${index}`} style={{ paddingLeft: `${(item.level - 1) * 14}px` }}><span>{index + 1}</span>{item.title}</p>)}</div>
            <div><header><span>新版大纲</span><b>{toOutline.length} 节</b></header>{toOutline.map((item, index) => <p key={`${item.title}-${index}`} style={{ paddingLeft: `${(item.level - 1) * 14}px` }}><span>{index + 1}</span>{item.title}</p>)}</div>
          </div>
        ) : null}

        {mode === "metadata" ? (
          <div className="metadata-compare"><div className="metadata-head"><span>字段</span><span>{from.name}</span><span>{to.name}</span></div>{metadataRows.map(([label, left, right]) => <div key={label} className={left === right ? "" : "changed"}><b>{label}</b><span>{left}</span><span>{right}</span></div>)}</div>
        ) : null}
      </section>

      <p className="method-note"><b>比较范围：</b>默认索引会抽取完整正文，差异统计覆盖全部段落；界面每次仅增量渲染 500 个操作以保持响应。语义、观点和证据的对比要先有人确认相关节点；当前的文本相似度不等于语义事实。</p>
    </div>
  );
}

function BaselineView({ corpus, article, onArticleChange }: { corpus: CorpusData; article: ArticleRecord; onArticleChange: (id: string) => void }) {
  const [comparisonMode, setComparisonMode] = useState<"raw" | "distribution">("raw");
  const articleWorks = corpus.articles.filter((item) => item.kind === "文章");
  const raw = article.baseline.raw;
  const percentileValues = article.baseline.portfolioPercentile;
  const values = comparisonMode === "raw" ? raw : percentileValues;
  const comparison = Object.fromEntries(Object.keys(values).map((key) => [key, 50]));
  const version = currentVersion(article);
  const hasQualifiedDeliveryEvidence = article.publicationVariants.some((item) => item.evidence.some((event) => event.qualifiesForRollup));
  const hasWeakDeliveryClue = article.publicationVariants.some((item) => item.evidence.some((event) => !event.qualifiesForRollup));

  const gates = [
    { label: "读者与问题", state: "unknown", result: "待人工判断", evidence: "未建立结构化 commission/brief" },
    { label: "结构与承诺", state: raw["结构度代理"] >= 62 ? "signal" : "warn", result: raw["结构度代理"] >= 62 ? "结构信号较强" : "结构信号偏弱", evidence: `${version.metrics.headingCount} 个标题，平均段落 ${version.metrics.averageParagraphLength} 字` },
    { label: "事实与证据", state: raw["证据密度代理"] >= 55 ? "signal" : "warn", result: raw["证据密度代理"] >= 55 ? "证据线索较多" : "证据线索偏少", evidence: `${version.metrics.urlCount} 个链接，${version.metrics.numberMarkerCount} 个数字标记，${version.metrics.quoteCount} 处引语；不判断来源有效性` },
    { label: "自然中文", state: version.metrics.longSentenceRatio < 0.24 ? "signal" : "warn", result: version.metrics.longSentenceRatio < 0.24 ? "未触发长句提醒" : "长句偏多", evidence: `平均句长 ${version.metrics.averageSentenceLength}，长句比例 ${Math.round(version.metrics.longSentenceRatio * 100)}%` },
    { label: "案例与边界", state: version.metrics.exampleMarkerCount >= 3 ? "signal" : "warn", result: version.metrics.exampleMarkerCount >= 3 ? "检测到案例词" : "案例/反例线索偏少", evidence: `${version.metrics.exampleMarkerCount} 个案例提示；是否构成有效案例仍需人工确认` },
    { label: "视觉与资产", state: "unknown", result: "未纳入", evidence: "当前索引未解析插图、版权与替代文本" },
    { label: "渠道适配", state: article.platforms.some((platform) => platform !== "源稿") ? "signal" : "unknown", result: article.platforms.some((platform) => platform !== "源稿") ? "存在平台变体" : "未识别平台变体", evidence: article.platforms.join(" / ") },
    { label: "交付证据", state: hasQualifiedDeliveryEvidence ? "signal" : hasWeakDeliveryClue ? "warn" : "unknown", result: hasQualifiedDeliveryEvidence ? article.publicationState : hasWeakDeliveryClue ? "存在待复核线索" : "未知", evidence: article.publicationEvidence[0] ?? "没有精确绑定的结构化发布证据" },
  ];

  return (
    <div className="view-stack baseline-view">
      <ViewHeader eyebrow="版本化结构代理 · v1.1" title="创作基线不是总分" description="雷达图只展示可复核的结构信号，不能替任何人工门禁作出通过结论。" actions={<label className="header-select">选择作品<select value={article.id} onChange={(event) => onArticleChange(event.target.value)}>{articleWorks.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>} />

      <section className="baseline-hero">
        <div className="baseline-chart-panel paper-panel">
          <div className="panel-heading"><div><span className="eyebrow">{comparisonMode === "raw" ? "原始代理" : "作品集分布"}</span><h2>{article.title}</h2></div><div className="segmented compact"><button type="button" className={comparisonMode === "raw" ? "active" : ""} onClick={() => setComparisonMode("raw")}>原始代理</button><button type="button" className={comparisonMode === "distribution" ? "active" : ""} onClick={() => setComparisonMode("distribution")}>作品集分位</button></div></div>
          <BaselineRadar values={values} comparison={comparison} comparisonLabel={comparisonMode === "raw" ? "中性参考线 50" : "作品集中位"} />
          <p className="chart-caption">输入：索引推荐稿 {version.name} · {article.baseline.profileVersion} · 样本 {article.baseline.sampleSize} 个文章候选族</p>
        </div>

        <div className="baseline-dimensions paper-panel">
          <div className="panel-heading"><div><span className="eyebrow">五项机器代理</span><h2>每一轴都能查看依据</h2></div></div>
          {Object.entries(raw).map(([key, value]) => (
            <div className="dimension-row" key={key}>
              <div><b>{key.replace("代理", "")}</b><small>作品集第 {percentileValues[key] ?? 0} 百分位</small></div>
              <span>{Math.round(value)}</span>
              <i><em style={{ width: `${Math.max(2, Math.min(100, value))}%` }} /></i>
              <p>{corpus.baselineDefinitions.find((item) => item.key === key)?.description ?? "由版本数量和稿件角色形成的流程代理。"}</p>
            </div>
          ))}
          <div className="baseline-warning"><b>不能据此得出“文章质量 82 分”</b><p>这些数值只描述可复核的结构信号。问题是否重要、观点是否成立、语言是否自然，仍要由编辑判断。</p></div>
        </div>
      </section>

      <section className="gate-matrix paper-panel">
        <div className="panel-heading"><div><span className="eyebrow">扫描信号与人工缺口</span><h2>八维检查面板</h2></div><span className="rubric-version">{article.baseline.profileVersion}</span></div>
        <div className="gate-table"><div className="gate-head"><span>维度</span><span>状态</span><span>当前证据</span></div>{gates.map((gate) => <div key={gate.label} className="gate-row"><b>{gate.label}</b><span className={`gate-state ${gate.state}`}>{gate.result}</span><p>{gate.evidence}</p></div>)}</div>
      </section>

      <p className="method-note"><b>何时失效：</b>当前结构信号绑定规则版本与输入摘要 {article.stateInputDigest.slice(0, 12)}…；正文或元数据变化后会生成新摘要。真正的门禁通过仍需要 ReviewRun 记录审核人、证据和时间；本站不会把自动信号写成“通过”。</p>
    </div>
  );
}

function GraphView({ corpus, initialSelectedId, onOpenArticle }: { corpus: CorpusData; initialSelectedId: string | null; onOpenArticle: (article: ArticleRecord) => void }) {
  const defaultTopic = corpus.topics[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? defaultTopic);
  const node = corpus.graph.nodes.find((item) => item.id === selectedId);
  const article = corpus.articles.find((item) => item.id === selectedId);
  const topic = corpus.topics.find((item) => item.id === selectedId);
  const connections = corpus.graph.edges.filter((edge) => edge.source === selectedId || edge.target === selectedId).map((edge) => ({ edge, other: corpus.graph.nodes.find((item) => item.id === (edge.source === selectedId ? edge.target : edge.source)) })).filter((item) => item.other);

  return (
    <div className="view-stack graph-view">
      <ViewHeader eyebrow="文章只是图谱中的一种对象" title="主题与作品的候选关系" description="这里展示主题和作品之间的自动候选关系；它不是观点—证据知识图谱，关系也尚未经过人工确认。" actions={<div className="graph-legend"><span><i className="topic" />主题</span><span><i className="article" />文章/资料</span></div>} />
      <div className="graph-layout">
        <section className="graph-stage paper-panel">
          <div className="graph-stage-head"><div><b>{selectedId ? "当前节点及直接关联" : "当前作品集概览"}</b><span>{selectedId ? `${connections.length} 条直接候选关系` : `${corpus.graph.nodes.length} 个节点`}</span></div><button type="button" className="text-link" onClick={() => setSelectedId(defaultTopic)}>查看默认主题</button></div>
          <KnowledgeGraphCanvas nodes={corpus.graph.nodes} edges={corpus.graph.edges} selectedId={selectedId} onSelect={setSelectedId} />
          <p className="canvas-help">点击节点可查看它的直接关系；窄屏或键盘用户可在右侧关系列表完成同样的操作。</p>
        </section>
        <aside className="graph-inspector paper-panel">
          <span className="eyebrow">当前节点</span>
          <div className="node-type-line"><span>{node?.type === "topic" ? "主题" : article?.kind ?? "对象"}</span>{article ? <ConfidencePill value={article.identityConfidence} /> : topic ? <SignalPill value={topic.signalStrength} /> : null}</div>
          <h2>{node?.label ?? "选择一个节点"}</h2>
          {article ? <><p>{article.summary}</p><div className="inspector-facts"><span>版本 <b>{article.versionCount}</b></span><span>主题 <b>{article.tags.length}</b></span><span>关系 <b>{connections.length}</b></span></div><button type="button" className="button primary full" onClick={() => onOpenArticle(article)}>打开作品详情</button></> : null}
          {topic ? <><p>规则命中 {topic.articleCount} 个文章族、{topic.contentObjectCount} 个相关内容对象；有 {topic.missingStages.length} 类候选题型尚未命中。</p><div className="inspector-facts"><span>文章 <b>{topic.articleCount}</b></span><span>可汇总发布 <b>{topic.publishedCount}</b></span><span>规则信号 <b>{topic.opportunityScore}</b></span></div></> : null}
          <div className="connection-list" aria-label="直接候选关系">
            <h3>直接候选关系</h3>
            {connections.slice(0, 18).map(({ edge, other }) => <button type="button" key={edge.id} onClick={() => setSelectedId(other!.id)}><span>{edge.type}</span><b>{other!.label}</b><small>{edge.status} · {edge.evidence[0]} · {edge.confidence}规则信号</small></button>)}
            {!connections.length ? <p className="empty-mini">当前规则尚未为这个节点找到足够强的自动连接。</p> : null}
          </div>
        </aside>
      </div>
      <section className="graph-evidence-note"><b>候选关系的依据</b><span>来源范围</span><span>算法版本</span><span>置信档</span><span>suggested</span><p>首版仅写入标题、路径、词表和文本相似度生成的候选边。尚未逐边人工裁决，因此不能把它们当作观点—证据关系。</p></section>
    </div>
  );
}

function TopicsView({ corpus, items, onRecord, storageState, onOpenArticle }: { corpus: CorpusData; items: EditorialItem[]; onRecord: (opportunity: OpportunityRecord, status: "已入候选池" | "稍后" | "不做") => Promise<void>; storageState: "loading" | "ready" | "unavailable"; onOpenArticle: (article: ArticleRecord, destination?: StudioView) => void }) {
  const types = ["全部", ...new Set(corpus.opportunities.map((item) => item.type))];
  const [type, setType] = useState("全部");
  const [busy, setBusy] = useState<string | null>(null);
  const decisions = new Map(items.filter((item) => item.sourceOpportunityId).map((item) => [item.sourceOpportunityId!, item]));
  const opportunities = corpus.opportunities.filter((item) => type === "全部" || item.type === type);

  const record = async (opportunity: OpportunityRecord, status: "已入候选池" | "稍后" | "不做") => {
    setBusy(opportunity.id);
    try { await onRecord(opportunity, status); } finally { setBusy(null); }
  };

  return (
    <div className="view-stack topics-view">
      <ViewHeader eyebrow="可解释建议 · 不替代委托" title="选题雷达" description="候选来自版本债务、题型关键词缺口、平台变体、证据缺口和连接空白；流量本身不能决定要写什么。" actions={<span className="result-count">{corpus.opportunities.length} 个候选 · 已记录 {items.filter((item) => item.kind === "topic" || item.kind === "series").length} 个</span>} />
      <div className="topic-overview">
        <section className="topic-map paper-panel">
          <div className="panel-heading"><div><span className="eyebrow">主题规则命中</span><h2>已积累内容与待补题型放在一起看</h2></div></div>
          <div className="topic-coverage-list">
            {corpus.topics.slice(0, 9).map((topic) => <div key={topic.id}><span><b>{topic.label}</b><small>{topic.articleCount} 篇文章 · {topic.contentObjectCount} 个对象</small></span><i><em style={{ width: `${Math.min(100, 12 + topic.articleCount * 16)}%` }} /></i><strong>{topic.opportunityScore}</strong><SignalPill value={topic.signalStrength} /></div>)}
          </div>
        </section>
        <section className="opportunity-method paper-panel">
          <span className="eyebrow">当前排序依据</span><h2>暂时只看结构信号</h2>
          <ol><li><b>规则信号</b><span>已计算版本债务、题型命中和连接缺口</span></li><li><b>编辑价值</b><span>尚未人工确认</span></li><li><b>证据准备</b><span>尚未人工评估</span></li><li><b>时效与杠杆</b><span>尚未参与计算</span></li><li><b>受众需要</b><span>尚未参与计算</span></li></ol>
          <p>分数仅用于安排查看顺序，不是成功率，也不代表已经决定创作。</p>
        </section>
      </div>

      <div className="filter-rail topic-filters"><div className="segmented wrap">{types.map((value) => <button type="button" key={value} className={type === value ? "active" : ""} onClick={() => setType(value)}>{value}</button>)}</div></div>
      <section className="opportunity-grid">
        {opportunities.map((opportunity, index) => {
          const decision = decisions.get(opportunity.id);
          const related = opportunity.relatedArticleIds.map((id) => corpus.articles.find((article) => article.id === id)).filter((article): article is ArticleRecord => Boolean(article)).slice(0, 3);
          return (
            <article className="opportunity-card" key={opportunity.id}>
              <div className="opportunity-card-top"><span className="opportunity-index">{String(index + 1).padStart(2, "0")}</span><span className="opportunity-type">{opportunity.type}</span><SignalPill value={opportunity.signalStrength} /><strong><small>规则排序</small>{opportunity.score}</strong></div>
              <h2>{opportunity.title}</h2><p>{opportunity.rationale}</p>
              <div className="opportunity-evidence"><b>这项建议依据什么</b>{opportunity.evidence.map((evidence) => <span key={evidence}>{evidence}</span>)}<span>{opportunity.whyNow}</span></div>
              <div className="opportunity-blockers"><b>创建委托前还缺什么</b><span>{opportunity.blockers.join(" · ")}</span></div>
              <div className="next-action"><b>下一步</b><p>{opportunity.nextAction}</p></div>
              {related.length ? <div className="related-works"><span>关联作品</span>{related.map((article) => <button type="button" key={article.id} onClick={() => onOpenArticle(article)}>{article.title}</button>)}</div> : null}
              <div className="decision-row">
                {decision ? <StatusPill tone={decision.status === "不做" ? "neutral" : "blue"}>{decision.status === "已采纳" ? "历史记录：已入候选池" : `已记录：${decision.status}`}</StatusPill> : <>
                  <button type="button" className="button primary" disabled={storageState !== "ready" || busy === opportunity.id} onClick={() => void record(opportunity, "已入候选池")}>加入候选池</button>
                  <button type="button" className="button secondary" disabled={storageState !== "ready" || busy === opportunity.id} onClick={() => void record(opportunity, "稍后")}>稍后</button>
                  <button type="button" className="button text" disabled={storageState !== "ready" || busy === opportunity.id} onClick={() => void record(opportunity, "不做")}>不做</button>
                </>}
              </div>
            </article>
          );
        })}
      </section>
      {storageState === "unavailable" ? <p className="method-note"><b>当前只能查看：</b>候选仍可阅读；要保存“加入候选池、稍后或不做”，需先让本地 D1 数据库可用。</p> : null}
    </div>
  );
}

const SERIES_STAGES = ["为什么", "是什么", "怎么做", "真实案例", "失败复盘", "治理与规模化"];

function SeriesView({ corpus, items, onViewTopics, onOpenArticle }: { corpus: CorpusData; items: EditorialItem[]; onViewTopics: () => void; onOpenArticle: (article: ArticleRecord, destination?: StudioView) => void }) {
  const accepted = items.filter((item) => item.kind === "series" && item.status === "已采纳");
  return (
    <div className="view-stack series-view">
      <ViewHeader eyebrow="系列不是标签，而是按顺序兑现的读者承诺" title="系列构想" description="这里按六类读者问题生成槽位草图；建立正式系列前，仍要人工写明承诺、顺序和完成条件。" actions={<button type="button" className="button primary" onClick={onViewTopics}>查看选题候选池</button>} />
      {accepted.length ? <section className="accepted-series paper-panel"><div className="panel-heading"><div><span className="eyebrow">旧记录兼容显示</span><h2>历史系列候选仍需重新确认</h2></div></div><div className="accepted-series-list">{accepted.map((item) => <div key={item.id}><StatusPill tone="blue">旧记录：{item.status}</StatusPill><h3>{item.title}</h3><p>{item.nextAction}</p><small>这不是正式委托；关联 {item.linkedArticleIds.length} 个文章族 · 历史规则强度 {item.confidence}</small></div>)}</div></section> : null}

      {corpus.seriesSuggestions.slice(0, 6).map((series) => {
        const relatedArticles = series.articleIds.map((id) => corpus.articles.find((article) => article.id === id)).filter((article): article is ArticleRecord => Boolean(article));
        return (
          <section className="series-board" key={series.id}>
            <header><div><span className="eyebrow">{series.topic} · 自动生成的草图</span><h2>{series.title}</h2><p>可考虑的下一题型：{series.nextArticle}</p></div><div className="series-progress"><b>{series.coveredStages.length}/{SERIES_STAGES.length}</b><span>关键词命中</span><i><em style={{ width: `${series.coveredStages.length / SERIES_STAGES.length * 100}%` }} /></i></div></header>
            <div className="series-lanes">
              {SERIES_STAGES.map((stage) => {
                const covered = series.coveredStages.includes(stage);
                const matching = relatedArticles.filter((article) => article.stages.includes(stage)).slice(0, 2);
                return <div className={covered ? "series-lane covered" : "series-lane gap"} key={stage}><div className="lane-head"><span>{stage}</span><b>{covered ? "疑似命中" : "未命中"}</b></div>{matching.map((article) => <button type="button" key={article.id} onClick={() => onOpenArticle(article)}><span>{article.editorialState}</span><b>{article.title}</b><small>{article.versionCount} 个版本 · 待人工确认题型</small></button>)}{!matching.length ? <div className="empty-slot"><i aria-hidden="true">+</i><span>{covered ? "检测到关键词线索，尚未绑定文章" : "规则暂未找到承担该问题的文章"}</span></div> : null}</div>;
              })}
            </div>
          </section>
        );
      })}
      <p className="method-note"><b>当前边界：</b>题型命中来自标题和开头关键词的推断。尚未人工确认的文章不会被自动改名、移动或合并；加入候选池也不会自动创建委托或正式系列。</p>
    </div>
  );
}

function RulesView({ corpus, showToast }: { corpus: CorpusData; showToast: (message: string) => void }) {
  const copyRefresh = async () => {
    try {
      await navigator.clipboard.writeText("npm run data:refresh");
      showToast("刷新命令已复制");
    } catch {
      showToast("请手动复制：npm run data:refresh");
    }
  };
  const references = [
    { name: "BBC", rule: "故事线、委托与编辑责任分开", href: "https://iptc.org/thirdparty/bbc-ontologies/storyline.html" },
    { name: "The Guardian", rule: "结构化 story bundle 与读者问题回流", href: "https://theguardian.engineering/blog/info-2019-may-10-structured-content-benefits-for-creating-and-publishing-articles" },
    { name: "The New York Times", rule: "修订日志与规划上下文进入同一系统", href: "https://open.nytimes.com/its-all-part-of-the-plan-e165dba39842" },
    { name: "Arc XP", rule: "状态触发任务，草稿/发布/修订边界明确", href: "https://dev.arcxp.com/concepts/content-model-ans/understanding-arc-native-specification-ans/" },
    { name: "NPR", rule: "主题、系列与集合是显式对象", href: "https://npr.github.io/content-distribution-service/" },
    { name: "Associated Press", rule: "版本、关系、分类与更正是一等元数据", href: "https://developer.ap.org/ap-metadata-services/" },
  ];

  return (
    <div className="view-stack rules-view">
      <ViewHeader eyebrow="33 个官方来源 · 6 套成熟体系" title="数据、规则与证据边界" description="在这里查看索引为何这样组织、哪些内容是事实或推断，以及怎样刷新本地语料。" />
      <section className="research-verdict">
        <span className="eyebrow">调研结论</span><h2>核心是作品与故事线，不是给 CMS 或 Git 换界面</h2><p>工作台以逻辑作品和故事线为核心，把本地文件保留为可携带的真相源；不可变版本和证据事件用于审计，基线与机会图谱只辅助判断。</p>
        <div className="verdict-principles"><div><b>先识别故事对象</b><span>文章只是主题、观点、证据和系列中的一个节点</span></div><div><b>正文、修订与发布分开记录</b><span>本地成品不会自动变成外部事实</span></div><div><b>更正事件（目标能力）</b><span>成熟形态应记录影响范围；当前尚未实现 Correction 对象</span></div><div><b>分析只提出待问的问题</b><span>机器建议不能替代委托与编辑判断</span></div></div>
      </section>

      <section className="reference-grid">
        {references.map((reference) => <a key={reference.name} href={reference.href} target="_blank" rel="noreferrer"><span>{reference.name}</span><b>{reference.rule}</b><small>查看官方材料 ↗</small></a>)}
      </section>

      <div className="rules-grid">
        <section className="paper-panel data-contract">
          <div className="panel-heading"><div><span className="eyebrow">本次语料快照</span><h2>这次索引读取了什么</h2></div></div>
          <div className="data-facts"><div><b>{formatNumber(corpus.stats.sourceFiles)}</b><span>正文文件</span></div><div><b>{formatNumber(corpus.stats.metadataFiles)}</b><span>元数据文件</span></div><div><b>{formatNumber(corpus.stats.contentFamilies)}</b><span>内容对象候选</span></div><div><b>{formatNumber(corpus.stats.articleFamilies)}</b><span>候选文章族</span></div></div>
          <p>完整盘点还发现 2,375 个物理文件。站内索引只纳入能抽取正文的 MD、TXT、DOCX 和安全元数据；网站工程、依赖、缓存及压缩包内部文件不在索引范围内。</p>
          <p><b>{formatNumber(corpus.stats.unboundMetadataFiles)} 个元数据文件仍只是未归属线索</b>：同目录不再自动继承。另有 {formatNumber(corpus.stats.artifactIdentityConflicts)} 个相同内容制品关联多个内容对象，是否复用或应合并要由人工判断。</p>
          <div className="format-ledger">{Object.entries(corpus.stats.extensionCounts).map(([format, count]) => <span key={format}><b>{format.toUpperCase()}</b>{count}</span>)}</div>
        </section>

        <section className="paper-panel refresh-panel">
          <div className="panel-heading"><div><span className="eyebrow">刷新本地索引</span><h2>新增文章后，重新读取一次</h2></div></div>
          <p>刷新会重新读取父目录，并重写站点生成的索引和稳定 ID 映射；不会移动、改名或改写原文章。</p>
          <button type="button" className="command-box" onClick={() => void copyRefresh()}><code>npm run data:refresh</code><span>复制</span></button>
          <ol><li>把新稿放入现有文章目录</li><li>在文脉项目目录运行刷新命令</li><li>重启或刷新本地网站</li><li>优先核对低置信度归组</li></ol>
        </section>
      </div>

      <section className="rule-layers paper-panel">
        <div className="panel-heading"><div><span className="eyebrow">“完成”需要分开看</span><h2>四条状态轴，各自需要证据</h2></div></div>
        <div className="layer-row"><span>编辑状态</span><b>写到哪一步？</b><p>待归类 → 计划 → 研究 → 写作 → 审阅 → 人工批准 → 维护</p></div>
        <div className="layer-row"><span>门禁状态</span><b>自动扫描观察到了什么？</b><p>未运行 / 结构信号 / 机器提醒 / 待人工判断；不会自动产生“通过”</p></div>
        <div className="layer-row"><span>发布状态</span><b>这个版本在这个平台有哪些可汇总记录？</b><p>未记录 / 未规划 / 已打包 / 已提交 / 有发布记录 / 曾公开核验；不完整记录仅是弱线索</p></div>
        <div className="layer-row"><span>证据健康度</span><b>状态依据能否锁定当前制品？</b><p>有精确绑定证据 / 存在弱线索 / 证据冲突 / 未知</p></div>
      </section>

      <section className="baseline-rules paper-panel">
        <div className="panel-heading"><div><span className="eyebrow">机器代理定义</span><h2>能计算，也要说明计算对象</h2></div><span>{corpus.algorithmVersion}</span></div>
        <div className="definition-list">{corpus.baselineDefinitions.map((definition) => <div key={definition.key}><b>{definition.key}</b><p>{definition.description}</p></div>)}</div>
      </section>

      <section className="limitations paper-panel">
        <div className="panel-heading"><div><span className="eyebrow">当前限制</span><h2>首版尚未具备的能力</h2></div></div>
        <ul>{corpus.analysisNotes.map((note) => <li key={note}>{note}</li>)}<li>遇到标题漂移、同一 note_id 对应多个标题，或冻结清单与后续回执冲突时，保留事件链，不让单一字段覆盖历史。</li><li>当前没有重新探测外部公开页面；“曾公开核验”只表示本地结构化记录中保留了历史证据。</li></ul>
      </section>
    </div>
  );
}
