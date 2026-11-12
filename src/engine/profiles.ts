import type { CapacityProfile, ComponentProfile, Product } from "./types";
import composeCf237 from "../profiles/compose-cf237.json";
import dxcnCf238 from "../profiles/dxcn-cf238.json";

const profiles: Record<string, CapacityProfile> = {
  "dxcn-cf238": dxcnCf238 as CapacityProfile,
  "compose-cf237": composeCf237 as CapacityProfile,
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
