"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { managementFetch } from "./management-fetch";

type Source = { id?: string; sourceKey?: string; origin?: string; version?: { contentSha256?: string | null; metadata?: { title?: string } } | null; access?: { result?: string } | null; bindings?: unknown[] };
type Manifest = { sources?: Source[]; page?: { hasMore?: boolean } };
const label = (value: unknown, fallback = "未知") => typeof value === "string" && value.trim() ? value : fallback;
const fetchManifest = async (signal: AbortSignal) => { const response = await managementFetch("/api/shared-source/v1?view=manifest", { cache: "no-store", signal }); const payload = await response.json() as { data?: Manifest; error?: { message?: string } }; if (!response.ok) throw new Error(payload.error?.message || "本地投影暂不可读取"); return payload.data ?? null; };

export default function SharedSourcePanel() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [message, setMessage] = useState("正在读取本地元数据投影…");
  const [failed, setFailed] = useState(false); const controller = useRef<AbortController | null>(null);
  const read = useCallback(async () => {
    controller.current?.abort(); const signal = new AbortController(); controller.current = signal; setFailed(false); setMessage("正在读取本地元数据投影…");
    try { const response = await managementFetch("/api/shared-source/v1?view=manifest", { cache: "no-store", signal: signal.signal }); const payload = await response.json() as { data?: Manifest; error?: { message?: string } }; if (!response.ok) throw new Error(payload.error?.message || "本地投影暂不可读取"); if (!signal.signal.aborted) { setManifest(payload.data ?? null); setMessage("仅展示 0031 已登记的来源元数据；未读取正文。"); } } catch (error) { if (!signal.signal.aborted) { setManifest(null); setFailed(true); setMessage(error instanceof Error ? error.message : "本地投影暂不可读取"); } }
  }, []);
  useEffect(() => {
    const request = new AbortController(); controller.current = request;
    void fetchManifest(request.signal).then((data) => { if (!request.signal.aborted) { setManifest(data); setMessage("仅展示 0031 已登记的来源元数据；未读取正文。"); } }).catch((error) => { if (!request.signal.aborted) { setManifest(null); setFailed(true); setMessage(error instanceof Error ? error.message : "本地投影暂不可读取"); } });
    return () => request.abort();
  }, []);
  const sources = manifest?.sources ?? [];
  return <section className="shared-source-panel view-page" aria-labelledby="shared-sources-title">
    <header className="shared-source-heading"><span className="eyebrow">只读元数据登记</span><h1 id="shared-sources-title">共享来源</h1><p>当前能力：metadata projection only。没有导入、正文读取、MCP 工具或已配置的 Library 连接。</p></header>
    <p id="truth-layers" aria-live="polite" role={failed ? "alert" : undefined}>{message}</p>
    <button type="button" onClick={() => void read()}>重新读取本地投影</button>
    {sources.length ? <ul id="source-registry" className="shared-source-list">{sources.map((source) => <li key={source.id ?? source.sourceKey}><h2>{label(source.version?.metadata?.title, label(source.sourceKey))}</h2><dl><dt>来源类型</dt><dd>{label(source.origin)}</dd><dt>版本短 hash</dt><dd>{source.version?.contentSha256?.slice(0, 12) || "未知"}</dd><dt>访问</dt><dd>{label(source.access?.result)}</dd><dt>绑定</dt><dd>{source.bindings?.length ?? 0}</dd></dl></li>)}</ul> : !failed && <p>尚无可展示的来源元数据。</p>}
    {manifest?.page?.hasMore === true && <p>仅显示当前页；仍有后续来源。</p>}
  </section>;
}
