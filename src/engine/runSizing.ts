import type { CloudProvider } from "./cloudProviders";
import { cloudProviders } from "./cloudProviders";
import { HOURS_PER_MONTH } from "./defaults";
import { normalizeInputs } from "./demand";
import { buildHelmHints } from "./helm";
import { HCL_CORE_POD, HCL_SIZING_DOC } from "./hclGuidance";
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
  cloudProvider?: CloudProvider;
  replicaOverrides?: Partial<Record<string, number>>;
  enableCdn?: boolean;
}

export function runSizing(args: RunSizingArgs): SizingResult {
  const profileId = args.profileId ?? getDefaultProfileId(args.product);
  const capacity = loadProfile(profileId);
  const cloud = args.cloudProvider
    ? cloudProviders[args.cloudProvider]
    : undefined;

  const costs: UnitCosts = cloud
    ? {
        ...args.costs,
        vcpuPerHour: args.costs.vcpuPerHour * cloud.costMult.vcpu,
        memGiBPerHour: args.costs.memGiBPerHour * cloud.costMult.mem,
        storageGiBPerMonth:
          args.costs.storageGiBPerMonth * cloud.costMult.storage,
        egressGb: args.costs.egressGb * cloud.costMult.egress,
      }
    : args.costs;

  const inputs: UsageInputs = {
    ...args.inputs,
    cacheHitRatio: args.enableCdn === false ? 0 : args.inputs.cacheHitRatio,
  };

  const { nodes: topoNodes, edges: topoEdges, toggles } = selectTopology(
    args.product,
    args.toggles,
    inputs.productionPlatform,
  );
  const demand = normalizeInputs(inputs, toggles, args.product);
  const warnings: string[] = [];

  warnings.push(
    `Core/webEngine pod floors from HCL K8s sizing guide (CF239): ${HCL_CORE_POD.cpu} CPU, ${HCL_CORE_POD.podMemoryGi}Gi mem`,
  );

  if (inputs.cacheHitRatio <= 0) {
    warnings.push("CDN/cache hit ratio is 0 — origin sees full front-door RPS");
  }
  if (args.product === "compose" && args.toggles.remoteSearch) {
    warnings.push("Remote Search is not used on DX Compose; ignored");
  }
  if (args.product === "compose" && !toggles.dam && toggles.rwxStorage) {
    warnings.push("Compose webEngine does not require RWX — disabled without DAM");
  }
  if (args.product === "dxcn" && !toggles.rwxStorage) {
    warnings.push("DXCN Core requires RWX shared storage");
  }
  if (capacity.confidence === "default") {
    warnings.push(
      "Capacity profile uses defaults — calibrate with Locust; see HCL rendering guide for 1k/30k VU anchors",
    );
  }
  if (inputs.productionPlatform && (!toggles.waf || !toggles.cloudLb)) {
    warnings.push("Production platform expects origin WAF + Cloud LB");
  }

  const coreId = args.product === "dxcn" ? "core" : "webEngine";

  const sized = topoNodes
    .filter((n) => n.id !== "users" && n.id !== "cdn")
    .map((n) => {
      const profile = getProfile(capacity, n.id);
      const sku = cloud?.skus[n.id];
      const label = sku ? `${n.label} · ${sku}` : n.label;
      return sizeNode(
        n.id,
        label,
        n.plane,
        demand,
        profile,
        costs,
        inputs,
      );
    });

  const coreNode = sized.find((n) => n.id === coreId);
  const coreReplicas = coreNode?.replicas ?? 2;
  const sidecarIdx = sized.findIndex((n) => n.id === "loggingSidecar");
  if (sidecarIdx >= 0) {
    const profile = getProfile(capacity, "loggingSidecar");
    const n = topoNodes.find((t) => t.id === "loggingSidecar")!;
    sized[sidecarIdx] = sizeNode(
      "loggingSidecar",
      sized[sidecarIdx].label,
      n.plane,
      demand,
      profile,
      costs,
      inputs,
      coreReplicas,
    );
  }

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
          node.cpuCores * HOURS_PER_MONTH * costs.vcpuPerHour +
          node.memGi * HOURS_PER_MONTH * costs.memGiBPerHour +
          node.storageGi * costs.storageGiBPerMonth;
        if (node.licenseCostMonth > 0) {
          node.licenseCostMonth = override * costs.dxLicensePerNodeMonth;
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
      parentRps = demand.frontDoorRps;
    }
    const rps =
      e.ratioKey === "cdn_miss"
        ? demand.originRps + demand.iqRps
        : e.ratioKey === "auth"
          ? demand.authRps
          : e.ratioKey === "fixed" && e.source === "users"
            ? demand.frontDoorRps
            : parentRps * ratio;
    return { ...e, rps };
  });

  const platformMonth = sized
    .filter((n) => n.plane === "platform")
    .reduce((s, n) => s + n.infraCostMonth, 0);
  const hclRuntimeMonth = sized
    .filter((n) => n.plane === "hcl")
    .reduce((s, n) => s + n.infraCostMonth, 0);
  const infraMonth = sized.reduce((s, n) => s + n.infraCostMonth, 0);
  const licenseMonth = sized.reduce((s, n) => s + n.licenseCostMonth, 0);
  const tokens = demand.tokensPerMonth;
  const tokenMonth = (tokens / 1000) * costs.tokensPer1k;
  const llmInfraMonth =
    demand.iqEnabled && costs.selfHostLlmRamGiB > 0
      ? costs.selfHostLlmRamGiB * HOURS_PER_MONTH * costs.selfHostLlmRamGiBHour
      : 0;

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
    cloudProvider: cloud?.id,
    demand,
    nodes: sized,
    edges,
    sessions: {
      concurrentSessions: demand.concurrentSessions,
      sessionsPerDay: demand.sessionsPerDay,
      sessionFootprintMi,
      recommendedTimeoutMin: Math.min(
        60,
        Math.max(15, inputs.sessionDurationMin),
      ),
      stickySessions: true,
      jvmHeapGi: HCL_CORE_POD.heapGi,
      podMemoryGi: HCL_CORE_POD.podMemoryGi,
      podCpu: HCL_CORE_POD.cpu,
    },
    costs: {
      infraMonth,
      platformMonth,
      hclRuntimeMonth,
      licenseMonth,
      tokenMonth,
      llmInfraMonth,
      totalMonth: infraMonth + licenseMonth + tokenMonth + llmInfraMonth,
      vcpuHours: sized.reduce((s, n) => s + n.cpuCores * HOURS_PER_MONTH, 0),
      memGiBHours: sized.reduce((s, n) => s + n.memGi * HOURS_PER_MONTH, 0),
      storageGi: sized.reduce((s, n) => s + n.storageGi, 0),
      tokens,
    },
    warnings,
    helmHints: buildHelmHints(sized),
    hclDocUrl: HCL_SIZING_DOC,
  };
}
