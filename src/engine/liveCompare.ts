import type { LiveUtilRow, SizedNode } from "./types";

export interface LiveCompareRow {
  componentId: string;
  label: string;
  estimatedCpu: number;
  observedCpu: number;
  cpuDeltaPct: number;
  estimatedMemGi: number;
  observedMemGi: number;
  memDeltaPct: number;
  status: "ok" | "under" | "over" | "missing";
}

export function compareEstimateVsLive(
  nodes: SizedNode[],
  live: LiveUtilRow[],
): LiveCompareRow[] {
  const byId = new Map(live.map((r) => [r.componentId, r]));
  return nodes
    .filter((n) => n.replicas > 0 && n.id !== "users" && n.id !== "cdn")
    .map((n) => {
      const obs = byId.get(n.id);
      if (!obs) {
        return {
          componentId: n.id,
          label: n.label,
          estimatedCpu: n.cpuCores,
          observedCpu: 0,
          cpuDeltaPct: 0,
          estimatedMemGi: n.memGi,
          observedMemGi: 0,
          memDeltaPct: 0,
          status: "missing" as const,
        };
      }
      const cpuDeltaPct =
        n.cpuCores > 0
          ? ((obs.cpuCoresObserved - n.cpuCores) / n.cpuCores) * 100
          : 0;
      const memDeltaPct =
        n.memGi > 0
          ? ((obs.memGiObserved - n.memGi) / n.memGi) * 100
          : 0;
      let status: LiveCompareRow["status"] = "ok";
      if (cpuDeltaPct > 25 || memDeltaPct > 25) status = "over";
      else if (cpuDeltaPct < -40 || memDeltaPct < -40) status = "under";
      return {
        componentId: n.id,
        label: n.label,
        estimatedCpu: n.cpuCores,
        observedCpu: obs.cpuCoresObserved,
        cpuDeltaPct,
        estimatedMemGi: n.memGi,
        observedMemGi: obs.memGiObserved,
        memDeltaPct,
        status,
      };
    });
}

/** Parse kubectl top pods-style TSV/CSV: NAME CPU(cores) MEMORY(bytes) */
export function parseKubectlTop(
  text: string,
  nameToComponent: Record<string, string>,
): LiveUtilRow[] {
  const rows: LiveUtilRow[] = [];
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (/^NAME\b/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const name = parts[0];
    const cpuRaw = parts[1];
    const memRaw = parts[2];
    let componentId: string | undefined;
    for (const [needle, id] of Object.entries(nameToComponent)) {
      if (name.includes(needle)) {
        componentId = id;
        break;
      }
    }
    if (!componentId) continue;

    let cpu = 0;
    if (cpuRaw.endsWith("m")) cpu = parseFloat(cpuRaw) / 1000;
    else cpu = parseFloat(cpuRaw);

    let memGi = 0;
    if (/Mi$/i.test(memRaw)) memGi = parseFloat(memRaw) / 1024;
    else if (/Gi$/i.test(memRaw)) memGi = parseFloat(memRaw);
    else if (/Ki$/i.test(memRaw)) memGi = parseFloat(memRaw) / (1024 * 1024);
    else memGi = parseFloat(memRaw) / (1024 ** 3);

    const existing = rows.find((r) => r.componentId === componentId);
    if (existing) {
      existing.cpuCoresObserved += cpu;
      existing.memGiObserved += memGi;
    } else {
      rows.push({
        componentId: componentId as LiveUtilRow["componentId"],
        cpuCoresObserved: cpu,
        memGiObserved: memGi,
      });
    }
  }
  return rows;
}

export const defaultNameMap: Record<string, string> = {
  haproxy: "haproxy",
  "dx-core": "core",
  core: "core",
  "web-engine": "webEngine",
  webengine: "webEngine",
  dam: "dam",
  "image-processor": "imageProcessor",
  "remote-search": "remoteSearch",
  opensearch: "openSearch",
  "ring-api": "ringApi",
  "content-composer": "contentComposer",
  "iq-integrator": "iqIntegrator",
};
