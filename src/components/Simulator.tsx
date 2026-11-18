import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  Handle,
  Position,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudProvider } from "../engine/cloudProviders";
import type { PricingSelection } from "../engine/pricing";
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
  pricing?: PricingSelection;
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

type Pos = { x: number; y: number };

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
  [
    "secretsKms",
    "observability",
    "backupDr",
    "containerRegistry",
    "egressNat",
    "mcpService",
  ],
];

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function layoutNodes(ids: ComponentId[]): Record<string, Pos> {
  const idSet = new Set(ids);
  const pos: Record<string, Pos> = {};
  const placed = new Set<ComponentId>();

  const rows: ComponentId[][] = [];
  for (const band of LAYOUT_BANDS) {
    const present = band.filter((id) => idSet.has(id));
    if (!present.length) continue;
    for (const row of chunk(present, MAX_PER_ROW)) rows.push(row);
  }
  const leftovers = ids.filter((id) => !LAYOUT_BANDS.some((b) => b.includes(id)));
  for (const row of chunk(leftovers, MAX_PER_ROW)) {
    if (row.length) rows.push(row);
  }

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

  let orphan = 0;
  for (const id of ids) {
    if (placed.has(id)) continue;
    pos[id] = {
      x: CANVAS_PAD + (orphan % MAX_PER_ROW) * rowPitch,
      y:
        CANVAS_PAD +
        (rows.length + Math.floor(orphan / MAX_PER_ROW)) * colPitch,
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
        {d.plane === "hcl"
          ? "HCL DX"
          : d.plane === "platform"
            ? "Platform"
            : "Client"}
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

function topologyKey(
  product: Product,
  productionPlatform: boolean,
  toggles: ComponentToggles,
): string {
  return `${product}|${productionPlatform}|${Object.entries(toggles)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort()
    .join(",")}`;
}

function SimulatorCanvas({
  product,
  inputs,
  toggles,
  costs,
  cloudProvider,
  pricing,
  result: _result,
  onInputs,
  onToggles,
}: Props) {
  void _result;
  const { fitView } = useReactFlow();
  const [selected, setSelected] = useState<ComponentId | null>(null);
  const [replicaOverrides, setReplicaOverrides] = useState<
    Partial<Record<string, number>>
  >({});
  const [enableCdn, setEnableCdn] = useState(true);
  const liveResultRef = useRef<SizingResult | null>(null);

  /**
   * Set a manual replica count (add or remove). The engine clamps to ≥ 1 and
   * flags counts below the availability floor. Returning to the recommended
   * count clears the override, so later input changes resize it again.
   */
  const setReplicas = useCallback(
    (id: ComponentId, next: number) => {
      setReplicaOverrides((prev) => {
        const rec = liveResultRef.current?.nodes.find((n) => n.id === id)
          ?.recommendedReplicas;
        const copy = { ...prev };
        if (next === rec) delete copy[id];
        else copy[id] = Math.max(1, next);
        return copy;
      });
    },
    [],
  );
  /** User-dragged positions — survive sizing recalcs until Reset layout */
  const [posOverrides, setPosOverrides] = useState<Record<string, Pos>>({});
  const [nodes, setNodes] = useState<Node[]>([]);
  const topoKeyRef = useRef("");

  const liveResult = useMemo(
    () =>
      runSizing({
        product,
        inputs,
        toggles,
        costs,
        cloudProvider,
        pricing,
        replicaOverrides,
        enableCdn,
      }),
    [product, inputs, toggles, costs, cloudProvider, pricing, replicaOverrides, enableCdn],
  );
  liveResultRef.current = liveResult;

  const topology = useMemo(
    () => selectTopology(product, toggles, inputs.productionPlatform),
    [product, toggles, inputs.productionPlatform],
  );
  const topoNodes = topology.nodes;
  const topoKey = topologyKey(product, inputs.productionPlatform, toggles);

  const nodeIds = useMemo(() => {
    const ids = topoNodes.map((n) => n.id);
    return Array.from(new Set<ComponentId>(["users", "cdn", ...ids]));
  }, [topoNodes]);

  const autoLayout = useMemo(() => layoutNodes(nodeIds), [nodeIds]);

  const makeNodes = useCallback(
    (overrides: Record<string, Pos>, sizing: SizingResult): Node[] => {
      const sizedMap = new Map(sizing.nodes.map((n) => [n.id, n]));
      const planeMap = new Map(topoNodes.map((n) => [n.id, n.plane]));
      const labelMap = new Map(topoNodes.map((n) => [n.id, n.label]));

      return nodeIds.map((id) => {
        const sized = sizedMap.get(id);
        const label = sized?.label ?? labelMap.get(id) ?? id;
        const plane = sized?.plane ?? planeMap.get(id) ?? "client";
        return {
          id,
          type: "util",
          position: overrides[id] ?? autoLayout[id] ?? { x: 0, y: 0 },
          width: NODE_W,
          height: NODE_H,
          style: { width: NODE_W, height: NODE_H },
          draggable: true,
          data: {
            label,
            plane,
            utilBand: sized?.utilBand ?? "n/a",
            util: sized?.util ?? 0,
            replicas: sized?.replicas ?? 0,
            offeredRps:
              sized?.offeredRps ??
              (id === "users" || id === "cdn"
                ? sizing.demand.frontDoorRps
                : 0),
          },
        };
      });
    },
    [nodeIds, autoLayout, topoNodes],
  );

  // Full layout rebuild only when topology membership changes (or first mount).
  useEffect(() => {
    const prev = topoKeyRef.current;
    const topoChanged = !!prev && prev !== topoKey;
    topoKeyRef.current = topoKey;
    if (topoChanged) setPosOverrides({});
    setNodes(makeNodes(topoChanged ? {} : posOverrides, liveResult));
    if (topoChanged) {
      queueMicrotask(() => fitView({ padding: 0.18, maxZoom: 0.95 }));
    }
    // posOverrides intentionally omitted — drag must not rebuild via this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoKey, makeNodes]);

  // Patch util/label data in place when sizing changes; keep current positions.
  useEffect(() => {
    setNodes((nds) => {
      if (!nds.length) return makeNodes(posOverrides, liveResult);
      const sizedMap = new Map(liveResult.nodes.map((n) => [n.id, n]));
      return nds.map((n) => {
        const sized = sizedMap.get(n.id as ComponentId);
        const prev = n.data as {
          label: string;
          plane: ComponentPlane;
          utilBand: string;
          util: number;
          replicas: number;
          offeredRps: number;
        };
        return {
          ...n,
          data: {
            ...prev,
            label: sized?.label ?? prev.label,
            plane: sized?.plane ?? prev.plane,
            utilBand: sized?.utilBand ?? "n/a",
            util: sized?.util ?? 0,
            replicas: sized?.replicas ?? 0,
            offeredRps:
              sized?.offeredRps ??
              (n.id === "users" || n.id === "cdn"
                ? liveResult.demand.frontDoorRps
                : prev.offeredRps),
          },
        };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveResult]);

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

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    setPosOverrides((prev) => ({
      ...prev,
      [node.id]: { x: node.position.x, y: node.position.y },
    }));
  }, []);

  const resetLayout = useCallback(() => {
    setPosOverrides({});
    setNodes(makeNodes({}, liveResult));
    queueMicrotask(() => fitView({ padding: 0.18, maxZoom: 0.95 }));
  }, [makeNodes, liveResult, fitView]);

  const selectedNode = liveResult.nodes.find((n) => n.id === selected);
  const hasCustomLayout = Object.keys(posOverrides).length > 0;

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
        <button
          type="button"
          className="btn"
          onClick={resetLayout}
          disabled={!hasCustomLayout}
          title="Restore auto band layout and fit view"
        >
          Reset layout
        </button>
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
                setPosOverrides({});
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sim-canvas">
        <ReactFlow
          colorMode="dark"
          nodes={nodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 0.95, minZoom: 0.15 }}
          minZoom={0.15}
          maxZoom={1.4}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_, n) => setSelected(n.id as ComponentId)}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} color="#1e2836" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            bgColor="#243044"
            maskColor="rgba(0, 0, 0, 0.45)"
            nodeStrokeWidth={1}
            nodeStrokeColor="#e7ecf3"
            nodeBorderRadius={3}
            nodeColor={(n) => {
              const plane = (n.data as { plane?: string })?.plane;
              if (plane === "hcl") return "#4aa3f0";
              if (plane === "platform") return "#d4b56a";
              return "#9aabbd";
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
            {(selectedNode.util * 100).toFixed(1)}% (p90{" "}
            {(selectedNode.utilP90 * 100).toFixed(0)}%) · {selectedNode.replicas}{" "}
            replicas
            {selectedNode.replicas !== selectedNode.recommendedReplicas &&
              ` (recommended ${selectedNode.recommendedReplicas})`}{" "}
            · {selectedNode.cpuCores.toFixed(2)} CPU ·{" "}
            {selectedNode.memGi.toFixed(1)} Gi · $
            {selectedNode.infraCostMonth.toFixed(0)}/mo
            {selectedNode.p95Ms != null &&
              ` · est. p95 ${Number.isFinite(selectedNode.p95Ms) ? `${Math.round(selectedNode.p95Ms)}ms` : "unbounded"}`}
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
              disabled={!selectedNode.scalable}
              title={selectedNode.scalable ? undefined : "Fixed component — replicas are not scaled"}
              onClick={() => setReplicas(selectedNode.id, selectedNode.replicas + 1)}
            >
              Add replica
            </button>
            <button
              type="button"
              className="btn"
              disabled={!selectedNode.scalable || selectedNode.replicas <= 1}
              title={
                !selectedNode.scalable
                  ? "Fixed component — replicas are not scaled"
                  : selectedNode.replicas <= 1
                    ? "Already at 1 replica"
                    : selectedNode.replicas <= selectedNode.minSafeReplicas
                      ? `Goes below the availability floor of ${selectedNode.minSafeReplicas}`
                      : undefined
              }
              onClick={() => setReplicas(selectedNode.id, selectedNode.replicas - 1)}
            >
              Remove replica
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
            <button type="button" className="btn" onClick={resetLayout}>
              Reset layout
            </button>
          </div>
        </div>
      )}

      {!selectedNode && (
        <p className="muted" style={{ marginTop: 8 }}>
          Drag nodes to rearrange. <strong>Reset layout</strong> restores the
          auto band layout. Blue = HCL DX · gold = platform · grey = client.
        </p>
      )}
    </div>
  );
}

export function Simulator(props: Props) {
  return (
    <ReactFlowProvider>
      <SimulatorCanvas {...props} />
    </ReactFlowProvider>
  );
}
