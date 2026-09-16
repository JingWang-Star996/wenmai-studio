"use client";

import { getOrCreateManagementBrowserBinding } from "./management-browser-binding";

let csrfToken = "";
let csrfRefreshPromise: Promise<string> | null = null;
const invalidationListeners = new Set<() => void>();

export function setManagementCsrfToken(value: string) {
  csrfToken = value;
}

export function clearManagementCsrfToken() {
  csrfToken = "";
}

export function subscribeManagementSessionInvalidation(listener: () => void) {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

function invalidateManagementSession() {
  clearManagementCsrfToken();
  for (const listener of invalidationListeners) listener();
}

function isCsrfFailure(response: Response, payload: unknown) {
  if (response.status !== 403 || !payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : null;
  const code = String(nested?.code ?? record.code ?? "");
  const message = String(nested?.message ?? record.error ?? record.message ?? "");
  return code === "CSRF_TOKEN_INVALID" || message.includes("当前会话的 CSRF 凭据");
}

async function refreshCsrfFromCurrentSession() {
  if (csrfRefreshPromise) return csrfRefreshPromise;
  csrfRefreshPromise = (async () => {
    const response = await fetch("/api/auth", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: {
        accept: "application/json",
        "X-Wenmai-Browser-Binding": getOrCreateManagementBrowserBinding(),
      },
    });
    const envelope = await response.json().catch(() => null) as {
      ok?: boolean;
      data?: { authenticated?: boolean; csrfToken?: string };
    } | null;
    const refreshed = envelope?.ok && envelope.data?.authenticated
      ? envelope.data.csrfToken ?? ""
      : "";
    if (!response.ok || !refreshed) {
      invalidateManagementSession();
      throw new Error("管理会话无法自动刷新，请重新配对");
    }
    setManagementCsrfToken(refreshed);
    return refreshed;
  })().finally(() => {
    csrfRefreshPromise = null;
  });
  return csrfRefreshPromise;
}

export async function managementFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const target = new URL(
    input instanceof Request ? input.url : input instanceof URL ? input.href : input,
    window.location.href,
  );
  if (target.origin !== window.location.origin) {
    throw new Error("管理请求只允许发送到当前文脉站点");
  }
  const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  const send = () => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    headers.set("X-Wenmai-Browser-Binding", getOrCreateManagementBrowserBinding());
    if (mutation) {
      if (!csrfToken) throw new Error("管理会话尚未建立");
      headers.set("X-Wenmai-CSRF", csrfToken);
      headers.set("X-Wenmai-Write", "1");
    }
    const requestInput = input instanceof Request ? input.clone() : input;
    return fetch(requestInput, { ...init, headers, credentials: "same-origin", redirect: "error" });
  };
  let response = await send();
  if (mutation && response.status === 403) {
    const payload = await response.clone().json().catch(() => null);
    if (isCsrfFailure(response, payload)) {
      await refreshCsrfFromCurrentSession();
      // The caller's commandId remains unchanged, so an uncertain first write
      // replays idempotently. Never retry more than once here.
      response = await send();
    }
  }
  if (response.status === 401) invalidateManagementSession();
  return response;
}
