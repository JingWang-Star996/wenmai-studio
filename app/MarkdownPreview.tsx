"use client";

import type { ReactNode } from "react";

function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={`${keyPrefix}-strong-${index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      parts.push(<code key={`${keyPrefix}-code-${index}`}>{token.slice(1, -1)}</code>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      parts.push(link
        ? <a key={`${keyPrefix}-link-${index}`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>
        : token);
    }
    cursor = start + token.length;
    index += 1;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function outlineFromMarkdown(markdown: string) {
  return markdown.split("\n").flatMap((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    return match ? [{ level: match[1].length, title: match[2].trim(), line: index + 1 }] : [];
  });
}

export default function MarkdownPreview({ markdown, empty = "正文预览会出现在这里。" }: { markdown: string; empty?: string }) {
  if (!markdown.trim()) return <div className="markdown-empty">{empty}</div>;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      nodes.push(<pre key={`code-${index}`} data-language={language || undefined}><code>{code.join("\n")}</code></pre>);
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2], `heading-${index}`);
      if (level === 1) nodes.push(<h1 key={`h-${index}`}>{content}</h1>);
      else if (level === 2) nodes.push(<h2 key={`h-${index}`}>{content}</h2>);
      else if (level === 3) nodes.push(<h3 key={`h-${index}`}>{content}</h3>);
      else nodes.push(<h4 key={`h-${index}`}>{content}</h4>);
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      nodes.push(<blockquote key={`quote-${index}`}>{quote.map((item, quoteIndex) => <p key={quoteIndex}>{inline(item, `quote-${index}-${quoteIndex}`)}</p>)}</blockquote>);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      nodes.push(<ul key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `list-${index}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      nodes.push(<ol key={`ordered-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `ordered-${index}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      nodes.push(<hr key={`hr-${index}`} />);
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(?:#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    nodes.push(<p key={`p-${index}`}>{inline(paragraph.join(" "), `p-${index}`)}</p>);
  }
  return <article className="markdown-preview">{nodes}</article>;
}
