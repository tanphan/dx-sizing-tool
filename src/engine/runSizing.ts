import { cloudProviders, type CloudProvider } from "./cloudProviders";
import { defaultUnitCosts, defaultUsageInputs, HOURS_PER_MONTH } from "./defaults";
import { normalizeInputs } from "./demand";
import { buildHelmHints } from "./helm";
import { HCL_CORE_POD, HCL_SIZING_DOC } from "./hclGuidance";
import { availabilityPolicy } from "./policy";
import {
  discountFactor,
  egressCostMonth,
  resolveUnitCosts,
  type PricingSelection,
} from "./pricing";
import { getDefaultProfileId, loadProfile } from "./profiles";
import { edgeRps, getProfile, sizeNode } from "./sizeNode";
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
  /** Region / compute basis for snapshot list prices, or custom = use `costs` as entered */
  pricing?: PricingSelection;
  /** Manual replica counts per component id (Simulator add / remove). Either direction. */
  replicaOverrides?: Partial<Record<string, number>>;
  enableCdn?: boolean;
}

export function runSizing(args: RunSizingArgs): SizingResult {
  const profileId = args.profileId ?? getDefaultProfileId(args.product);
  const capacity = loadProfile(profileId);
  const cloud = args.cloudProvider
    ? cloudProviders[args.cloudProvider]
    : undefined;

  // Unit prices: snapshot list prices for the provider / region, unless the user entered custom
  // rates. Older saved state may lack newer fields, so merge defaults first.
  const { costs: listCosts, source: priceSource } = resolveUnitCosts(
    { ...defaultUnitCosts, ...args.costs },
    args.cloudProvider,
    args.pricing,
  );
  // Discounts apply to cloud spend (infra + egress), not to license, AI tokens or self-host LLM.
  const factor = discountFactor(listCosts);
  const costs: UnitCosts = {
    ...listCosts,
    vcpuPerHour: listCosts.vcpuPerHour * factor,
    memGiBPerHour: listCosts.memGiBPerHour * factor,
    storageGiBPerMonth: listCosts.storageGiBPerMonth * factor,
  };

  // Fill fields missing from older saved state (localStorage) with defaults.
  const merged: UsageInputs = { ...defaultUsageInputs, ...args.inputs };
  if (args.inputs.damCacheHitRatio == null) merged.damCacheHitRatio = merged.cacheHitRatio;
  const inputs: UsageInputs = {
    ...merged,
    cacheHitRatio: args.enableCdn === false ? 0 : merged.cacheHitRatio,
    damCacheHitRatio: args.enableCdn === false ? 0 : merged.damCacheHitRatio,
  };

  const { nodes: topoNodes, edges: topoEdges, toggles } = selectTopology(
    args.product,
    args.toggles,
    inputs.productionPlatform,
  );
  const demand = normalizeInputs(inputs, toggles, args.product);
  const warnings: string[] = [];

  // Pacing sanity: think time vs session math describe the same user differently.
  if (inputs.thinkTimeSec > 0 && inputs.peakRpsOverride <= 0) {
    const sessionPacing =
      (Math.max(1, inputs.sessionDurationMin) * 60) / Math.max(1, inputs.reqPerSession);
    const ratio = sessionPacing / inputs.thinkTimeSec;
    if (ratio > 2 || ratio < 0.5) {
      warnings.push(
        `RPS paced by think time (${inputs.thinkTimeSec}s/request); session inputs imply ${sessionPacing.toFixed(0)}s/request — check which describes your users`,
      );
    }
  }

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
  if (inputs.productionPlatform && (!toggles.waf || !toggles.cloudLb)) {
    warnings.push("Production platform expects origin WAF + Cloud LB");
  }
  const avail = availabilityPolicy(inputs.targetAvailability);
  if (!avail.production) {
    warnings.push(
      `Availability target ${inputs.targetAvailability}: single replicas allowed — not a production sizing`,
    );
  } else if (avail.minReplicas >= 3 && inputs.azCount < 3) {
    warnings.push(
      `Availability target ${inputs.targetAvailability} usually needs 3+ AZs; AZ count is ${inputs.azCount}`,
    );
  }
  if (demand.peakUsersSource === "busyHour") {
    warnings.push(
      `Peak users derived from DAU × busy-hour factor ${inputs.busyHourFactor}: ${Math.round(demand.concurrentSessions).toLocaleString()} concurrent`,
    );
  }

  const coreId = args.product === "dxcn" ? "core" : "webEngine";
  const overrides = args.replicaOverrides ?? {};

  // Size the portal runtime first: the logging sidecar runs one per replica.
  const ordered = topoNodes
    .filter((n) => n.id !== "users" && n.id !== "cdn")
    .sort((a, b) => Number(b.id === coreId) - Number(a.id === coreId));
  const byId = new Map<string, SizingResult["nodes"][number]>();
  for (const n of ordered) {
    const sku = cloud?.skus[n.id];
    byId.set(
      n.id,
      sizeNode(n.id, sku ? `${n.label} · ${sku}` : n.label, n.plane, demand,
        getProfile(capacity, n.id), costs, inputs, {
          confidence: capacity.confidence,
          forcedReplicas: overrides[n.id],
          sidecarOfReplicas: byId.get(coreId)?.replicas,
        }),
    );
  }
  // Keep catalog order for display.
  const sized = topoNodes
    .filter((n) => byId.has(n.id))
    .map((n) => byId.get(n.id)!);

  const belowFloor = sized.filter((n) => n.scalable && n.replicas < n.minSafeReplicas);
  if (belowFloor.length) {
    warnings.push(
      `Below availability floor: ${belowFloor.map((n) => `${n.label} (${n.replicas} < ${n.minSafeReplicas})`).join(", ")}`,
    );
  }

  const offeredById = new Map(sized.map((n) => [n.id, n.offeredRps]));
  const edges = topoEdges.map((e) => ({
    ...e,
    rps: edgeRps(e, demand, offeredById),
  }));

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
  // Origin egress (0 unless response sizes are entered); tiered when list prices carry tiers
  const egressListMonth = egressCostMonth(
    demand.egressGbMonth,
    listCosts.egressGb,
    listCosts.egressTiers,
  );
  const egressMonth = egressListMonth * factor;
  const cloudListMonth = infraMonth / factor + egressListMonth;
  const cloudDiscountMonth = cloudListMonth - (infraMonth + egressMonth);

  if (priceSource.kind === "placeholder") warnings.push(priceSource.summary);

  const red = sized.filter((n) => n.utilBand === "red");
  if (red.length) {
    warnings.push(
      `Bottleneck(s): ${red.map((n) => n.label).join(", ")} at >90% util`,
    );
  }

  const sessionFootprintMi =
    (demand.concurrentSessions * demand.sessionBytesKbEff) / 1024;

  return {
    product: args.product,
    profileId: capacity.id,
    confidence: capacity.confidence,
    cloudProvider: cloud?.id,
    priceSource,
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
      egressMonth,
      egressGbMonth: demand.egressGbMonth,
      cloudListMonth,
      cloudDiscountMonth,
      discountFactor: factor,
      totalMonth: infraMonth + licenseMonth + tokenMonth + llmInfraMonth + egressMonth,
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
