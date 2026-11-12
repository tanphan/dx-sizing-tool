import type { HelmHints, SizedNode } from "./types";

const HELM_KEYS: Record<string, string> = {
  haproxy: "networking.haproxy",
  core: "core",
  webEngine: "applications.webEngine",
  remoteSearch: "applications.remoteSearch",
  contentComposer: "applications.contentComposer",
  ringApi: "applications.ringApi",
  dam: "applications.digitalAssetManagement",
  imageProcessor: "applications.imageProcessor",
  persistenceNode: "applications.persistenceNode",
  persistencePool: "applications.persistenceConnectionPool",
  openSearch: "applications.openSearch",
  searchMiddleware: "applications.searchMiddleware",
  fileProcessor: "applications.fileProcessor",
  iqIntegrator: "applications.iqIntegrator",
  mcpService: "applications.mcp",
  openLdap: "applications.openLdap",
  peopleService: "applications.peopleService",
  licenseManager: "applications.licenseManager",
  runtimeController: "configuration.runtimeController",
};

function fmtCpu(cores: number): string {
  if (cores < 1) return `${Math.max(50, Math.round(cores * 1000))}m`;
  return cores.toFixed(2).replace(/\.00$/, "");
}

function fmtMem(gi: number): string {
  if (gi < 1) return `${Math.max(64, Math.round(gi * 1024))}Mi`;
  return `${gi.toFixed(1).replace(/\.0$/, "")}Gi`;
}

export function buildHelmHints(nodes: SizedNode[]): HelmHints {
  const scaling: HelmHints["scaling"] = {};
  const resources: HelmHints["resources"] = {};

  for (const n of nodes) {
    if (n.replicas <= 0) continue;
    if (n.id === "users" || n.id === "cdn" || n.id === "externalDb" || n.id === "externalIdp") {
      continue;
    }
    if (n.id === "prereqsChecker" || n.id === "loggingSidecar") continue;

    const key = HELM_KEYS[n.id] ?? n.id;
    scaling[key] = n.replicas;

    const cpuReq = n.cpuCores / Math.max(1, n.replicas);
    const memReq = n.memGi / Math.max(1, n.replicas);
    resources[key] = {
      requests: {
        cpu: fmtCpu(cpuReq * 0.7),
        memory: fmtMem(memReq * 0.8),
      },
      limits: {
        cpu: fmtCpu(cpuReq),
        memory: fmtMem(memReq),
      },
    };
  }

  return { scaling, resources };
}

export function helmHintsYaml(hints: HelmHints): string {
  const lines: string[] = ["# Generated DX sizing Helm-ish resource hints", "# estimation aid — not HCL official SCU", ""];
  lines.push("scaling:");
  for (const [k, v] of Object.entries(hints.scaling)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push("resources:");
  for (const [k, r] of Object.entries(hints.resources)) {
    lines.push(`  ${k}:`);
    lines.push(`    requests:`);
    lines.push(`      cpu: "${r.requests.cpu}"`);
    lines.push(`      memory: "${r.requests.memory}"`);
    lines.push(`    limits:`);
    lines.push(`      cpu: "${r.limits.cpu}"`);
    lines.push(`      memory: "${r.limits.memory}"`);
  }
  return lines.join("\n");
}
