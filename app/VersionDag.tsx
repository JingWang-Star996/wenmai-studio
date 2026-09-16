"use client";

import { useState, type ReactNode } from "react";
import type { ArticleBranch, ArticleRevision, WorkbenchArticle } from "./workbench-types";

type DagNode = {
  id: string;
  objectId: string;
  kind: "source" | "revision" | "pointer";
  lane: string;
  x: number;
  y: number;
  title: string;
  annotation: string;
  time: string;
  selected: boolean;
};

const BRANCH_COLORS = ["#37637a", "#9c4936", "#5c725f", "#755f91", "#96712f", "#4c7272"];

function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function shorten(value: string, maximum: number) {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

export default function VersionDag({
  article,
  branches,
  revisions,
  selectedNodeId,
  onSelect,
}: {
  article: WorkbenchArticle;
  branches: ArticleBranch[];
  revisions: ArticleRevision[];
  selectedNodeId: string;
  onSelect: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const laneIds = ["source", ...branches.map((branch) => branch.id)];
  const laneLabels = new Map<string, string>([["source", "历史源稿"], ...branches.map((branch): [string, string] => [branch.id, branch.name])]);
  const sourceVersions = [...article.versions].sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt));
  const orderedRevisions = [...revisions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const timestamps = [
    ...sourceVersions.map((item) => ({ id: `source:${item.id}`, time: item.modifiedAt })),
    ...orderedRevisions.map((item) => ({ id: `revision:${item.id}`, time: item.createdAt })),
  ].sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  const rank = new Map(timestamps.map((item, index) => [item.id, index]));
  const laneY = new Map(laneIds.map((lane, index) => [lane, 68 + index * 110]));
  const nodes: DagNode[] = [
    ...sourceVersions.map((version) => ({
      id: `source:${version.id}`,
      objectId: version.id,
      kind: "source" as const,
      lane: "source",
      x: 178 + (rank.get(`source:${version.id}`) ?? 0) * 174,
      y: laneY.get("source") ?? 68,
      title: version.name,
      annotation: `${version.role} · ${version.charCount.toLocaleString("zh-CN")} 字`,
      time: version.modifiedAt,
      selected: selectedNodeId === `source:${version.id}`,
    })),
    ...orderedRevisions.map((revision) => ({
      id: `revision:${revision.id}`,
      objectId: revision.id,
      kind: "revision" as const,
      lane: revision.branchId,
      x: 178 + (rank.get(`revision:${revision.id}`) ?? 0) * 174,
      y: laneY.get(revision.branchId) ?? 178,
      title: revision.title,
      annotation: revision.annotation || `第 ${revision.sequence} 次提交`,
      time: revision.createdAt,
      selected: selectedNodeId === `revision:${revision.id}`,
    })),
  ];
  const revisionNodeIds = new Set(orderedRevisions.map((revision) => revision.id));
  for (const branch of branches) {
    if (orderedRevisions.some((revision) => revision.branchId === branch.id)) continue;
    const head = orderedRevisions.find((revision) => revision.id === branch.headRevisionId);
    const baseRank = head ? rank.get(`revision:${head.id}`) ?? timestamps.length : timestamps.length;
    nodes.push({
      id: `pointer:${branch.id}`,
      objectId: branch.headRevisionId,
      kind: "pointer",
      lane: branch.id,
      x: 178 + baseRank * 174,
      y: laneY.get(branch.id) ?? 178,
      title: "新建分支的当前指针",
      annotation: head ? `当前指向修订：${head.title}` : "尚未创建该分支的修订",
      time: branch.createdAt,
      selected: selectedNodeId === `pointer:${branch.id}`,
    });
  }
  const parents = new Map(orderedRevisions.map((revision) => [revision.id, [revision.parentRevisionId, revision.mergeParentRevisionId].filter(Boolean) as string[]]));
  const ancestorIds = new Set<string>(); const pending = selectedNodeId.startsWith("revision:") ? [selectedNodeId.slice(9)] : [];
  while (pending.length) { const id = pending.pop()!; if (ancestorIds.has(id)) continue; ancestorIds.add(id); pending.push(...(parents.get(id) ?? [])); }
  const prioritizedNodes = [...nodes].sort((left, right) => Number(right.selected) - Number(left.selected) || Number(ancestorIds.has(right.objectId)) - Number(ancestorIds.has(left.objectId)) || right.time.localeCompare(left.time));
  const displayedNodes = expanded ? nodes : prioritizedNodes.slice(0, 40);
  const hiddenCount = Math.max(nodes.length - displayedNodes.length, 0);
  const nodePosition = new Map(displayedNodes.filter((node) => node.kind !== "pointer").map((node) => [node.objectId, node]));
  const maxDisplayedX = Math.max(178, ...displayedNodes.map((node) => node.x));
  const width = Math.max(920, maxDisplayedX + 110);
  const height = Math.max(220, 120 + laneIds.length * 110);
  const sourceColor = "#72808a";

  return (
    <div className="dag-scroll" aria-label="文章版本与分支关系图">
      <svg className="version-dag" viewBox={`0 0 ${width} ${height}`} style={{ minWidth: width }} role="img" aria-label={`${article.title} 的历史源稿、修订与工作分支；选择节点可查看对应记录`}>
        <defs>
          <marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {laneIds.map((lane, index) => {
          const y = laneY.get(lane) ?? 0;
          return (
            <g key={lane} className="dag-lane">
              <text x="16" y={y + 5} className="dag-lane-label">{shorten(laneLabels.get(lane) ?? lane, 12)}</text>
              <line x1="148" x2={width - 22} y1={y} y2={y} className="dag-lane-rule" />
              {index > 0 && <circle cx="144" cy={y} r="4" fill={BRANCH_COLORS[(index - 1) % BRANCH_COLORS.length]} />}
            </g>
          );
        })}

        {sourceVersions.slice(1).map((version, index) => {
          const previous = nodePosition.get(sourceVersions[index].id);
          const current = nodePosition.get(version.id);
          if (!previous || !current) return null;
          return <line key={`suggested-${version.id}`} x1={previous.x + 68} y1={previous.y} x2={current.x - 68} y2={current.y} className="dag-edge suggested" />;
        })}

        {orderedRevisions.map((revision) => {
          const current = nodePosition.get(revision.id);
          if (!current) return null;
          const edges: ReactNode[] = [];
          if (revision.parentRevisionId && revisionNodeIds.has(revision.parentRevisionId)) {
            const parent = nodePosition.get(revision.parentRevisionId);
            if (parent) edges.push(<path key="parent" d={`M ${parent.x + 68} ${parent.y} C ${parent.x + 110} ${parent.y}, ${current.x - 110} ${current.y}, ${current.x - 68} ${current.y}`} className="dag-edge confirmed" markerEnd="url(#dag-arrow)" />);
          }
          if (revision.mergeParentRevisionId && revisionNodeIds.has(revision.mergeParentRevisionId)) {
            const parent = nodePosition.get(revision.mergeParentRevisionId);
            if (parent) edges.push(<path key="merge" d={`M ${parent.x + 68} ${parent.y} C ${parent.x + 110} ${parent.y}, ${current.x - 110} ${current.y}, ${current.x - 68} ${current.y}`} className="dag-edge merge" markerEnd="url(#dag-arrow)" />);
          }
          if (revision.sourceVersionId) {
            const source = nodePosition.get(revision.sourceVersionId);
            if (source) edges.push(<path key="source" d={`M ${source.x} ${source.y + 30} C ${source.x} ${source.y + 65}, ${current.x} ${current.y - 65}, ${current.x} ${current.y - 30}`} className="dag-edge source-binding" markerEnd="url(#dag-arrow)" />);
          }
          return <g key={`edges-${revision.id}`}>{edges}</g>;
        })}

        {displayedNodes.map((node) => {
          const branchIndex = branches.findIndex((branch) => branch.id === node.lane);
          const color = node.kind === "source" ? sourceColor : BRANCH_COLORS[Math.max(branchIndex, 0) % BRANCH_COLORS.length];
          return (
            <g
              key={node.id}
              className={`dag-node ${node.kind} ${node.selected ? "selected" : ""}`}
              transform={`translate(${node.x - 68} ${node.y - 30})`}
              role="button"
              tabIndex={0}
              aria-label={`${node.title}，${node.annotation}，${shortDate(node.time)}`}
              onClick={() => onSelect(node.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
            >
              <rect width="136" height="60" rx="5" style={{ stroke: color }} />
              <circle cx="12" cy="13" r="4" fill={color} />
              <text x="22" y="17" className="dag-node-title">{shorten(node.title, 16)}</text>
              <text x="12" y="36" className="dag-node-note">{shorten(node.annotation, 20)}</text>
              <text x="12" y="51" className="dag-node-time">{shortDate(node.time)}</text>
            </g>
          );
        })}
      </svg>
      <div className="dag-legend" aria-label="版本与分支关系说明">
        <span><i className="legend-line suggested" /> 相邻时间仅供核对，不表示父子关系</span>
        <span><i className="legend-line confirmed" /> 确认关系来自人工操作记录</span>
        <span><i className="legend-line source" /> 此修订使用的源稿基线</span>
      </div>
      {hiddenCount > 0 && <button type="button" className="dag-expand" onClick={() => setExpanded(true)}>已截断 {hiddenCount} 个节点；展开全部</button>}
      {expanded && nodes.length > 40 && <button type="button" className="dag-expand" onClick={() => setExpanded(false)}>恢复默认 40 节点</button>}
    </div>
  );
}
