import type { CapacityProfile, ComponentProfile, Product } from "./types";
import composeCf237 from "../profiles/compose-cf237.json";
import dxcnCf238 from "../profiles/dxcn-cf238.json";
import platformComponents from "../profiles/platform-components.json";
/**
 * Merge platform components into a product profile.
 *
 * Core/webEngine cpuBase/memBaseGi stay as *demand* (what the JVM uses at idle).
 * The HCL pod size (5.6 CPU / 8Gi) is applied as an allocation in sizeNode, so
 * per-RPS CPU is measured against pod headroom and calibration (which subtracts
 * cpuBase) yields a non-zero cpuPerRps.
 */
function withPlatformAndHclFloors(raw: CapacityProfile): CapacityProfile {
  const components: CapacityProfile["components"] = {
    ...(platformComponents as CapacityProfile["components"]),
    ...raw.components,
  };

  // externalDb label as primary
  if (components.externalDb) {
    components.externalDb = {
      ...components.externalDb,
      label: "DX DB primary",
    };
  }

  return { ...raw, components };
}

const profiles: Record<string, CapacityProfile> = {
  "dxcn-cf238": withPlatformAndHclFloors(dxcnCf238 as CapacityProfile),
  "compose-cf237": withPlatformAndHclFloors(composeCf237 as CapacityProfile),
};

export function getDefaultProfileId(product: Product): string {
  return product === "dxcn" ? "dxcn-cf238" : "compose-cf237";
}

export function loadProfile(id: string): CapacityProfile {
  const p = profiles[id];
  if (!p) throw new Error(`Unknown capacity profile: ${id}`);
  return p;
}

export function listProfiles(): CapacityProfile[] {
  return Object.values(profiles);
}

export function registerProfile(profile: CapacityProfile): void {
  profiles[profile.id] = profile;
}

export function mergeProfilePatch(
  base: CapacityProfile,
  patch: {
    id?: string;
    confidence?: CapacityProfile["confidence"];
    components?: Record<string, Partial<ComponentProfile>>;
  },
): CapacityProfile {
  const components: CapacityProfile["components"] = { ...base.components };
  if (patch.components) {
    for (const [id, partial] of Object.entries(patch.components)) {
      const prev = components[id];
      if (!prev) continue;
      components[id] = { ...prev, ...partial, id: prev.id };
    }
  }
  return {
    ...base,
    id: patch.id ?? base.id,
    components,
    confidence: patch.confidence ?? "lab-calibrated",
  };
}
