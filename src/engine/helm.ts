import { HCL_CORE_POD } from "./hclGuidance";
import type { HelmHints, HelmResources, SizedNode } from "./types";

/**
 * Tool component id → hcl-dx-deployment chart name, as used under
 * `resources.<name>` in the chart's values.yaml (verified against CF233 and CF237).
 */
const DX_CHART_NAMES: Record<string, string> = {
  haproxy: "haproxy",
  core: "core",
  webEngine: "webEngine",
  remoteSearch: "remoteSearch",
  contentComposer: "contentComposer",
  ringApi: "ringApi",
  dam: "digitalAssetManagement",
  imageProcessor: "imageProcessor",
  persistenceNode: "persistenceNode",
  persistencePool: "persistenceConnectionPool",
  persistenceMetrics: "persistenceMetricsExporter",
  openLdap: "openLdap",
  licenseManager: "licenseManager",
  runtimeController: "runtimeController",
  damPluginGoogleVision: "damPluginGoogleVision",
  damPluginKaltura: "damPluginKaltura",
};

/** Names the chart accepts under `scaling.replicas` (others are single-instance). */
const DX_SCALABLE = new Set([
  "contentComposer",
  "core",
  "damPluginGoogleVision",
  "digitalAssetManagement",
  "imageProcessor",
  "ringApi",
  "persistenceConnectionPool",
  "runtimeController",
  "persistenceNode",
  "haproxy",
  "licenseManager",
  "damPluginKaltura",
  "webEngine",
]);

/**
 * Components shipped by separate charts (Search V2, DX IQ, People Service).
 * Descriptive labels only — key paths differ per chart and are not emitted as YAML.
 */
const OTHER_CHART_NAMES: Record<string, string> = {
  searchMiddleware: "Search V2 chart · search middleware (query + data)",
  openSearch: "Search V2 chart · OpenSearch (manager + data)",
  fileProcessor: "Search V2 chart · file processor",
  iqIntegrator: "DX IQ chart · IQ integrator",
  mcpService: "DX IQ chart · MCP service",
  peopleService: "People Service chart",
};

/** Chart comment in values.yaml: do not run more than 5 persistence nodes. */
export const MAX_PERSISTENCE_NODES = 5;

function fmtCpu(cores: number): string {
  if (cores < 1) return `${Math.max(50, Math.round(cores * 1000))}m`;
  return cores.toFixed(2).replace(/\.?0+$/, "");
}

function fmtMem(gi: number): string {
  if (gi < 1) return `${Math.max(64, Math.round(gi * 1024))}Mi`;
  return `${gi.toFixed(1).replace(/\.0$/, "")}Gi`;
}

/**
 * Requests == limits for CPU and memory: matches hcl-dx-deployment chart
 * defaults and the HCL K8s guide (memory request must equal limit).
 */
function podResources(n: SizedNode): HelmResources {
  const reps = Math.max(1, n.replicas);
  const cpu = fmtCpu(n.cpuCores / reps);
  const memory = fmtMem(n.memGi / reps);
  return { requests: { cpu, memory }, limits: { cpu, memory } };
}

export function buildHelmHints(nodes: SizedNode[]): HelmHints {
  const hints: HelmHints = { scaling: {}, resources: {}, otherCharts: {}, notes: [] };

  for (const n of nodes) {
    if (n.replicas <= 0) continue;
    if (n.id === "prereqsChecker" || n.id === "loggingSidecar") continue;

    const dxName = DX_CHART_NAMES[n.id];
    if (dxName) {
      hints.resources[dxName] = podResources(n);
      if (DX_SCALABLE.has(dxName)) hints.scaling[dxName] = n.replicas;
      continue;
    }
    const other = OTHER_CHART_NAMES[n.id];
    if (other) {
      hints.otherCharts[other] = { replicas: n.replicas, ...podResources(n) };
    }
    // Platform / external components (DB, IdP, WAF, …) are not Helm-managed here.
  }

  if (hints.scaling.core || hints.scaling.webEngine) {
    hints.notes.push(
      `Core/webEngine JVM: -Xms${HCL_CORE_POD.heapGi}g -Xmx${HCL_CORE_POD.heapGi}g per HCL guide. ` +
        "The CF237 webEngine template sets -Xms2560m with no -Xmx — set heap explicitly.",
    );
  }
  if ((hints.scaling.persistenceNode ?? 0) > MAX_PERSISTENCE_NODES) {
    hints.notes.push(
      `persistenceNode > ${MAX_PERSISTENCE_NODES} is not supported by the chart`,
    );
  }
  return hints;
}

function resourceLines(r: HelmResources, indent: string): string[] {
  return [
    `${indent}requests:`,
    `${indent}  cpu: "${r.requests.cpu}"`,
    `${indent}  memory: "${r.requests.memory}"`,
    `${indent}limits:`,
    `${indent}  cpu: "${r.limits.cpu}"`,
    `${indent}  memory: "${r.limits.memory}"`,
  ];
}

/** Values overlay for hcl-dx-deployment (`helm upgrade -f`). */
export function helmHintsYaml(hints: HelmHints): string {
  const lines: string[] = [
    "# Generated DX sizing values overlay for hcl-dx-deployment",
    "# Estimation aid — not HCL official SCU. Review before applying.",
    ...hints.notes.map((n) => `# NOTE: ${n}`),
    "",
    "scaling:",
    "  replicas:",
  ];
  for (const [k, v] of Object.entries(hints.scaling)) lines.push(`    ${k}: ${v}`);
  lines.push("resources:");
  for (const [k, r] of Object.entries(hints.resources)) {
    lines.push(`  ${k}:`);
    lines.push(...resourceLines(r, "    "));
  }

  const others = Object.entries(hints.otherCharts);
  if (others.length) {
    lines.push("");
    lines.push("# --- Separate charts (Search V2 / DX IQ / People Service) — map into their own values ---");
    for (const [k, r] of others) {
      lines.push(`# ${k}: replicas ${r.replicas}, cpu ${r.limits.cpu}, memory ${r.limits.memory} (req=limit)`);
    }
  }
  return lines.join("\n");
}
