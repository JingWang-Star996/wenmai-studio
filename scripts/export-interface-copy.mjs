import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultOutput = path.join(projectRoot, "governance", "interface-copy-audit.md");
const defaultJson = path.join(projectRoot, "governance", "interface-copy-audit.json");
const defaultText = path.join(projectRoot, "governance", "interface-copy-audit.txt");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : fallback;
}

const outputPath = option("--output", defaultOutput);
const jsonPath = option("--json", defaultJson);
const textPath = option("--text", defaultText);
const roots = process.argv.includes("--all") ? ["app", "worker", "scripts"] : ["app"];
const chinesePattern = /[\p{Script=Han}]/u;

async function sourceFiles(relativeRoot) {
  const absoluteRoot = path.join(projectRoot, relativeRoot);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["node_modules", "dist", "build", ".next", ".vinext"].includes(entry.name)) continue;
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(relativePath));
    else if (/\.(?:ts|tsx|mjs)$/i.test(entry.name)) files.push(relativePath);
  }
  return files;
}

function normalizeText(value) {
  return String(value)
    .replace(/\r/g, "")
    .replace(/[\t ]*\n[\t ]*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function templateText(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return "";
  return [
    node.head.text,
    ...node.templateSpans.flatMap((span, index) => [`{value${index + 1}}`, span.literal.text]),
  ].join("");
}

function isImportPath(node) {
  return ts.isStringLiteral(node)
    && ((ts.isImportDeclaration(node.parent) && node.parent.moduleSpecifier === node)
      || (ts.isExportDeclaration(node.parent) && node.parent.moduleSpecifier === node));
}

function category(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("/api/")) return "API 与错误回执";
  if (/\.(?:tsx)$/i.test(normalized)) return "用户可见界面";
  if (/(?:workflow|routing|permission|capability|auth|gateway|contract)/i.test(normalized)) return "合同与机器说明";
  return "领域规则与共享文案";
}

const files = (await Promise.all(roots.map(sourceFiles))).flat().sort((left, right) => left.localeCompare(right, "zh-CN"));
const records = [];

for (const relativePath of files) {
  const absolutePath = path.join(projectRoot, relativePath);
  const source = await readFile(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const visit = (node) => {
    let raw = "";
    let kind = "";
    if (ts.isJsxText(node)) {
      raw = node.getText(sourceFile);
      kind = "jsx";
    } else if (ts.isStringLiteral(node) && !isImportPath(node)) {
      raw = node.text;
      kind = "string";
    } else if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      raw = templateText(node);
      kind = "template";
    }

    const text = normalizeText(raw);
    if (text && chinesePattern.test(text)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      records.push({
        category: category(relativePath),
        file: relativePath.replace(/\\/g, "/"),
        line: position.line + 1,
        kind,
        text,
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

const uniqueRecords = [...new Map(records.map((record) => [
  `${record.file}:${record.line}:${record.kind}:${record.text}`,
  record,
])).values()];
const grouped = Map.groupBy(uniqueRecords, (record) => record.category);
const markdown = [
  "# 文脉全站中文语料",
  "",
  "> 由 `scripts/export-interface-copy.mjs` 从源码确定性导出。命中只用于盘点，不能代替上下文审校。",
  `> 扫描范围：${roots.join("、")}；共 ${files.length} 个源码文件，${uniqueRecords.length} 条中文文本。`,
  "",
];

for (const [group, entries] of grouped) {
  markdown.push(`## ${group}`, "");
  const byFile = Map.groupBy(entries, (entry) => entry.file);
  for (const [file, fileEntries] of byFile) {
    markdown.push(`### ${file}`, "");
    for (const entry of fileEntries) markdown.push(`- L${entry.line} · ${entry.kind}：${entry.text}`);
    markdown.push("");
  }
}

await mkdir(path.dirname(outputPath), { recursive: true });
await mkdir(path.dirname(jsonPath), { recursive: true });
await mkdir(path.dirname(textPath), { recursive: true });
await writeFile(outputPath, `${markdown.join("\n")}\n`, "utf8");
await writeFile(jsonPath, `${JSON.stringify({ schemaVersion: "1.0.0", roots, files, count: uniqueRecords.length, records: uniqueRecords }, null, 2)}\n`, "utf8");
await writeFile(textPath, `${uniqueRecords.map((record) => record.text).join("\n\n")}\n`, "utf8");

console.log(`已导出 ${files.length} 个源码文件、${uniqueRecords.length} 条中文文本。`);
console.log(outputPath);
console.log(jsonPath);
console.log(textPath);
