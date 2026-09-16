import path from "node:path";

const forbiddenLeafNames = new Set(["v3", "sqlite", "file"]);

export function resolvePersistStatePath(value) {
  if (value === undefined) return undefined;

  const input = value.trim();
  if (!input || !path.isAbsolute(input)) {
    throw new Error("WENMAI_PERSIST_STATE_PATH 必须是绝对状态根目录。");
  }

  const root = path.resolve(input);
  if (forbiddenLeafNames.has(path.basename(root).toLowerCase())) {
    throw new Error(
      "WENMAI_PERSIST_STATE_PATH 必须指向状态根目录，末段不能是 v3、sqlite 或 file。",
    );
  }
  return root;
}
