import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";
import { resolvePersistStatePath } from "./scripts/persist-state-path.mjs";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const persistStatePath = resolvePersistStatePath(
    process.env.WENMAI_PERSIST_STATE_PATH,
  );

  // Provider credentials are injected only into the ephemeral local dev Worker.
  // Production/static builds must never serialize long-lived API keys.
  const localModelBindings = command === "serve"
    ? {
        ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
        ...(process.env.DASHSCOPE_API_KEY ? { DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY } : {}),
        ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
        ...(process.env.OLLAMA_API_KEY ? { OLLAMA_API_KEY: process.env.OLLAMA_API_KEY } : {}),
        ...(process.env.DEEPSEEK_MODEL ? { DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL } : {}),
        ...(process.env.QWEN_MODEL ? { QWEN_MODEL: process.env.QWEN_MODEL } : {}),
        ...(process.env.OPENAI_FAST_MODEL ? { OPENAI_FAST_MODEL: process.env.OPENAI_FAST_MODEL } : {}),
        ...(process.env.OLLAMA_BASE_URL ? { OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL } : {}),
        ...(process.env.OLLAMA_MODEL ? { OLLAMA_MODEL: process.env.OLLAMA_MODEL } : {}),
      }
    : {};
  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      WENMAI_AUTH_CANONICAL_ORIGIN: process.env.WENMAI_AUTH_CANONICAL_ORIGIN ?? "",
      WENMAI_AUTH_BOOT_ID: process.env.WENMAI_AUTH_BOOT_ID ?? "",
      WENMAI_AUTH_CHALLENGE_ID: process.env.WENMAI_AUTH_CHALLENGE_ID ?? "",
      WENMAI_AUTH_PAIRING_SHA256: process.env.WENMAI_AUTH_PAIRING_SHA256 ?? "",
      WENMAI_AUTH_CHALLENGE_CREATED_AT: process.env.WENMAI_AUTH_CHALLENGE_CREATED_AT ?? "",
      WENMAI_AUTH_CHALLENGE_EXPIRES_AT: process.env.WENMAI_AUTH_CHALLENGE_EXPIRES_AT ?? "",
      WENMAI_AUTH_CSRF_HMAC_KEY: process.env.WENMAI_AUTH_CSRF_HMAC_KEY ?? "",
      WENMAI_LOCAL_IMPORT_CANONICAL_ORIGIN: process.env.WENMAI_LOCAL_IMPORT_CANONICAL_ORIGIN ?? "",
      WENMAI_LOCAL_IMPORT_BOOT_ID: process.env.WENMAI_LOCAL_IMPORT_BOOT_ID ?? "",
      WENMAI_LOCAL_IMPORT_TOKEN_SHA256: process.env.WENMAI_LOCAL_IMPORT_TOKEN_SHA256 ?? "",
      // Release Control V2 remains off unless the local launcher explicitly enables it.
      // Host-route verification is deliberately hard-locked off in local Workers.
      WENMAI_RELEASE_CONTROL_V2_ENABLED: process.env.WENMAI_RELEASE_CONTROL_V2_ENABLED ?? "false",
      WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED: "false",
      ...(command === "serve" && process.env.WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY
        ? { WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY: process.env.WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY }
        : {}),
      ...localModelBindings,
    },
    d1_databases: d1
      ? [
          {
            binding: d1,
            database_name: "site-creator-d1",
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          },
        ]
      : [],
    r2_buckets: r2
      ? [
          {
            binding: r2,
            bucket_name: "site-creator-r2",
          },
        ]
      : [],
  };

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
        ...(persistStatePath === undefined
          ? {}
          : { persistState: { path: persistStatePath } }),
      }),
    ],
  };
});
