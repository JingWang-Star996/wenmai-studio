import type { ArticleRecord, ArticleVersion } from "./types";

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function relativeDate(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "时间未知";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return formatDate(value);
}

export function currentVersion(article: ArticleRecord): ArticleVersion {
  return article.versions.find((version) => version.id === article.representativeVersionId) ?? article.versions.at(-1)!;
}

export function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

export function articleMatches(article: ArticleRecord, query: string): boolean {
  const normalized = normalizeSearch(query);
  if (!normalized) return true;
  const haystack = normalizeSearch([
    article.title,
    article.summary,
    article.id,
    ...article.tags,
    ...article.entities,
    ...article.platforms,
    ...article.versions.map((version) => version.name),
  ].join(" "));
  return haystack.includes(normalized);
}

export type DiffKind = "same" | "added" | "removed";

export interface DiffOperation {
  kind: DiffKind;
  text: string;
  leftIndex?: number;
  rightIndex?: number;
}

function splitBlocks(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n|(?=^#{1,6}\s)/m)
    .map((block) => block.trim())
    .filter(Boolean);
}

function normalizedBlock(value: string): string {
  return value.replace(/\s+/g, "").replace(/[，。；：、“”‘’（）()[\]]/g, "");
}

export function diffBlocks(leftText: string, rightText: string): DiffOperation[] {
  const left = splitBlocks(leftText);
  const right = splitBlocks(rightText);
  const rows = left.length;
  const columns = right.length;

  if (!rows && !columns) return [];
  if (rows * columns > 180_000) {
    const operations: DiffOperation[] = [];
    const length = Math.max(rows, columns);
    for (let index = 0; index < length; index += 1) {
      if (left[index] && right[index] && normalizedBlock(left[index]) === normalizedBlock(right[index])) {
        operations.push({ kind: "same", text: left[index], leftIndex: index, rightIndex: index });
      } else {
        if (left[index]) operations.push({ kind: "removed", text: left[index], leftIndex: index });
        if (right[index]) operations.push({ kind: "added", text: right[index], rightIndex: index });
      }
    }
    return operations;
  }

  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(columns + 1));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row][column] = normalizedBlock(left[row]) === normalizedBlock(right[column])
        ? table[row + 1][column + 1] + 1
        : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }

  const operations: DiffOperation[] = [];
  let row = 0;
  let column = 0;
  while (row < rows || column < columns) {
    if (row < rows && column < columns && normalizedBlock(left[row]) === normalizedBlock(right[column])) {
      operations.push({ kind: "same", text: left[row], leftIndex: row, rightIndex: column });
      row += 1;
      column += 1;
    } else if (column < columns && (row >= rows || table[row][column + 1] >= table[row + 1][column])) {
      operations.push({ kind: "added", text: right[column], rightIndex: column });
      column += 1;
    } else if (row < rows) {
      operations.push({ kind: "removed", text: left[row], leftIndex: row });
      row += 1;
    }
  }
  return operations;
}

export function diffSummary(operations: DiffOperation[]) {
  return operations.reduce(
    (summary, operation) => {
      summary[operation.kind] += 1;
      return summary;
    },
    { same: 0, added: 0, removed: 0 },
  );
}

export function confidenceClass(value: string): string {
  if (value === "高") return "confidence-high";
  if (value === "中") return "confidence-medium";
  return "confidence-low";
}

export function gateStateFor(article: ArticleRecord): { label: string; tone: "good" | "warn" | "muted" } {
  const version = currentVersion(article);
  if (article.kind !== "文章") return { label: "不适用", tone: "muted" };
  if (version.metrics.scores["证据密度代理"] < 45) return { label: "自动提醒：证据线索偏少", tone: "warn" };
  if (version.metrics.longSentenceRatio > 0.28) return { label: "自动提醒：长句偏多", tone: "warn" };
  return { label: "自动扫描：未发现明确结构提醒", tone: "muted" };
}

export function evidenceHealthFor(article: ArticleRecord): string {
  return article.evidenceHealth;
}
