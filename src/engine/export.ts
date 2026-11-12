import type { SizingResult } from "./types";
import { helmHintsYaml } from "./helm";

export function resultToJson(result: SizingResult): string {
  return JSON.stringify(result, null, 2);
}

export function resultToCsv(result: SizingResult): string {
  const header = [
    "component",
    "replicas",
    "offered_rps",
    "capacity_rps",
    "util",
    "cpu_cores",
    "mem_gi",
    "storage_gi",
    "infra_cost_month",
    "license_cost_month",
  ].join(",");
  const rows = result.nodes.map((n) =>
    [
      n.label,
      n.replicas,
      n.offeredRps.toFixed(2),
      n.capacityRps.toFixed(2),
      (n.util * 100).toFixed(1),
      n.cpuCores.toFixed(2),
      n.memGi.toFixed(2),
      n.storageGi.toFixed(2),
      n.infraCostMonth.toFixed(2),
      n.licenseCostMonth.toFixed(2),
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export { helmHintsYaml };
