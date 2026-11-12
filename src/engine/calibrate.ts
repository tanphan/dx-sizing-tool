import { mergeProfilePatch, registerProfile } from "./profiles";
import type { CapacityProfile, ComponentId } from "./types";

export interface LocustMeasurement {
  componentId: ComponentId;
  /** Sustained RPS at the measured util */
  rps: number;
  /** Average CPU cores used across replicas */
  cpuCores: number;
  /** Replica count during the test */
  replicas: number;
  /** Observed util 0–1 (optional; default 0.7) */
  util?: number;
}

export interface CalibrationResult {
  profile: CapacityProfile;
  notes: string[];
}

/**
 * Patch rpsPerReplica / cpuPerRps from Locust+metrics observations.
 * Formula: rpsPerReplica ≈ observed_rps / replicas / util_target
 */
export function calibrateFromLocust(
  base: CapacityProfile,
  measurements: LocustMeasurement[],
  newId?: string,
): CalibrationResult {
  const notes: string[] = [];
  const components: Record<string, Partial<CapacityProfile["components"][string]>> =
    {};

  for (const m of measurements) {
    const util = m.util && m.util > 0 ? m.util : 0.7;
    const rpsPerReplica = m.rps / Math.max(1, m.replicas) / util;
    const perRepRps = m.rps / Math.max(1, m.replicas);
    const cpuPerRps =
      perRepRps > 0
        ? Math.max(0, m.cpuCores / m.replicas - (base.components[m.componentId]?.cpuBase ?? 0)) /
          perRepRps
        : base.components[m.componentId]?.cpuPerRps ?? 0;

    components[m.componentId] = {
      rpsPerReplica: Math.max(1, Math.round(rpsPerReplica)),
      cpuPerRps: Math.max(0, Number(cpuPerRps.toFixed(6))),
    };
    notes.push(
      `${m.componentId}: rpsPerReplica→${components[m.componentId].rpsPerReplica} cpuPerRps→${components[m.componentId].cpuPerRps}`,
    );
  }

  const profile = mergeProfilePatch(base, {
    id: newId ?? `${base.id}-lab`,
    confidence: "lab-calibrated",
    components,
  });
  registerProfile(profile);
  return { profile, notes };
}

export function locustMeasurementsFromJson(text: string): LocustMeasurement[] {
  const data = JSON.parse(text) as { measurements?: LocustMeasurement[] } | LocustMeasurement[];
  if (Array.isArray(data)) return data;
  return data.measurements ?? [];
}

/** Example Locust scenario mix export matching AIOps-style browse/search/login/DAM */
export function exportLocustScenarioMix(inputs: {
  pctBrowse: number;
  pctAuthor: number;
  pctFormPost: number;
  searchAttachRate: number;
  damAttachRate: number;
  iqAttachRate: number;
}): string {
  return JSON.stringify(
    {
      name: "dx-sizing-export",
      weight: {
        browse: inputs.pctBrowse,
        author: inputs.pctAuthor,
        form_post: inputs.pctFormPost,
        search: Math.round(inputs.searchAttachRate * 100),
        dam: Math.round(inputs.damAttachRate * 100),
        iq_chat: Math.round(inputs.iqAttachRate * 100),
      },
      note: "Import into AIOps Locust profile; weights are relative task mix",
    },
    null,
    2,
  );
}
