"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import MarkdownPreview from "./MarkdownPreview";
import { managementFetch } from "./management-fetch";
import type { WorkbenchArticle, WorkbenchVersion } from "./workbench-types";

type PreviewRequest = {
  articleId: string;
  initialVersionId: string;
};

type VersionTextPayload = {
  versions?: Record<string, { text?: string; textHash?: string }>;
  error?: string;
};

type WorkspaceVersionPayload = {
  revisions?: Array<{ id?: string; bodyText?: string }>;
  error?: string;
};

type TextState =
  | { status: "empty"; versionId: "" }
  | { status: "loading"; versionId: string }
  | { status: "ready"; versionId: string; text: string }
  | { status: "error"; versionId: string; message: string };

export interface OpenArticlePreviewOptions {
  versionId?: string;
}

export interface ArticlePreviewContextValue {
  activeArticleId: string | null;
  isOpen: boolean;
  loadingArticleId: string | null;
  failedArticleId: string | null;
  openArticlePreview: (articleId: string, options?: OpenArticlePreviewOptions) => void;
  closeArticlePreview: () => void;
  getArticle: (articleId: string) => WorkbenchArticle | undefined;
}

export interface ArticlePreviewProviderProps {
  articles: WorkbenchArticle[];
  onOpenWorkspace: (articleId: string) => void | Promise<void>;
  canOpenWorkspace?: (article: WorkbenchArticle) => boolean;
  children: ReactNode;
}

const ArticlePreviewContext = createContext<ArticlePreviewContextValue | null>(null);

function preferredVersion(article: WorkbenchArticle, requestedId?: string): WorkbenchVersion | undefined {
  if (requestedId) {
    const requested = article.versions.find((version) => version.id === requestedId);
    if (requested) return requested;
  }
  return article.versions.find((version) => version.id === article.representativeVersionId)
    ?? article.versions.find((version) => version.id === article.currentVersionId)
    ?? article.versions[0];
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "正文读取失败，请重试。";
}

export function useArticlePreview(): ArticlePreviewContextValue {
  const context = useContext(ArticlePreviewContext);
  if (!context) throw new Error("useArticlePreview 必须在 ArticlePreviewProvider 内使用");
  return context;
}

export function ArticlePreviewProvider({ articles, onOpenWorkspace, canOpenWorkspace = () => true, children }: ArticlePreviewProviderProps) {
  const [request, setRequest] = useState<PreviewRequest | null>(null);
  const [loadedArticles, setLoadedArticles] = useState<WorkbenchArticle[]>([]);
  const [loadingArticleId, setLoadingArticleId] = useState<string | null>(null);
  const [failedArticleId, setFailedArticleId] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const textCacheRef = useRef(new Map<string, string>());
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailRequestEpochRef = useRef(0);
  const articlesById = useMemo(() => new Map([...articles, ...loadedArticles].map((article) => [article.id, article])), [articles, loadedArticles]);

  const getArticle = useCallback((articleId: string) => articlesById.get(articleId), [articlesById]);

  const closeArticlePreview = useCallback(() => {
    setRequest(null);
    const returnTarget = returnFocusRef.current;
    returnFocusRef.current = null;
    if (returnTarget) window.requestAnimationFrame(() => returnTarget.focus());
  }, []);

  const loadArticleDetail = useCallback(async (articleId: string, options?: OpenArticlePreviewOptions) => {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    const requestEpoch = ++detailRequestEpochRef.current;
    setLoadingArticleId(articleId);
    setFailedArticleId(null);
    try {
      const response = await managementFetch(`/api/corpus/v1?view=detail&articleId=${encodeURIComponent(articleId)}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as { data?: { article?: WorkbenchArticle }; error?: { message?: string } };
      if (!response.ok || !payload.data?.article) throw new Error(payload.error?.message || "文章详情读取失败，请重试。");
      if (controller.signal.aborted || requestEpoch !== detailRequestEpochRef.current) return;
      const article = payload.data.article;
      setLoadedArticles((current) => current.some((item) => item.id === article.id) ? current.map((item) => item.id === article.id ? article : item) : [...current, article]);
      setRequest({ articleId: article.id, initialVersionId: preferredVersion(article, options?.versionId)?.id ?? "" });
    } catch {
      if (!controller.signal.aborted && requestEpoch === detailRequestEpochRef.current) setFailedArticleId(articleId);
    } finally {
      if (requestEpoch === detailRequestEpochRef.current) setLoadingArticleId(null);
    }
  }, []);

  const openArticlePreview = useCallback((articleId: string, options?: OpenArticlePreviewOptions) => {
    const article = articlesById.get(articleId);
    const activeElement = document.activeElement;
    returnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    if (!article) {
      void loadArticleDetail(articleId, options);
      return;
    }
    setRequest({
      articleId,
      initialVersionId: preferredVersion(article, options?.versionId)?.id ?? "",
    });
  }, [articlesById, loadArticleDetail]);

  useEffect(() => () => detailAbortRef.current?.abort(), []);

  const versionCacheKey = useCallback((articleId: string, versionId: string) => `${articleId}:${versionId}`, []);
  const getCachedVersionText = useCallback((articleId: string, versionId: string) => textCacheRef.current.get(versionCacheKey(articleId, versionId)), [versionCacheKey]);

  const loadVersionText = useCallback(async (article: WorkbenchArticle, version: WorkbenchVersion, signal: AbortSignal): Promise<string> => {
    const cacheKey = versionCacheKey(article.id, version.id);
    const cached = textCacheRef.current.get(cacheKey);
    if (cached !== undefined) return cached;

    const response = await managementFetch(version.storage === "d1"
      ? `/api/workspace?articleId=${encodeURIComponent(article.id)}`
      : `/api/version-text?id=${encodeURIComponent(version.id)}`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    });
    let payload: VersionTextPayload | WorkspaceVersionPayload | null = null;
    try {
      payload = await response.json() as VersionTextPayload | WorkspaceVersionPayload;
    } catch {
      // A non-JSON error still receives a truthful HTTP fallback below.
    }
    const payloadError = payload && "error" in payload ? payload.error : undefined;
    if (!response.ok) throw new Error(payloadError || `正文读取失败（HTTP ${response.status}）`);
    const text = version.storage === "d1"
      ? (payload as WorkspaceVersionPayload | null)?.revisions?.find((revision) => revision.id === version.id)?.bodyText
      : (payload as VersionTextPayload | null)?.versions?.[version.id]?.text;
    if (typeof text !== "string") throw new Error("正文接口没有返回所选版本");
    if (!signal.aborted) textCacheRef.current.set(cacheKey, text);
    return text;
  }, [versionCacheKey]);

  const activeArticle = request ? articlesById.get(request.articleId) : undefined;
  const contextValue = useMemo<ArticlePreviewContextValue>(() => ({
    activeArticleId: activeArticle?.id ?? null,
    isOpen: Boolean(activeArticle),
    loadingArticleId,
    failedArticleId,
    openArticlePreview,
    closeArticlePreview,
    getArticle,
  }), [activeArticle, closeArticlePreview, failedArticleId, getArticle, loadingArticleId, openArticlePreview]);

  return (
    <ArticlePreviewContext.Provider value={contextValue}>
      {children}
      {request && activeArticle ? (
        <ArticlePreviewDialog
          key={activeArticle.id}
          article={activeArticle}
          initialVersionId={request.initialVersionId}
          getCachedVersionText={getCachedVersionText}
          loadVersionText={loadVersionText}
          onClose={closeArticlePreview}
          onOpenWorkspace={onOpenWorkspace}
          canOpenWorkspace={canOpenWorkspace(activeArticle)}
        />
      ) : null}
      <ArticlePreviewStyles />
    </ArticlePreviewContext.Provider>
  );
}

export interface ArticleQuickLinkProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  articleId: string;
  versionId?: string;
}

export function ArticleQuickLink({
  articleId,
  versionId,
  children,
  className = "",
  disabled,
  onClick,
  title,
  ...buttonProps
}: ArticleQuickLinkProps) {
  const { failedArticleId, getArticle, loadingArticleId, openArticlePreview } = useArticlePreview();
  const article = getArticle(articleId);

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) openArticlePreview(articleId, { versionId });
  };

  return (
    <button
      {...buttonProps}
      type={buttonProps.type ?? "button"}
      className={`article-quick-link ${className}`.trim()}
      aria-haspopup="dialog"
      data-article-id={articleId}
      disabled={disabled || loadingArticleId === articleId}
      title={title ?? (article ? `快速预览：${article.title}` : loadingArticleId === articleId ? "正在读取文章详情" : failedArticleId === articleId ? "详情读取失败；点击重试" : "读取文章详情后预览")}
      onClick={handleClick}
    >
      {children ?? article?.title ?? (loadingArticleId === articleId ? "正在读取…" : failedArticleId === articleId ? "重试预览" : "预览文章")}
    </button>
  );
}

interface ArticlePreviewDialogProps {
  article: WorkbenchArticle;
  initialVersionId: string;
  getCachedVersionText: (articleId: string, versionId: string) => string | undefined;
  loadVersionText: (article: WorkbenchArticle, version: WorkbenchVersion, signal: AbortSignal) => Promise<string>;
  onClose: () => void;
  onOpenWorkspace: (articleId: string) => void | Promise<void>;
  canOpenWorkspace: boolean;
}

function ArticlePreviewDialog({
  article,
  initialVersionId,
  getCachedVersionText,
  loadVersionText,
  onClose,
  onOpenWorkspace,
  canOpenWorkspace,
}: ArticlePreviewDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const initialText = initialVersionId ? getCachedVersionText(article.id, initialVersionId) : undefined;
  const [selectedVersionId, setSelectedVersionId] = useState(initialVersionId);
  const [retryCount, setRetryCount] = useState(0);
  const [textState, setTextState] = useState<TextState>(() => {
    if (!initialVersionId) return { status: "empty", versionId: "" };
    return initialText !== undefined
      ? { status: "ready", versionId: initialVersionId, text: initialText }
      : { status: "loading", versionId: initialVersionId };
  });

  const selectedVersion = article.versions.find((version) => version.id === selectedVersionId)
    ?? preferredVersion(article);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    dialog.addEventListener("keydown", handleEscape);
    closeButtonRef.current?.focus();
    return () => {
      dialog.removeEventListener("keydown", handleEscape);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, [onClose]);

  useEffect(() => {
    if (!selectedVersionId) return;
    const cached = getCachedVersionText(article.id, selectedVersionId);
    if (cached !== undefined) return;
    const version = article.versions.find((item) => item.id === selectedVersionId);
    if (!version) return;
    const controller = new AbortController();
    void loadVersionText(article, version, controller.signal)
      .then((text) => {
        if (!controller.signal.aborted) setTextState({ status: "ready", versionId: selectedVersionId, text });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setTextState({ status: "error", versionId: selectedVersionId, message: errorMessage(error) });
      });
    return () => controller.abort();
  }, [article, getCachedVersionText, loadVersionText, retryCount, selectedVersionId]);

  const chooseVersion = (versionId: string) => {
    const cached = getCachedVersionText(article.id, versionId);
    setSelectedVersionId(versionId);
    setTextState(cached !== undefined
      ? { status: "ready", versionId, text: cached }
      : { status: "loading", versionId });
  };

  const retry = () => {
    if (!selectedVersionId) return;
    setTextState({ status: "loading", versionId: selectedVersionId });
    setRetryCount((value) => value + 1);
  };

  const openWorkspace = () => {
    onClose();
    void onOpenWorkspace(article.id);
  };

  return (
    <dialog
      ref={dialogRef}
      className="article-preview-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <div className="article-preview-frame">
        <header className="article-preview-header">
          <div>
            <span className="article-preview-eyebrow">先核对源稿，再决定下一步 · {article.versionCount} 个源版本</span>
            <h2 id={titleId}>{article.title}</h2>
            <p id={descriptionId}>{article.summary || (canOpenWorkspace ? "选择一个源版本阅读并核对后，可进入文章工程继续制作。" : "这是只读资料：你可以阅读和追溯来源，但它不会变成 ArticleProject（文章工程）。")}</p>
            {article.tags.length ? (
              <div className="article-preview-tags" aria-label="文章标签">
                {article.tags.slice(0, 8).map((tag) => <span key={tag}>{tag}</span>)}
              </div>
            ) : null}
          </div>
          <button ref={closeButtonRef} type="button" className="article-preview-close" aria-label="关闭文章预览" onClick={onClose}>×</button>
        </header>

        <div className="article-preview-layout">
          <aside className="article-preview-versions" aria-label="源版本">
              <label htmlFor={`${titleId}-version`}>选择要阅读的源版本</label>
            <select
              id={`${titleId}-version`}
              value={selectedVersionId}
              disabled={!article.versions.length}
              onChange={(event) => chooseVersion(event.target.value)}
            >
              {article.versions.map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}
            </select>
            <div className="article-preview-version-list">
              {article.versions.map((version) => (
                <button
                  type="button"
                  key={version.id}
                  className={version.id === selectedVersionId ? "active" : ""}
                  aria-pressed={version.id === selectedVersionId}
                  onClick={() => chooseVersion(version.id)}
                >
                  <strong>{version.name}</strong>
                  <span>{version.role} · {version.charCount.toLocaleString("zh-CN")} 字</span>
                  <small>{formatDate(version.modifiedAt)}</small>
                </button>
              ))}
            </div>
          </aside>

          <main className="article-preview-reading">
            {selectedVersion ? (
              <>
                <div className="article-preview-version-head">
                  <div>
                    <span>{selectedVersion.role}</span>
                    <h3>{selectedVersion.name}</h3>
                  </div>
                  <dl>
                    <div><dt>字数</dt><dd>{selectedVersion.charCount.toLocaleString("zh-CN")} 字</dd></div>
                    <div><dt>更新时间</dt><dd>{formatDate(selectedVersion.modifiedAt)}</dd></div>
                    <div><dt>格式</dt><dd>{selectedVersion.format || "未记录"}</dd></div>
                  </dl>
                  <div className="article-preview-path">
                    <span>来源路径</span>
                    <code title={selectedVersion.path}>{selectedVersion.path || "未记录"}</code>
                  </div>
                </div>

                <section className="article-preview-body" aria-live="polite" aria-busy={textState.status === "loading"}>
                  {textState.status === "loading" && textState.versionId === selectedVersionId ? (
                    <div className="article-preview-loading" role="status">
                      <span aria-hidden="true" />
                      <strong>正在读取所选源版本</strong>
                      <p>正在读取这一份正文；其他版本不会同时加载。</p>
                    </div>
                  ) : null}
                  {textState.status === "error" && textState.versionId === selectedVersionId ? (
                    <div className="article-preview-error" role="alert">
                      <strong>所选正文暂时无法读取</strong>
                      <p>{textState.message}</p>
                      <button type="button" onClick={retry}>重新读取正文</button>
                    </div>
                  ) : null}
                  {textState.status === "ready" && textState.versionId === selectedVersionId ? (
                    <MarkdownPreview markdown={textState.text} empty="这个源版本没有可显示的正文；可选择其他版本核对。" />
                  ) : null}
                </section>
              </>
            ) : (
              <div className="article-preview-empty">
                <strong>还没有可阅读的源版本</strong>
                <p>{canOpenWorkspace ? "可进入文章工程检查当前工作区；这里没有正文时不会补造内容。" : "这个只读资料没有可显示正文；不会据此创建或猜测文章工程。"}</p>
              </div>
            )}
          </main>
        </div>

        <footer className="article-preview-footer">
          <span>快览只读取所选源稿：不会修改源稿，也不会自动创建分支。</span>
          <div>
            <button type="button" className="article-preview-secondary" onClick={onClose}>关闭</button>
            {canOpenWorkspace ? <button type="button" className="article-preview-primary" onClick={openWorkspace}>进入文章工程继续制作</button> : null}
          </div>
        </footer>
      </div>
    </dialog>
  );
}

function ArticlePreviewStyles() {
  return (
    <style>{`
      .article-quick-link {
        display: inline;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-weight: inherit;
        text-align: inherit;
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, var(--red, #c8432b) 50%, transparent);
        text-underline-offset: .22em;
        cursor: pointer;
      }
      .article-quick-link:hover { color: var(--red-deep, #9f3020); }
      .article-quick-link:focus-visible,
      .article-preview-dialog button:focus-visible,
      .article-preview-dialog select:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--red, #c8432b) 32%, transparent);
        outline-offset: 3px;
      }
      .article-quick-link:disabled { color: var(--muted, #727970); cursor: not-allowed; text-decoration-style: dotted; }
      .article-preview-dialog {
        width: min(1120px, calc(100vw - 32px));
        max-width: none;
        height: min(900px, calc(100dvh - 32px));
        max-height: none;
        margin: auto;
        padding: 0;
        overflow: hidden;
        border: 1px solid var(--line-strong, rgba(30, 33, 29, .28));
        border-radius: 8px;
        background: var(--paper-light, #fbf8f1);
        color: var(--ink, #1e211d);
        box-shadow: 0 28px 90px rgba(20, 24, 20, .28);
        font-family: var(--sans, system-ui, sans-serif);
        padding-bottom: env(safe-area-inset-bottom);
      }
      .article-preview-dialog::backdrop { background: rgba(20, 24, 20, .66); backdrop-filter: blur(4px); }
      .article-preview-frame { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; }
      .article-preview-header {
        position: relative;
        display: flex;
        justify-content: space-between;
        gap: 32px;
        padding: 24px 28px 20px;
        border-bottom: 1px solid var(--line, rgba(30, 33, 29, .16));
        background: linear-gradient(120deg, var(--paper-light, #fbf8f1), var(--paper, #f4f0e7));
      }
      .article-preview-eyebrow { color: var(--red-deep, #9f3020); font-size: 11px; font-weight: 800; letter-spacing: .14em; }
      .article-preview-header h2 { margin: 7px 0 6px; font-family: var(--serif, serif); font-size: clamp(25px, 3vw, 38px); line-height: 1.14; }
      .article-preview-header p { max-width: 760px; margin: 0; color: var(--ink-soft, #4e554e); font-size: 13px; line-height: 1.7; }
      .article-preview-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 13px; }
      .article-preview-tags span { padding: 4px 8px; border: 1px solid var(--line, rgba(30, 33, 29, .16)); background: rgba(255,255,255,.48); font-size: 10px; }
      .article-preview-close { width: 38px; height: 38px; flex: 0 0 auto; border: 1px solid var(--line, rgba(30, 33, 29, .16)); border-radius: 50%; background: rgba(255,255,255,.62); color: inherit; font-size: 24px; line-height: 1; cursor: pointer; }
      .article-preview-layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 0; }
      .article-preview-versions { min-height: 0; padding: 20px; overflow: auto; border-right: 1px solid var(--line, rgba(30, 33, 29, .16)); background: var(--paper, #f4f0e7); }
      .article-preview-versions > label { display: block; margin-bottom: 7px; color: var(--muted, #727970); font-size: 11px; font-weight: 700; }
      .article-preview-versions select { width: 100%; min-height: 42px; padding: 8px 10px; border: 1px solid var(--line-strong, rgba(30, 33, 29, .28)); border-radius: 3px; background: var(--paper-light, #fbf8f1); color: inherit; }
      .article-preview-version-list { display: grid; gap: 7px; margin-top: 15px; }
      .article-preview-version-list button { display: grid; gap: 4px; width: 100%; padding: 11px 12px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
      .article-preview-version-list button:hover { background: rgba(255,255,255,.52); }
      .article-preview-version-list button.active { border-color: var(--red, #c8432b); background: var(--red-soft, rgba(200, 67, 43, .1)); }
      .article-preview-version-list strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      .article-preview-version-list span,
      .article-preview-version-list small { color: var(--muted, #727970); font-size: 10px; line-height: 1.45; }
      .article-preview-reading { min-width: 0; min-height: 0; overflow: auto; background: var(--paper-light, #fbf8f1); }
      .article-preview-version-head { position: sticky; top: 0; z-index: 2; padding: 18px 28px 16px; border-bottom: 1px solid var(--line, rgba(30, 33, 29, .16)); background: color-mix(in srgb, var(--paper-light, #fbf8f1) 94%, transparent); backdrop-filter: blur(8px); }
      .article-preview-version-head > div:first-child { display: flex; align-items: center; gap: 10px; }
      .article-preview-version-head > div:first-child span { padding: 3px 7px; background: var(--blue-soft, rgba(49, 92, 115, .1)); color: var(--blue, #315c73); font-size: 10px; font-weight: 800; }
      .article-preview-version-head h3 { margin: 0; font-family: var(--serif, serif); font-size: 20px; }
      .article-preview-version-head dl { display: flex; flex-wrap: wrap; gap: 10px 24px; margin: 12px 0 0; }
      .article-preview-version-head dl div { display: flex; gap: 6px; font-size: 11px; }
      .article-preview-version-head dt { color: var(--muted, #727970); }
      .article-preview-version-head dd { margin: 0; font-weight: 700; }
      .article-preview-path { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; margin-top: 11px; font-size: 10px; }
      .article-preview-path span { color: var(--muted, #727970); }
      .article-preview-path code { overflow: hidden; font-family: var(--mono, monospace); text-overflow: ellipsis; white-space: nowrap; }
      .article-preview-body { max-width: 840px; min-height: 320px; margin: 0 auto; padding: 34px 42px 80px; }
      .article-preview-loading,
      .article-preview-error,
      .article-preview-empty { display: grid; justify-items: start; gap: 7px; padding: 30px; border: 1px solid var(--line, rgba(30, 33, 29, .16)); background: var(--paper, #f4f0e7); }
      .article-preview-loading span { width: 28px; height: 3px; background: var(--red, #c8432b); animation: article-preview-pulse 1.1s ease-in-out infinite alternate; }
      .article-preview-loading p,
      .article-preview-error p,
      .article-preview-empty p { margin: 0; color: var(--muted, #727970); font-size: 12px; }
      .article-preview-error { border-color: color-mix(in srgb, var(--red, #c8432b) 40%, transparent); background: var(--red-soft, rgba(200, 67, 43, .1)); }
      .article-preview-error button,
      .article-preview-secondary,
      .article-preview-primary { min-height: 40px; padding: 8px 14px; border: 1px solid var(--line-strong, rgba(30, 33, 29, .28)); border-radius: 3px; background: var(--paper-light, #fbf8f1); color: inherit; font-weight: 800; cursor: pointer; }
      .article-preview-footer { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 14px 20px; border-top: 1px solid var(--line, rgba(30, 33, 29, .16)); background: var(--paper, #f4f0e7); }
      .article-preview-footer > span { color: var(--muted, #727970); font-size: 11px; }
      .article-preview-footer > div { display: flex; gap: 8px; }
      .article-preview-primary { border-color: var(--red, #c8432b); background: var(--red, #c8432b); color: #fffaf0; }
      @keyframes article-preview-pulse { from { transform: scaleX(.35); transform-origin: left; opacity: .45; } to { transform: scaleX(1); opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .article-preview-loading span { animation: none; } }
      @media (max-width: 760px) {
        .article-preview-dialog { width: 100vw; height: 100dvh; border: 0; border-radius: 0; }
        .article-preview-header { padding: 18px; }
        .article-preview-header p { display: none; }
        .article-preview-layout { grid-template-columns: 1fr; }
        .article-preview-versions { overflow: visible; padding: 13px 18px; border-right: 0; border-bottom: 1px solid var(--line, rgba(30, 33, 29, .16)); }
        .article-preview-version-list { display: none; }
        .article-preview-body { padding: 26px 20px 64px; }
        .article-preview-version-head { padding: 14px 18px; }
        .article-preview-version-head dl { gap: 6px 16px; }
        .article-preview-footer { align-items: stretch; flex-direction: column; }
        .article-preview-footer > div { display: grid; grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 420px) {
        .article-preview-header { padding: 12px 16px 8px; }
        .article-preview-eyebrow, .article-preview-tags, .article-preview-version-list, .article-preview-version-head dl, .article-preview-path { display: none; }
        .article-preview-header h2 { margin: 0; font-size: 23px; }
        .article-preview-versions { padding: 10px 16px; }
        .article-preview-versions select { width: 100%; }
        .article-preview-reading { padding-bottom: calc(82px + env(safe-area-inset-bottom)); }
        .article-preview-footer { position: sticky; bottom: 0; padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
        .article-preview-footer > span { display: none; }
      }
    `}</style>
  );
}
