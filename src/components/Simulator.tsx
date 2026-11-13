import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import type { CloudProvider } from "../engine/cloudProviders";
import type {
  ComponentId,
  ComponentPlane,
  ComponentToggles,
  Product,
  SizingResult,
  UnitCosts,
  UsageInputs,
} from "../engine/types";
import { runSizing } from "../engine/runSizing";
import { selectTopology } from "../engine/topology";
import { scenarioPresets, applyScenario } from "../scenarios";

interface Props {
  product: Product;
  inputs: UsageInputs;
  toggles: ComponentToggles;
  costs: UnitCosts;
  cloudProvider: CloudProvider;
  result: SizingResult;
  onInputs: (v: UsageInputs) => void;
  onToggles: (v: ComponentToggles) => void;
}

const NODE_W = 210;
const NODE_H = 100;
const GAP_X = 48;
const GAP_Y = 56;
const MAX_PER_ROW = 4;
const CANVAS_PAD = 40;

/** Preferred top→bottom bands; wide bands wrap into sub-rows of MAX_PER_ROW. */
const LAYOUT_BANDS: ComponentId[][] = [
  ["users", "dnsGslb"],
  ["cdn", "waf", "cloudLb"],
  ["haproxy"],
  ["core", "webEngine"],
  ["openLdap", "externalIdp", "iqIntegrator", "peopleService"],
  ["externalDb", "dxDbSecondary", "redis"],
  ["rwxStorage", "objectStorage"],
  ["remoteSearch", "searchMiddleware", "openSearch", "fileProcessor"],
  ["contentComposer", "ringApi", "dam"],
  ["imageProcessor", "persistencePool", "persistenceNode", "persistenceMetrics"],
  ["damPluginGoogleVision", "damPluginKaltura"],
  ["loggingSidecar", "runtimeController", "licenseManager", "prereqsChecker"],
  ["secretsKms", "observability", "backupDr", "containerRegistry", "egressNat", "mcpService"],
];

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function layoutNodes(
  ids: ComponentId[],
): Record<string, { x: number; y: number }> {
  const idSet = new Set(ids);
  const pos: Record<string, { x: number; y: number }> = {};
  const placed = new Set<ComponentId>();

  const rows: ComponentId[][] = [];
  for (const band of LAYOUT_BANDS) {
    const present = band.filter((id) => idSet.has(id));
    if (!present.length) continue;
    for (const row of chunk(present, MAX_PER_ROW)) rows.push(row);
  }
  // leftovers not in LAYOUT_BANDS
  const leftovers = ids.filter((id) => !LAYOUT_BANDS.some((b) => b.includes(id)));
  for (const row of chunk(leftovers, MAX_PER_ROW)) {
    if (row.length) rows.push(row);
  }

  // Width of widest row — used to center narrower rows
  const maxCols = Math.max(1, ...rows.map((r) => r.length));
  const rowPitch = NODE_W + GAP_X;
  const colPitch = NODE_H + GAP_Y;
  const fullWidth = maxCols * NODE_W + (maxCols - 1) * GAP_X;

  rows.forEach((row, rowIdx) => {
    const rowWidth = row.length * NODE_W + (row.length - 1) * GAP_X;
    const x0 = CANVAS_PAD + (fullWidth - rowWidth) / 2;
    const y = CANVAS_PAD + rowIdx * colPitch;
    row.forEach((id, i) => {
      pos[id] = { x: x0 + i * rowPitch, y };
      placed.add(id);
    });
  });

  // Safety: any id still missing
  let orphan = 0;
  for (const id of ids) {
    if (placed.has(id)) continue;
    pos[id] = {
      x: CANVAS_PAD + (orphan % MAX_PER_ROW) * rowPitch,
      y: CANVAS_PAD + (rows.length + Math.floor(orphan / MAX_PER_ROW)) * colPitch,
    };
    orphan += 1;
  }
  return pos;
}

function UtilNode({ data }: NodeProps) {
  const d = data as {
    label: string;
    utilBand: string;
    util: number;
    replicas: number;
    offeredRps: number;
    plane: ComponentPlane;
  };
  return (
    <div
      className={`flow-node plane-${d.plane} ${d.utilBand === "n/a" ? "na" : d.utilBand}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="plane-badge">
        {d.plane === "hcl" ? "HCL DX" : d.plane === "platform" ? "Platform" : "Client"}
      </div>
      <div className="title">{d.label}</div>
      <div className="meta">
        {d.offeredRps.toFixed(1)} rps · x{d.replicas}
        {d.utilBand !== "n/a" ? ` · ${(d.util * 100).toFixed(0)}%` : ""}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { util: UtilNode };

export function Simulator({
  product,
  inputs,
  toggles,
  costs,
  cloudProvider,
  result,
  onInputs,
  onToggles,
}: Props) {
  const [selected, setSelected] = useState<ComponentId | null>(null);
  const [replicaOverrides, setReplicaOverrides] = useState<
    Partial<Record<string, number>>
  >({});
  const [enableCdn, setEnableCdn] = useState(true);

  const liveResult = useMemo(
    () =>
      runSizing({
        product,
        inputs,
        toggles,
        costs,
        cloudProvider,
        replicaOverrides,
        enableCdn,
      }),
    [product, inputs, toggles, costs, cloudProvider, replicaOverrides, enableCdn],
  );

  const { nodes: topoNodes } = selectTopology(
    product,
    toggles,
    inputs.productionPlatform,
  );

  const flowNodes: Node[] = useMemo(() => {
    const ids = topoNodes.map((n) => n.id);
    const withEntry = Array.from(
      new Set<ComponentId>(["users", "cdn", ...ids]),
    );
    const pos = layoutNodes(withEntry);
    const sizedMap = new Map(liveResult.nodes.map((n) => [n.id, n]));
    const planeMap = new Map(topoNodes.map((n) => [n.id, n.plane]));

    return withEntry.map((id) => {
      const sized = sizedMap.get(id);
      const label =
        sized?.label ?? topoNodes.find((n) => n.id === id)?.label ?? id;
      const plane = sized?.plane ?? planeMap.get(id) ?? "client";
      return {
        id,
        type: "util",
        position: pos[id],
        data: {
          label,
          plane,
          utilBand: sized?.utilBand ?? "n/a",
          util: sized?.util ?? 0,
          replicas: sized?.replicas ?? 0,
          offeredRps:
            sized?.offeredRps ??
            (id === "users" || id === "cdn"
              ? liveResult.demand.frontDoorRps
              : 0),
        },
      };
    });
  }, [topoNodes, liveResult]);

  const flowEdges: Edge[] = useMemo(
    () =>
      liveResult.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: `${e.label} ${e.rps.toFixed(1)}`,
        animated: e.rps > 0,
        style: { stroke: e.rps > 0 ? "#3d9cf0" : "#2a3544" },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        labelStyle: { fill: "#8b9bb0", fontSize: 10 },
      })),
    [liveResult.edges],
  );

  const selectedNode = liveResult.nodes.find((n) => n.id === selected);

  return (
    <div className="sim-wrap">
      <div className="sim-toolbar">
        <label className="muted">
          Load ×{inputs.loadMultiplier.toFixed(1)}
          <input
            type="range"
            min={0.1}
            max={5}
            step={0.1}
            value={inputs.loadMultiplier}
            onChange={(e) =>
              onInputs({
                ...inputs,
                loadMultiplier: Number(e.target.value),
              })
            }
            style={{ width: 160, marginLeft: 8, verticalAlign: "middle" }}
          />
        </label>
        <label className="toggle" style={{ border: 0, padding: 0 }}>
          <input
            type="checkbox"
            checked={enableCdn}
            onChange={(e) => setEnableCdn(e.target.checked)}
          />
          CDN enabled
        </label>
        <div className="legend-row">
          <span className="plane-tag hcl">HCL DX</span>
          <span className="plane-tag platform">Platform</span>
          <span className="plane-tag client">Client</span>
        </div>
        <div className="preset-row">
          {scenarioPresets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn"
              onClick={() => {
                const next = applyScenario(product, inputs, toggles, p);
                onInputs(next.inputs);
                onToggles(next.toggles);
                setReplicaOverrides({});
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sim-canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 0.95, minZoom: 0.15 }}
          minZoom={0.15}
          maxZoom={1.4}
          nodesDraggable
          nodesConnectable={false}
          onNodeClick={(_, n) => setSelected(n.id as ComponentId)}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} color="#1e2836" />
          <Controls />
          <MiniMap
            nodeColor={(n) => {
              const plane = (n.data as { plane?: string })?.plane;
              if (plane === "hcl") return "#3d9cf0";
              if (plane === "platform") return "#c4a35a";
              return "#6b7c8f";
            }}
          />
        </ReactFlow>
      </div>

      {selectedNode && (
        <div className="drawer">
          <h3>
            {selectedNode.label}{" "}
            <span className={`plane-tag ${selectedNode.plane}`}>
              {selectedNode.plane}
            </span>{" "}
            <span className="muted">({selectedNode.utilBand})</span>
          </h3>
          <p className="muted">
            Offered {selectedNode.offeredRps.toFixed(2)} rps · capacity{" "}
            {selectedNode.capacityRps.toFixed(0)} · util{" "}
            {(selectedNode.util * 100).toFixed(1)}% · {selectedNode.replicas}{" "}
            replicas · {selectedNode.cpuCores.toFixed(2)} CPU ·{" "}
            {selectedNode.memGi.toFixed(1)} Gi · $
            {selectedNode.infraCostMonth.toFixed(0)}/mo
          </p>
          {selectedNode.notes.length > 0 && (
            <ul className="muted">
              {selectedNode.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <div className="btn-row">
            <button
              type="button"
              className="btn primary"
              onClick={() =>
                setReplicaOverrides({
                  ...replicaOverrides,
                  [selectedNode.id]: selectedNode.replicas + 1,
                })
              }
            >
              Add replica
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setEnableCdn(true)}
            >
              Enable CDN
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setReplicaOverrides({});
                onInputs({ ...inputs, loadMultiplier: 1 });
              }}
            >
              Reset fixes
            </button>
          </div>
        </div>
      )}

      {!selectedNode && (
        <p className="muted" style={{ marginTop: 8 }}>
          Same engine as estimator (profile {result.profileId}). Blue =
          HCL DX · gold/dashed = platform · grey = client. Origin WAF sits
          after CDN.
        </p>
      )}
    </div>
  );
}
