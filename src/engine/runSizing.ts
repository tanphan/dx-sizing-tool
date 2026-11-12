import { HOURS_PER_MONTH } from "./defaults";
import { normalizeInputs } from "./demand";
import { buildHelmHints } from "./helm";
import { getDefaultProfileId, loadProfile } from "./profiles";
import { edgeRatio, getProfile, sizeNode } from "./sizeNode";
import { selectTopology } from "./topology";
import type {
  ComponentToggles,
  Product,
  SizingResult,
  UnitCosts,
  UsageInputs,
} from "./types";

export interface RunSizingArgs {
  product: Product;
  inputs: UsageInputs;
  toggles: ComponentToggles;
  costs: UnitCosts;
  profileId?: string;
  /** Extra replicas forced on a node (simulator "add replica") */
  replicaOverrides?: Partial<Record<string, number>>;
  /** Treat CDN as enabled → keep cacheHitRatio; if false force 0 */
  enableCdn?: boolean;
}

export function runSizing(args: RunSizingArgs): SizingResult {
  const profileId = args.profileId ?? getDefaultProfileId(args.product);
  const capacity = loadProfile(profileId);
  const inputs: UsageInputs = {
    ...args.inputs,
    cacheHitRatio: args.enableCdn === false ? 0 : args.inputs.cacheHitRatio,
  };

  const { nodes: topoNodes, edges: topoEdges, toggles } = selectTopology(
    args.product,
    args.toggles,
  );
  const demand = normalizeInputs(inputs, toggles);
  const warnings: string[] = [];

  if (inputs.cacheHitRatio <= 0) {
    warnings.push("CDN/cache hit ratio is 0 — portal sees full front-door RPS");
  }
  if (args.product === "compose" && args.toggles.remoteSearch) {
    warnings.push("Remote Search is not used on DX Compose; ignored");
  }
  if (demand.portalRps > 0 && capacity.confidence === "default") {
    warnings.push(
      "Capacity profile uses default constants — calibrate with Locust for lab accuracy",
    );
  }

  const coreId = args.product === "dxcn" ? "core" : "webEngine";
  let coreReplicas = 0;

  const sized = topoNodes
    .filter((n) => n.id !== "users" && n.id !== "cdn")
    .map((n) => {
      const profile = getProfile(capacity, n.id);
      const node = sizeNode(
        n.id,
        n.label,
        demand,
        profile,
        args.costs,
        inputs,
        n.id === "loggingSidecar" ? undefined : undefined,
      );
      return node;
    });

  // Second pass: logging sidecar tracks core/webEngine replicas
  const coreNode = sized.find((n) => n.id === coreId);
  coreReplicas = coreNode?.replicas ?? 2;
  const sidecarIdx = sized.findIndex((n) => n.id === "loggingSidecar");
  if (sidecarIdx >= 0) {
    const profile = getProfile(capacity, "loggingSidecar");
    sized[sidecarIdx] = sizeNode(
      "loggingSidecar",
      sized[sidecarIdx].label,
      demand,
      profile,
      args.costs,
      inputs,
      coreReplicas,
    );
  }

  // Apply simulator replica overrides
  if (args.replicaOverrides) {
    for (const node of sized) {
      const override = args.replicaOverrides[node.id];
      if (override != null && override > node.replicas) {
        const scale = override / Math.max(1, node.replicas);
        node.replicas = override;
        node.cpuCores *= scale;
        node.memGi *= scale;
        node.capacityRps =
          (getProfile(capacity, node.id)?.rpsPerReplica ?? 0) * override;
        node.util =
          node.capacityRps > 0 ? node.offeredRps / node.capacityRps : 0;
        node.utilBand =
          node.util < 0.7 ? "green" : node.util < 0.9 ? "amber" : "red";
        node.notes = [...node.notes, `Manual replica override → ${override}`];
        node.infraCostMonth =
          node.cpuCores * HOURS_PER_MONTH * args.costs.vcpuPerHour +
          node.memGi * HOURS_PER_MONTH * args.costs.memGiBPerHour +
          node.storageGi * args.costs.storageGiBPerMonth;
        if (node.licenseCostMonth > 0) {
          node.licenseCostMonth =
            override * args.costs.dxLicensePerNodeMonth;
        }
      }
    }
  }

  const edges = topoEdges.map((e) => {
    const ratio = edgeRatio(e.ratioKey, demand, inputs.cacheHitRatio);
    let parentRps = demand.frontDoorRps;
    const parent = sized.find((n) => n.id === e.source);
    if (parent) parentRps = parent.offeredRps;
    else if (e.source === "users" || e.source === "cdn") {
      parentRps =
        e.source === "users" ? demand.frontDoorRps : demand.frontDoorRps;
    }
    const rps =
      e.ratioKey === "cdn_miss"
        ? demand.portalRps + demand.iqRps
        : e.ratioKey === "auth"
          ? // Browser redirect and Core/webEngine back-channel both scale with authRps
            demand.authRps
          : e.ratioKey === "fixed" && e.source === "users"
            ? demand.frontDoorRps
            : parentRps * ratio;
    return { ...e, rps };
  });

  const infraMonth = sized.reduce((s, n) => s + n.infraCostMonth, 0);
  const licenseMonth = sized.reduce((s, n) => s + n.licenseCostMonth, 0);
  const tokens = demand.tokensPerMonth;
  const tokenMonth = (tokens / 1000) * args.costs.tokensPer1k;
  const llmInfraMonth =
    demand.iqEnabled && args.costs.selfHostLlmRamGiB > 0
      ? args.costs.selfHostLlmRamGiB *
        HOURS_PER_MONTH *
        args.costs.selfHostLlmRamGiBHour
      : 0;

  const vcpuHours = sized.reduce(
    (s, n) => s + n.cpuCores * HOURS_PER_MONTH,
    0,
  );
  const memGiBHours = sized.reduce(
    (s, n) => s + n.memGi * HOURS_PER_MONTH,
    0,
  );
  const storageGi = sized.reduce((s, n) => s + n.storageGi, 0);

  const red = sized.filter((n) => n.utilBand === "red");
  if (red.length) {
    warnings.push(
      `Bottleneck(s): ${red.map((n) => n.label).join(", ")} at >90% util`,
    );
  }

  const sessionFootprintMi =
    (demand.concurrentSessions * inputs.sessionBytesKb) / 1024;

  return {
    product: args.product,
    profileId: capacity.id,
    confidence: capacity.confidence,
    demand,
    nodes: sized,
    edges,
    sessions: {
      concurrentSessions: demand.concurrentSessions,
      sessionsPerDay: demand.sessionsPerDay,
      sessionFootprintMi,
      recommendedTimeoutMin: Math.min(60, Math.max(15, inputs.sessionDurationMin)),
      stickySessions: true,
    },
    costs: {
      infraMonth,
      licenseMonth,
      tokenMonth,
      llmInfraMonth,
      totalMonth: infraMonth + licenseMonth + tokenMonth + llmInfraMonth,
      vcpuHours,
      memGiBHours,
      storageGi,
      tokens,
    },
    warnings,
    helmHints: buildHelmHints(sized),
  };
}
