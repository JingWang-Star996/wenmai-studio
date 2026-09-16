"use client";

import { useCallback, useEffect, useState } from "react";
import { managementFetch } from "./management-fetch";

type Provider = Readonly<{
  id: "openai" | "ollama" | "deepseek" | "qwen";
  configured: boolean;
  ready: boolean;
  model: string | null;
  endpointClass: "managed_cloud" | "server_configured_lan";
}>;

type CustomAgent = Readonly<{
  id: string;
  configured: boolean;
  ready: boolean;
  model: string;
  preferredModel?: string;
  effectiveModel?: string;
  circuitState?: "open" | "disabled" | "not_applicable";
  fallbackReason?: string | null;
  fallbackVerification?: "not_verified";
  readinessSource: string;
}>;

type Route = Readonly<{
  phase: string;
  selectedRef: string;
  fallbackRefs: readonly string[];
  requiresHumanApproval: boolean;
  reasonCodes: readonly string[];
}>;

type RoutingCatalog = Readonly<{
  ok: true;
  schemaVersion: string;
  providers: readonly Provider[];
  customAgents: readonly CustomAgent[];
  routes: readonly Route[];
  boundaries: readonly string[];
}>;

const PROVIDER_LABELS: Record<Provider["id"], string> = {
  openai: "OpenAI（服务端快速模型）",
  ollama: "Ollama（服务端私有地址）",
  deepseek: "DeepSeek",
  qwen: "Qwen / DashScope",
};

function providerState(provider: Provider) {
  if (!provider.configured) return "未配置";
  return provider.ready ? "配置有效，连通性未验证" : "已配置但暂不可路由";
}

export default function ModelRoutingPanel() {
  const [catalog, setCatalog] = useState<RoutingCatalog | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setState("loading");
    try {
      const response = await managementFetch("/api/model-routing", { cache: "no-store" });
      const payload = await response.json() as RoutingCatalog | { error?: { message?: string } };
      if (!response.ok || !("ok" in payload) || payload.ok !== true) {
        throw new Error("error" in payload ? payload.error?.message || "路由状态不可用" : "路由状态不可用");
      }
      setCatalog(payload);
      setState("ready");
      setError("");
    } catch (caught) {
      setCatalog(null);
      setState("error");
      setError(caught instanceof Error ? `${caught.message}；当前目录已清空，先前状态已过期` : "路由状态不可用；当前目录已清空，先前状态已过期");
    }
  }, []);

  useEffect(() => {
    const scheduledRefresh = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(scheduledRefresh);
  }, [refresh]);

  return <section className="model-routing-panel" aria-labelledby="model-routing-title">
    <header>
      <div><span className="eyebrow">只读路由状态</span><h2 id="model-routing-title">模型路由与权限边界</h2></div>
      <button type="button" onClick={() => void refresh()} disabled={state === "loading"}>{state === "loading" ? "读取中……" : "刷新状态"}</button>
    </header>
    <p className="model-routing-intro">此处只读取服务端脱敏状态，不接收密钥、上游 URL 或发布授权，也不会发起 provider 调用。</p>
    {error && <p className="model-routing-error" role="alert">{error}</p>}
    {catalog && <>
      <div className="model-routing-provider-grid">
        {catalog.providers.map((provider) => <article key={provider.id} className={provider.ready ? "eligible" : "ineligible"}>
          <strong>{PROVIDER_LABELS[provider.id]}</strong><span>{providerState(provider)}</span>
          <small>{provider.model || "服务端未提供可显示模型"} · {provider.endpointClass === "server_configured_lan" ? "仅服务端私有地址" : "固定服务端端点"}</small>
        </article>)}
      </div>
      <div className="model-routing-summary">
        <strong>自动工位与熔断</strong>
        <p>自定义工位的 ready 状态只来自服务端门禁；Spark 不在本页面被探测或执行。publish operator 的 Terra 仅是 configured fallback target，当前没有宿主路由回执，不能视为实机生效。异常、权限判断和完成声明仍升级给协调者。</p>
        <ul>{catalog.customAgents.map((agent) => <li key={agent.id}>
          <strong>{agent.id}</strong>：{agent.ready ? "服务端标记为 ready" : "未就绪"}（{agent.readinessSource}）；
          首选模型：{agent.preferredModel || agent.model}；有效模型：{agent.effectiveModel || agent.model}；
          熔断：{agent.circuitState || "未声明"}{agent.fallbackReason ? `；fallback：${agent.fallbackReason}` : ""}{agent.fallbackVerification ? `；验证：${agent.fallbackVerification}` : ""}
        </li>)}</ul>
      </div>
      <div className="model-routing-routes">
        <strong>确定性路由摘要</strong>
        {catalog.routes.map((route) => <article key={route.phase}><code>{route.phase}</code><span>{route.selectedRef}</span><small>{route.requiresHumanApproval ? "需要人工确认" : "无人工发布授权"}；fallback：{route.fallbackRefs.join(" → ") || "无"}</small></article>)}
      </div>
    </>}
  </section>;
}
