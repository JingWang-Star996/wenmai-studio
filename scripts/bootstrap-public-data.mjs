import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptRoot, "..");

export const PUBLIC_DATA_MAPPINGS = Object.freeze([
  { source: "data/corpus.example.json", target: "data/corpus.generated.json", required: ["stats", "classification", "developmentTree", "articles", "artifacts", "graph"] },
  { source: "data/version-text.example.json", target: "data/version-text.generated.json", required: ["versions", "blobs"] },
  { source: "data/capabilities.example.json", target: "data/capabilities.generated.json", required: ["stats", "dimensions", "capabilities", "gaps", "notes"] },
]);

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return projectRoot;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--root requires a directory path");
  return path.resolve(value);
}

async function exists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readExample(source, required) {
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`example must be a regular file: ${source}`);
  const text = await readFile(source, "utf8");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`example must contain a JSON object: ${source}`);
  for (const key of ["schemaVersion", "generatedAt", ...required]) {
    if (!(key in parsed)) throw new Error(`example is missing ${key}: ${source}`);
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function createWithoutOverwrite(sourceText, target) {
  if (await exists(target)) return "kept";
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, sourceText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, target);
      return "created";
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "EPERM") {
        if (await exists(target)) return "kept";
      }
      throw error;
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function bootstrapPublicData(root = projectRoot) {
  const result = [];
  for (const mapping of PUBLIC_DATA_MAPPINGS) {
    const source = path.join(root, mapping.source);
    const target = path.join(root, mapping.target);
    const sourceText = await readExample(source, mapping.required);
    result.push({ target: mapping.target, status: await createWithoutOverwrite(sourceText, target) });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await bootstrapPublicData(parseRoot(process.argv.slice(2)));
    const created = result.filter((item) => item.status === "created").length;
    const kept = result.length - created;
    console.log(`Public data bootstrap: ${created} created, ${kept} existing files kept.`);
  } catch (error) {
    console.error(`Public data bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
