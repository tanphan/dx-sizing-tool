/**
 * Anchors from HCL DX Compose Kubernetes performance sizing guide (CF239):
 * https://help.hcl-software.com/digital-experience/dx-compose/CF239/guide_me/performance_tuning/kubernetes/
 *
 * Used as floors / preset mix — not a substitute for lab Locust calibration.
 */

export const HCL_SIZING_DOC =
  "https://help.hcl-software.com/digital-experience/dx-compose/CF239/guide_me/performance_tuning/kubernetes/";

/** Concurrent virtual users in HCL published rendering configs */
export const HCL_TIERS = {
  small: { concurrentUsers: 1000, label: "HCL Small (1k VU)" },
  large: { concurrentUsers: 30000, label: "HCL Large (30k VU)" },
} as const;

/**
 * Combination rendering load distribution from the guide:
 * WCM 40% · Pages/portlets 30% · DAM 30%
 * WCM + pages: 50% authenticated / 50% anonymous; DAM: anonymous only.
 */
export const HCL_RENDERING_MIX = {
  wcm: 0.4,
  pagesPortlets: 0.3,
  dam: 0.3,
  authWithinWcmPages: 0.5,
} as const;

/** Derived anon/auth % for the HCL combination mix */
export function hclAuthPercents(): { pctAnonymous: number; pctAuthenticated: number } {
  const portalShare =
    HCL_RENDERING_MIX.wcm + HCL_RENDERING_MIX.pagesPortlets; // 0.7
  const anon =
    portalShare * (1 - HCL_RENDERING_MIX.authWithinWcmPages) +
    HCL_RENDERING_MIX.dam * 1.0;
  const pctAnonymous = Math.round(anon * 100);
  return { pctAnonymous, pctAuthenticated: 100 - pctAnonymous };
}

/**
 * Recommended Core / webEngine pod resources for performance runs (guide table).
 * requests.memory == limits.memory; -Xms == -Xmx; heap leaves ~4Gi non-heap headroom in 8Gi pod.
 */
export const HCL_CORE_POD = {
  cpu: 5.6,
  podMemoryGi: 8,
  heapGi: 4,
  heapGiMax: 6,
  minHeapGi: 3.5,
  note: "HCL K8s sizing guide: 5.6 CPU, 8Gi pod mem (req=limit), heap 4Gi (Xms=Xmx)",
} as const;

/** Rough RPS/replica calibration anchor: scale between HCL small and large tiers */
export function hclSuggestedRpsPerReplica(concurrentUsers: number): number {
  // At 1k VU with ~cache+think time, Core often sits in tens of RPS/pod in lab docs;
  // keep conservative 80 default but nudge for large tier.
  if (concurrentUsers >= HCL_TIERS.large.concurrentUsers * 0.8) return 100;
  if (concurrentUsers <= HCL_TIERS.small.concurrentUsers * 1.2) return 70;
  return 80;
}
