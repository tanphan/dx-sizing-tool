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

function layoutNodes(
  ids: ComponentId[],
): Record<string, { x: number; y: number }> {
  const layers: ComponentId[][] = [
    ["users", "dnsGslb"],
    ["cdn", "waf", "cloudLb"],
    ["haproxy"],
    ["core", "webEngine", "iqIntegrator", "openLdap", "externalIdp"],
    [
      "externalDb",
      "dxDbSecondary",
      "remoteSearch",
      "searchMiddleware",
      "contentComposer",
      "ringApi",
      "dam",
      "mcpService",
      "peopleService",
      "rwxStorage",
      "objectStorage",
      "redis",
    ],
    [
      "openSearch",
      "fileProcessor",
      "imageProcessor",
      "persistencePool",
      "loggingSidecar",
      "runtimeController",
      "licenseManager",
      "secretsKms",
      "observability",
      "backupDr",
      "containerRegistry",
      "egressNat",
    ],
    [
      "persistenceNode",
      "persistenceMetrics",
      "damPluginGoogleVision",
      "damPluginKaltura",
      "prereqsChecker",
    ],
  ];
  const pos: Record<string, { x: number; y: number }> = {};
  const idSet = new Set(ids);
  let y = 0;
  for (const layer of layers) {
    const present = layer.filter((id) => idSet.has(id));
    present.forEach((id, i) => {
      const span = Math.max(present.length, 1);
      pos[id] = { x: 40 + i * 190 - (span - 1) * 20, y };
    });
    if (present.length) y += 130;
  }
  let lx = 0;
  for (const id of ids) {
    if (!pos[id]) {
      pos[id] = { x: lx * 180, y };
      lx += 1;
    }
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
