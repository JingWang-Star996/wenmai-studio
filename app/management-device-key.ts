"use client";

const DATABASE_NAME = "wenmai-management-device-v1";
const STORE_NAME = "device-keys";
const PRIMARY_SLOT = "primary";
const DEVICE_ID_PREFIX = "management-device-";

export type ManagementDevicePublicJwk = {
  crv: "P-256";
  kty: "EC";
  x: string;
  y: string;
};

export type ManagementTrustedDevice = {
  deviceId: string;
  publicKeyJwk: ManagementDevicePublicJwk;
  publicKeySha256: string;
  privateKey: CryptoKey;
  createdAt: string;
};

type StoredDevice = ManagementTrustedDevice & { slot: string };

type EnrollmentMessageInput = {
  origin: string;
  bootId: string;
  browserBindingSha256: string;
};

type ResumeMessageInput = EnrollmentMessageInput & {
  challengeId: string;
  nonce: string;
};

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalPublicJwk(value: JsonWebKey): ManagementDevicePublicJwk {
  if (
    value.kty !== "EC"
    || value.crv !== "P-256"
    || typeof value.x !== "string"
    || typeof value.y !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.x)
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.y)
    || typeof value.d === "string"
  ) {
    throw new Error("浏览器设备公钥不是有效的 P-256 公钥");
  }
  return { crv: "P-256", kty: "EC", x: value.x, y: value.y };
}

function publicJwkText(value: ManagementDevicePublicJwk) {
  return JSON.stringify({ crv: value.crv, kty: value.kty, x: value.x, y: value.y });
}

function validPrivateKey(value: unknown): value is CryptoKey {
  if (!value || typeof value !== "object") return false;
  const key = value as CryptoKey;
  const algorithm = key.algorithm as EcKeyAlgorithm | undefined;
  return key.type === "private"
    && key.extractable === false
    && key.usages.includes("sign")
    && algorithm?.name === "ECDSA"
    && algorithm.namedCurve === "P-256";
}

function validStoredDevice(value: unknown): value is StoredDevice {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredDevice>;
  return record.slot === PRIMARY_SLOT
    && typeof record.deviceId === "string"
    && /^management-device-[a-f0-9]{64}$/u.test(record.deviceId)
    && typeof record.publicKeySha256 === "string"
    && /^[a-f0-9]{64}$/u.test(record.publicKeySha256)
    && typeof record.createdAt === "string"
    && validPrivateKey(record.privateKey)
    && Boolean(record.publicKeyJwk)
    && canonicalPublicJwk(record.publicKeyJwk as JsonWebKey).kty === "EC";
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "slot" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本机设备密钥库"));
    request.onblocked = () => reject(new Error("本机设备密钥库正在被另一个页面占用"));
  });
}

async function readStoredDevice() {
  const database = await openDatabase();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(PRIMARY_SLOT);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("无法读取本机设备密钥"));
    });
  } finally {
    database.close();
  }
}

async function writeStoredDevice(device: StoredDevice) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(device);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("无法保存本机设备密钥"));
      transaction.onabort = () => reject(transaction.error ?? new Error("保存本机设备密钥已中止"));
    });
  } finally {
    database.close();
  }
}

export async function getManagementTrustedDevice() {
  if (typeof indexedDB === "undefined") return null;
  try {
    const stored = await readStoredDevice();
    return validStoredDevice(stored) ? stored : null;
  } catch {
    return null;
  }
}

export async function getOrCreateManagementTrustedDevice() {
  const existing = await getManagementTrustedDevice();
  if (existing) return existing;
  if (typeof indexedDB === "undefined") throw new Error("当前浏览器不能保存本机设备密钥");

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  if (keyPair.privateKey.extractable) throw new Error("浏览器生成了可导出的设备私钥，已停止登记");
  const publicKeyJwk = canonicalPublicJwk(await crypto.subtle.exportKey("jwk", keyPair.publicKey));
  const publicKeySha256 = await sha256Text(publicJwkText(publicKeyJwk));
  const device: StoredDevice = {
    slot: PRIMARY_SLOT,
    deviceId: `${DEVICE_ID_PREFIX}${publicKeySha256}`,
    publicKeyJwk,
    publicKeySha256,
    privateKey: keyPair.privateKey,
    createdAt: new Date().toISOString(),
  };
  await writeStoredDevice(device);
  return device;
}

export async function clearManagementTrustedDevice() {
  if (typeof indexedDB === "undefined") return;
  try {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(PRIMARY_SLOT);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("无法删除本机设备密钥"));
        transaction.onabort = () => reject(transaction.error ?? new Error("删除本机设备密钥已中止"));
      });
    } finally {
      database.close();
    }
  } catch {
    // Browser privacy modes can make IndexedDB unavailable. There is no other
    // persistent key material to clear when that happens.
  }
}

export function trustedDeviceEnrollmentMessage(device: ManagementTrustedDevice, input: EnrollmentMessageInput) {
  return [
    "wenmai-management-device-enroll/v1",
    `origin=${input.origin}`,
    `boot=${input.bootId}`,
    `device=${device.deviceId}`,
    `publicKey=${device.publicKeySha256}`,
    `binding=${input.browserBindingSha256}`,
  ].join("\n");
}

export function trustedDeviceResumeMessage(device: ManagementTrustedDevice, input: ResumeMessageInput) {
  return [
    "wenmai-management-device-resume/v1",
    `origin=${input.origin}`,
    `boot=${input.bootId}`,
    `challenge=${input.challengeId}`,
    `nonce=${input.nonce}`,
    `device=${device.deviceId}`,
    `binding=${input.browserBindingSha256}`,
  ].join("\n");
}

export async function signManagementDeviceMessage(device: ManagementTrustedDevice, message: string) {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    device.privateKey,
    new TextEncoder().encode(message),
  );
  return base64Url(new Uint8Array(signature));
}

export async function withManagementDeviceLock<T>(callback: () => Promise<T>) {
  if (!navigator.locks) return callback();
  return navigator.locks.request("wenmai-management-device-resume-v1", { mode: "exclusive" }, callback);
}
