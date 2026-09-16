"use client";

import { managementFetch } from "./management-fetch";

const uncertainLifecycleCommands = new Map<string, string>();

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function fingerprint(action: string, payload: Record<string, unknown>) {
  return JSON.stringify(canonicalValue({ action, payload }));
}

export async function postLifecycleMutation(action: string, payload: Record<string, unknown>) {
  const key = fingerprint(action, payload);
  const commandId = uncertainLifecycleCommands.get(key) ?? `lifecycle:${crypto.randomUUID()}`;
  uncertainLifecycleCommands.set(key, commandId);
  // A thrown transport error leaves the command in the map: the request may already have reached D1.
  const response = await managementFetch("/api/lifecycle", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Wenmai-Write": "1" },
    body: JSON.stringify({ action, commandId, payload }),
  });
  let keepForReplay = false;
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => ({})) as { error?: string };
    keepForReplay = body.error?.startsWith("COMMAND_IN_PROGRESS:") === true;
  }
  if (!keepForReplay) uncertainLifecycleCommands.delete(key);
  return response;
}
