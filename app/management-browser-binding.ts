"use client";

const STORAGE_KEY = "wenmai.management.browser-binding.v1";
const BINDING_RE = /^[A-Za-z0-9_-]{43}$/;

let memoryBinding = "";

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function storedBinding() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY) ?? "";
    if (BINDING_RE.test(value)) return value;
    if (value) window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Privacy modes can disable storage; the current tab still keeps a binding in memory.
  }
  return "";
}

export function getOrCreateManagementBrowserBinding() {
  if (BINDING_RE.test(memoryBinding)) return memoryBinding;
  const existing = storedBinding();
  if (existing) {
    memoryBinding = existing;
    return existing;
  }
  const binding = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  memoryBinding = binding;
  try {
    window.localStorage.setItem(STORAGE_KEY, binding);
  } catch {
    // The raw binding is still usable until this page is closed.
  }
  return binding;
}

export async function managementBrowserBindingSha256() {
  const binding = getOrCreateManagementBrowserBinding();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function clearManagementBrowserBinding() {
  memoryBinding = "";
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing else can be cleared when storage is unavailable.
  }
}
