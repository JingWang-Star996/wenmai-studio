/**
 * Canonical JSON used only for signed permission snapshots.
 *
 * Objects are recursively sorted by key, arrays preserve their order, and
 * values outside the JSON data model are rejected instead of being silently
 * coerced.  Issuance and authentication must share this exact implementation.
 */
export function canonicalPermissionSnapshotJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("permission snapshot contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalPermissionSnapshotJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPermissionSnapshotJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("permission snapshot contains a non-JSON value");
}

export function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactJsonKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

export function isLowercaseSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
