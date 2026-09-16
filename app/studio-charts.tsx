"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "./types";

interface RadarProps {
  values: Record<string, number>;
  comparison?: Record<string, number>;
  comparisonLabel?: string;
}

export function BaselineRadar({ values, comparison, comparisonLabel = "参考线" }: RadarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const entries = useMemo(() => Object.entries(values).slice(0, 8), [values]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || entries.length < 3) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const draw = () => {
      const rect = parent.getBoundingClientRect();
      const size = Math.max(260, Math.min(520, rect.width));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(dpr, dpr);
      context.clearRect(0, 0, size, size);

      const center = size / 2;
      const radius = size * 0.31;
      const labelRadius = size * 0.43;
      const count = entries.length;
      const point = (index: number, scale: number) => {
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
        return [center + Math.cos(angle) * radius * scale, center + Math.sin(angle) * radius * scale] as const;
      };

      context.strokeStyle = "rgba(30, 33, 29, .14)";
      context.lineWidth = 1;
      for (const ring of [0.25, 0.5, 0.75, 1]) {
        context.beginPath();
        entries.forEach((_entry, index) => {
          const [x, y] = point(index, ring);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.closePath();
        context.stroke();
      }
      entries.forEach((_entry, index) => {
        const [x, y] = point(index, 1);
        context.beginPath();
        context.moveTo(center, center);
        context.lineTo(x, y);
        context.stroke();
      });

      const drawShape = (source: Record<string, number>, fill: string, stroke: string) => {
        context.beginPath();
        entries.forEach(([key], index) => {
          const [x, y] = point(index, Math.max(0, Math.min(100, source[key] ?? 0)) / 100);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.closePath();
        context.fillStyle = fill;
        context.strokeStyle = stroke;
        context.lineWidth = 2;
        context.fill();
        context.stroke();
      };

      if (comparison) drawShape(comparison, "rgba(49, 92, 115, .07)", "rgba(49, 92, 115, .65)");
      drawShape(values, "rgba(200, 67, 43, .16)", "#C8432B");

      context.fillStyle = "#4f554f";
      context.font = "12px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      entries.forEach(([label], index) => {
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
        const x = center + Math.cos(angle) * labelRadius;
        const y = center + Math.sin(angle) * labelRadius;
        context.fillText(label.replace("代理", ""), x, y);
      });
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [comparison, entries, values]);

  return (
    <div className="radar-wrap">
      <canvas ref={canvasRef} aria-label={`创作基线雷达图${comparison ? `，与${comparisonLabel}对照` : ""}`} />
      <div className="chart-legend" aria-hidden="true">
        <span><i className="legend-current" /> 当前作品</span>
        {comparison ? <span><i className="legend-reference" /> {comparisonLabel}</span> : null}
      </div>
    </div>
  );
}

interface GraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

function hashNumber(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}

export function KnowledgeGraphCanvas({ nodes, edges, selectedId, onSelect }: GraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const positionsRef = useRef<PositionedNode[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const visible = useMemo(() => {
    const connectedIds = new Set<string>();
    if (selectedId) {
      connectedIds.add(selectedId);
      edges.forEach((edge) => {
        if (edge.source === selectedId) connectedIds.add(edge.target);
        if (edge.target === selectedId) connectedIds.add(edge.source);
      });
    }
    const topics = nodes.filter((node) => node.type === "topic").slice(0, 12);
    const articles = nodes.filter((node) => node.type === "article" && (!selectedId || connectedIds.has(node.id))).slice(0, selectedId ? 34 : 28);
    const visibleNodes = selectedId
      ? nodes.filter((node) => connectedIds.has(node.id)).slice(0, 44)
      : [...topics, ...articles];
    const ids = new Set(visibleNodes.map((node) => node.id));
    return {
      nodes: visibleNodes,
      edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).slice(0, 120),
    };
  }, [edges, nodes, selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const draw = () => {
      const rect = parent.getBoundingClientRect();
      const width = Math.max(300, rect.width);
      const height = Math.max(420, Math.min(660, width * 0.62));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(dpr, dpr);
      context.clearRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      const positioned: PositionedNode[] = visible.nodes.map((node, index) => {
        if (node.id === selectedId) return { ...node, x: centerX, y: centerY };
        const seed = hashNumber(node.id);
        const angle = ((seed % 360) / 180) * Math.PI + index * 0.21;
        const ring = node.type === "topic" ? 0.40 : 0.22 + ((seed >> 6) % 14) / 100;
        return {
          ...node,
          x: centerX + Math.cos(angle) * width * ring,
          y: centerY + Math.sin(angle) * height * Math.min(0.42, ring + 0.05),
        };
      });
      const byId = new Map(positioned.map((node) => [node.id, node]));
      positionsRef.current = positioned;

      context.lineWidth = 1;
      visible.edges.forEach((edge) => {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        if (!source || !target) return;
        const active = selectedId && (edge.source === selectedId || edge.target === selectedId);
        context.strokeStyle = active ? "rgba(200, 67, 43, .55)" : "rgba(30, 33, 29, .13)";
        context.beginPath();
        context.moveTo(source.x, source.y);
        context.lineTo(target.x, target.y);
        context.stroke();
      });

      positioned.forEach((node) => {
        const active = node.id === selectedId || node.id === hoveredId;
        const radius = Math.max(5, Math.min(15, node.size * 0.48)) + (active ? 2 : 0);
        context.beginPath();
        context.arc(node.x, node.y, radius, 0, Math.PI * 2);
        context.fillStyle = node.type === "topic" ? "#315C73" : active ? "#C8432B" : "#59675c";
        context.fill();
        context.strokeStyle = "#F4F0E7";
        context.lineWidth = 2;
        context.stroke();

        if (active || node.type === "topic") {
          context.font = active ? "600 13px system-ui, sans-serif" : "12px system-ui, sans-serif";
          context.fillStyle = "#262a25";
          context.textAlign = "center";
          context.textBaseline = "top";
          const label = node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label;
          context.fillText(label, node.x, node.y + radius + 6);
        }
      });
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [hoveredId, selectedId, visible]);

  const findNode = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return positionsRef.current.find((node) => Math.hypot(node.x - x, node.y - y) <= Math.max(16, node.size * 0.65));
  };

  return (
    <canvas
      ref={canvasRef}
      className="knowledge-canvas"
      aria-label="内容图谱画布；下方的关系列表可完成相同的查看与选择操作。"
      onPointerMove={(event) => setHoveredId(findNode(event)?.id ?? null)}
      onPointerLeave={() => setHoveredId(null)}
      onClick={(event) => {
        const node = findNode(event);
        if (node) onSelect(node.id);
      }}
    />
  );
}
