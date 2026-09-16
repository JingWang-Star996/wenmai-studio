"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import styles from "./ManagementSessionGate.module.css";
import {
  clearManagementBrowserBinding,
  getOrCreateManagementBrowserBinding,
  managementBrowserBindingSha256,
} from "./management-browser-binding";
import {
  clearManagementTrustedDevice,
  getManagementTrustedDevice,
  getOrCreateManagementTrustedDevice,
  signManagementDeviceMessage,
  trustedDeviceEnrollmentMessage,
  trustedDeviceResumeMessage,
  withManagementDeviceLock,
} from "./management-device-key";
import {
  clearManagementCsrfToken,
  managementFetch,
  setManagementCsrfToken,
  subscribeManagementSessionInvalidation,
} from "./management-fetch";

type SessionPublic = {
  principalId: string;
  scopes: string[];
  articleIds: string[];
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  authBasis?: string;
  sourceClientId?: string | null;
};

type AuthData = {
  authenticated: boolean;
  canonicalOrigin: string;
  bootId: string;
  pairing?: {
    available: boolean;
    expiresAt: string | null;
    state: string;
    attemptsRemaining?: number;
  };
  session?: SessionPublic | null;
  csrfToken?: string;
  authBasis?: string;
  sourceClientId?: string | null;
};

type AuthEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

type DeviceBeginData = {
  deviceId: string;
  challengeId: string;
  bootId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  signingPayload: string;
};

class AuthRequestError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = "AUTH_REQUEST_FAILED", status = 500) {
    super(message);
    this.name = "AuthRequestError";
    this.code = code;
    this.status = status;
  }
}

type ManagementSessionContextValue = {
  session: SessionPublic;
  managementFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  logout: () => Promise<void>;
};

const ManagementSessionContext = createContext<ManagementSessionContextValue | null>(null);

async function readEnvelope<T>(response: Response) {
  const payload = await response.json() as AuthEnvelope<T>;
  if (!response.ok || !payload.ok || !payload.data) {
    throw new AuthRequestError(
      payload.error?.message || "管理会话请求失败",
      payload.error?.code,
      response.status,
    );
  }
  return payload.data;
}

async function fetchSessionData() {
  const response = await managementFetch("/api/auth", {
    method: "GET",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  return readEnvelope<AuthData>(response);
}

async function unauthenticatedAuthPost<T>(body: Record<string, unknown>) {
  const response = await fetch("/api/auth", {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "X-Wenmai-Browser-Binding": getOrCreateManagementBrowserBinding(),
    },
    body: JSON.stringify(body),
  });
  return readEnvelope<T>(response);
}

const TRUSTED_DEVICE_FALLBACK_CODES = new Set([
  "TRUSTED_DEVICE_NOT_AVAILABLE",
  "TRUSTED_RESUME_NOT_AVAILABLE",
  "TRUSTED_DEVICE_UNAVAILABLE",
  "DEVICE_CHALLENGE_EXPIRED",
  "DEVICE_CHALLENGE_CONSUMED",
  "DEVICE_CHALLENGE_LOCKED",
  "DEVICE_CHALLENGE_RACE_LOST",
  "TRUSTED_RESUME_RACE_LOST",
]);

async function restoreTrustedManagementSession(initial: AuthData) {
  const device = await getManagementTrustedDevice();
  if (!device || !initial.bootId) return null;
  return withManagementDeviceLock(async () => {
    const current = await fetchSessionData();
    if (current.authenticated && current.session && current.csrfToken) return current;
    const browserBindingSha256 = await managementBrowserBindingSha256();
    try {
      const begin = await unauthenticatedAuthPost<DeviceBeginData>({
        action: "device.begin",
        deviceId: device.deviceId,
      });
      const expectedPayload = trustedDeviceResumeMessage(device, {
        origin: window.location.origin,
        bootId: begin.bootId,
        challengeId: begin.challengeId,
        nonce: begin.nonce,
        browserBindingSha256,
      });
      const issuedAt = Date.parse(begin.issuedAt);
      const expiresAt = Date.parse(begin.expiresAt);
      if (
        begin.deviceId !== device.deviceId
        || begin.bootId !== initial.bootId
        || begin.signingPayload !== expectedPayload
        || !Number.isFinite(issuedAt)
        || !Number.isFinite(expiresAt)
        || expiresAt <= Date.now()
        || expiresAt - issuedAt > 60_000
      ) {
        throw new AuthRequestError("自动恢复响应与当前本机设备不匹配", "DEVICE_CHALLENGE_CONTEXT_INVALID", 409);
      }
      const signature = await signManagementDeviceMessage(device, expectedPayload);
      return await unauthenticatedAuthPost<AuthData>({
        action: "device.complete",
        deviceId: device.deviceId,
        challengeId: begin.challengeId,
        nonce: begin.nonce,
        signingPayload: expectedPayload,
        signature,
      });
    } catch (cause) {
      if (cause instanceof AuthRequestError && cause.status === 409) {
        const raced = await fetchSessionData().catch(() => null);
        if (raced?.authenticated && raced.session && raced.csrfToken) return raced;
      }
      if (cause instanceof AuthRequestError && TRUSTED_DEVICE_FALLBACK_CODES.has(cause.code)) return null;
      if (cause instanceof AuthRequestError && ["DEVICE_SIGNATURE_INVALID", "DEVICE_CHALLENGE_CONTEXT_INVALID"].includes(cause.code)) {
        await clearManagementTrustedDevice();
        return null;
      }
      throw cause;
    }
  });
}

async function enrollCurrentManagementDevice(auth: AuthData) {
  if (!auth.authenticated || !auth.session || !auth.csrfToken || !auth.bootId) return;
  await withManagementDeviceLock(async () => {
    const device = await getOrCreateManagementTrustedDevice();
    const browserBindingSha256 = await managementBrowserBindingSha256();
    const signingPayload = trustedDeviceEnrollmentMessage(device, {
      origin: window.location.origin,
      bootId: auth.bootId,
      browserBindingSha256,
    });
    const signature = await signManagementDeviceMessage(device, signingPayload);
    const response = await managementFetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "device.enroll",
        deviceId: device.deviceId,
        publicKeyJwk: device.publicKeyJwk,
        publicKeySha256: device.publicKeySha256,
        signature,
      }),
    });
    await readEnvelope<Record<string, unknown>>(response);
  });
}

export function useManagementSession() {
  const value = useContext(ManagementSessionContext);
  if (!value) throw new Error("useManagementSession 必须在 ManagementSessionGate 内使用");
  return value;
}

export default function ManagementSessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "restoring" | "locked" | "error" | "ready">("loading");
  const [auth, setAuth] = useState<AuthData | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [siteFullControlKey, setSiteFullControlKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const pairingInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let data: AuthData;
        try {
          data = await fetchSessionData();
        } catch (cause) {
          if (!(cause instanceof AuthRequestError) || cause.status !== 401) throw cause;
          data = await fetchSessionData();
        }
        if (!active) return;
        if (data.authenticated && data.session && data.csrfToken) {
          setAuth(data);
          setManagementCsrfToken(data.csrfToken);
          setState("ready");
          return;
        }
        setAuth(data);
        setState("restoring");
        const restored = await restoreTrustedManagementSession(data);
        if (!active) return;
        if (restored?.authenticated && restored.session && restored.csrfToken) {
          setAuth(restored);
          setManagementCsrfToken(restored.csrfToken);
          setState("ready");
          return;
        }
        setState("locked");
      } catch (cause) {
        if (!active) return;
        setState("error");
        setError(cause instanceof Error ? cause.message : "管理会话暂时不可用");
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshKey]);

  useEffect(() => subscribeManagementSessionInvalidation(() => {
    setAuth(null);
    setState("loading");
    setRefreshKey((value) => value + 1);
  }), []);

  useEffect(() => {
    if (state !== "ready" || !auth?.session || !auth.csrfToken || !auth.bootId || auth.authBasis === "site_full_control_key" || auth.session.authBasis === "site_full_control_key") return;
    void enrollCurrentManagementDevice(auth).catch(() => {
      // A privacy mode may disable IndexedDB. The current management session
      // remains valid; the next start will simply fall back to the pairing code.
    });
  }, [state, auth]);

  useEffect(() => {
    if (state === "locked") pairingInputRef.current?.focus();
  }, [state]);

  async function pair(event: FormEvent) {
    event.preventDefault();
    if (!pairingCode.trim()) return;
    setBusy(true);
    setError("");
    try {
      const browserBindingSha256 = await managementBrowserBindingSha256();
      const data = await unauthenticatedAuthPost<AuthData>({
        action: "bootstrap",
        pairingCode: pairingCode.trim(),
        browserBindingSha256,
      });
      setPairingCode("");
      setAuth(data);
      setManagementCsrfToken(data.csrfToken ?? "");
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "配对失败");
    } finally {
      setBusy(false);
    }
  }

  async function exchangeSiteFullControl(event: FormEvent) {
    event.preventDefault();
    if (!siteFullControlKey) return;
    setBusy(true);
    setError("");
    try {
      const browserBinding = getOrCreateManagementBrowserBinding();
      const browserBindingSha256 = await managementBrowserBindingSha256();
      const response = await fetch("/api/auth", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: {
          authorization: `Bearer ${siteFullControlKey}`,
          accept: "application/json",
          "content-type": "application/json",
          "X-Wenmai-Browser-Binding": browserBinding,
        },
        body: JSON.stringify({ action: "site_full_control.exchange", browserBindingSha256, exchangeCommandId: `site-full-control-exchange:${crypto.randomUUID()}` }),
      });
      const data = await readEnvelope<AuthData>(response);
      setAuth(data);
      setManagementCsrfToken(data.csrfToken ?? "");
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "完整站内管理 Key 兑换失败");
    } finally {
      // Key is deliberately password-state only, never a request body, URL, log, or browser storage value.
      setSiteFullControlKey("");
      setBusy(false);
    }
  }

  async function logout() {
    if (!auth?.csrfToken) return;
    const response = await managementFetch("/api/auth", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "logout" }),
    });
    if (!response.ok) await readEnvelope(response);
    clearManagementCsrfToken();
    if (auth.session.authBasis !== "site_full_control_key") await clearManagementTrustedDevice();
    clearManagementBrowserBinding();
    try {
      const data = await fetchSessionData();
      setAuth(data);
      setState("locked");
    } catch {
      setAuth(null);
      setState("locked");
    }
  }

  async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    return managementFetch(input, init);
  }

  const context: ManagementSessionContextValue | null = auth?.session && auth.csrfToken
    ? { session: auth.session, managementFetch: authenticatedFetch, logout }
    : null;

  if (state === "loading" || state === "restoring") {
    return (
      <main aria-busy="true" className={styles.shell}>
        <div aria-live="polite" className={styles.loading} role="status">
          {state === "restoring" ? "正在用已信任的本机浏览器安全打开文脉…" : "正在检查本机管理会话…"}
        </div>
      </main>
    );
  }

  if (state === "error") {
    return (
      <main className={styles.shell}>
        <section className={styles.card} aria-labelledby="management-error-title">
          <header className={styles.header}>
            <div className={styles.seal} aria-hidden="true">文</div>
            <div><span>文脉 · 本机管理会话</span><h1 id="management-error-title">暂时无法确认管理会话</h1></div>
          </header>
          <div className={styles.body}>
            <p>服务可能仍在启动或刚刚重载。连接失败不会把这台浏览器改为未配对，也不会自动生成新配对码。</p>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.actions}>
              <small>确认启动窗口仍在运行后重新检查；若仍失败，保留错误详情并检查服务日志。</small>
              <button onClick={() => { setError(""); setState("loading"); setRefreshKey((value) => value + 1); }} type="button">重新检查</button>
            </div>
          </div>
        </section>
      </main>
    );
  }

  if (state !== "ready" || !context) {
    const pairing = auth?.pairing;
    return (
      <main className={styles.shell}>
        <section className={styles.card} aria-labelledby="management-lock-title">
          <header className={styles.header}>
            <div className={styles.seal} aria-hidden="true">文</div>
            <div><span>文脉 · 本机管理确认</span><h1 id="management-lock-title">自动进入未完成</h1></div>
          </header>
          <div className={styles.body}>
            <p>文脉正在恢复这个浏览器的受信设备凭据。首次使用、更换浏览器、清理浏览器数据或主动退出后，才需要在启动窗口取得一次性配对码并完成本次人类确认。</p>
            <aside className={styles.agentHint}>
              <strong>如果是让其他 Agent 调用文脉，不要把这里的配对码交给它。</strong>
              <span>先由你进入管理界面，再到“Agent 中心 → 权限与 Key”手工签发受文章和权限范围限制的 Agent Key。配对码只确认当前人类浏览器；Agent 以后只引用 Windows DPAPI 档案名，不接触配对码或 Key 明文。</span>
            </aside>
            <ol className={styles.steps}>
              <li>找到仍保持打开的文脉启动窗口。</li>
              <li>复制其中只显示一次的备用配对码。</li>
              <li>完成这一次人类确认；同一浏览器在凭据仍有效时可自动进入。</li>
            </ol>
            <form onSubmit={pair}>
              <label className={styles.field}>
                <strong>一次性配对码</strong>
                <input
                  aria-describedby="management-pairing-status management-pairing-error"
                  aria-invalid={Boolean(error)}
                  autoComplete="one-time-code"
                  maxLength={128}
                  name="wenmai-pairing-code"
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder="例如：wenmai1.选择器.一次性秘密"
                  ref={pairingInputRef}
                  spellCheck={false}
                  type="password"
                  value={pairingCode}
                />
              </label>
              <div className={styles.actions}>
                <small id="management-pairing-status">{pairing?.available ? `备用配对码将在 ${pairing.expiresAt ? new Date(pairing.expiresAt).toLocaleTimeString("zh-CN") : "数分钟后"} 失效；明文不会被保存，忘记后无法找回。配对失败时先查看下方错误，再用仍有效的码重试` : "旧配对码无法找回；请双击“获取文脉新配对码.cmd”，由脚本安全重启并生成新码"}</small>
                <button disabled={busy || !pairingCode.trim() || pairing?.available === false} type="submit">{busy ? "正在配对…" : "进入文脉"}</button>
              </div>
              {error && <p className={styles.error} id="management-pairing-error" role="alert">{error}</p>}
            </form>
            <div className={styles.actions}>
              <small>也可使用完整站内管理 Key 兑换根会话；Key 仅保存在本次表单的密码状态，提交后无论成功或失败都会立即清空。兑换失败不授予会话，也不会影响既有 Key。</small>
            </div>
            <form onSubmit={exchangeSiteFullControl}>
              <label className={styles.field}>
                <strong>完整站内管理 Key</strong>
                <input
                  aria-describedby="management-root-key-status management-root-key-error"
                  aria-invalid={Boolean(error)}
                  autoComplete="off"
                  name="wenmai-site-full-control-key"
                  onChange={(event) => setSiteFullControlKey(event.target.value)}
                  placeholder="仅本机根 Key；不会写入浏览器存储"
                  spellCheck={false}
                  type="password"
                  value={siteFullControlKey}
                />
              </label>
              <div className={styles.actions}>
                <small id="management-root-key-status">完整站内操作可管理其他 Key；外部平台登录、验证码和最终公开动作仍须当前批次的一次性授权，Key 本身不证明发布完成。</small>
                <button disabled={busy || !siteFullControlKey} type="submit">兑换完整站内管理会话</button>
              </div>
              {error && <p className={styles.error} id="management-root-key-error" role="alert">{error}</p>}
            </form>
          </div>
        </section>
      </main>
    );
  }

  const rootSession = auth?.authBasis === "site_full_control_key" || auth?.session?.authBasis === "site_full_control_key";
  const rootSourceLabel = (auth?.sourceClientId ?? auth?.session?.sourceClientId ?? "").slice(-8) || "已验证";
  return <ManagementSessionContext.Provider value={context}>{rootSession && <aside className={styles.agentHint} role="status"><strong>完整站内管理会话</strong><span>来源根 Key：…{rootSourceLabel}。此会话不会登记为可信设备；撤销来源 Key 会撤销由它派生的会话。</span></aside>}{children}</ManagementSessionContext.Provider>;
}
