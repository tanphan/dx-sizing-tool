import { HOURS_PER_MONTH } from "./defaults";
import type {
  CapacityProfile,
  ComponentId,
  ComponentProfile,
  Demand,
  SizedNode,
  TopologyEdge,
  UnitCosts,
  UsageInputs,
} from "./types";

function utilBand(util: number, fixed: boolean): SizedNode["utilBand"] {
  if (fixed || !Number.isFinite(util)) return "n/a";
  if (util < 0.7) return "green";
  if (util < 0.9) return "amber";
  return "red";
}

function offeredFor(id: ComponentId, demand: Demand): number {
  switch (id) {
    case "users":
    case "cdn":
      return demand.frontDoorRps;
    case "haproxy":
      // Auth to external IdP is browser redirect + Core/webEngine back-channel — not HAProxy→IdP.
      return demand.portalRps + demand.iqRps;
    case "core":
    case "webEngine":
      return demand.portalRps;
    case "externalDb":
      return demand.dbRps;
    case "remoteSearch":
    case "searchMiddleware":
    case "openSearch":
      return demand.searchRps;
    case "fileProcessor":
      return demand.searchRps * 0.1;
    case "dam":
      return demand.damRps;
    case "imageProcessor":
      return demand.imageRps;
    case "persistencePool":
    case "persistenceNode":
    case "persistenceMetrics":
      return demand.persistRps;
    case "contentComposer":
      return demand.authorRps;
    case "ringApi":
      return demand.ringRps;
    case "openLdap":
    case "externalIdp":
      return demand.authRps;
    case "iqIntegrator":
      return demand.iqRps;
    case "mcpService":
      return demand.iqRps * 0.6;
    case "damPluginGoogleVision":
    case "damPluginKaltura":
      return demand.damRps * 0.05;
    case "peopleService":
      return demand.portalRps * 0.05;
    case "loggingSidecar":
    case "runtimeController":
    case "prereqsChecker":
    case "licenseManager":
      return 0;
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

export function sizeNode(
  id: ComponentId,
  label: string,
  demand: Demand,
  profile: ComponentProfile | undefined,
  costs: UnitCosts,
  inputs: UsageInputs,
  sidecarOfReplicas?: number,
): SizedNode {
  if (!profile) {
    return {
      id,
      label,
      offeredRps: offeredFor(id, demand),
      capacityRps: 0,
      util: 0,
      utilBand: "n/a",
      replicas: 0,
      cpuCores: 0,
      memGi: 0,
      storageGi: 0,
      infraCostMonth: 0,
      licenseCostMonth: 0,
      notes: ["No capacity profile for this node"],
    };
  }

  const offered = offeredFor(id, demand);
  const notes: string[] = [];
  let replicas: number;

  if (profile.fixed) {
    replicas =
      id === "prereqsChecker"
        ? 0
        : id === "loggingSidecar"
          ? Math.max(1, sidecarOfReplicas ?? 1)
          : Math.max(profile.minReplicas, 1);
    if (id === "prereqsChecker") {
      notes.push("Job-only; ignored in steady-state cost");
    }
  } else if (!profile.scalable) {
    replicas = Math.max(profile.minReplicas, 1);
  } else {
    const loadRep = Math.ceil(offered / Math.max(1, profile.rpsPerReplica));
    const haRep = Math.max(profile.haMinReplicas, inputs.azCount);
    replicas = Math.max(loadRep, haRep, profile.minReplicas);
    if (replicas === haRep && loadRep < haRep) {
      notes.push("HA / AZ floor applied");
    }
  }

  const perRepRps = offered / Math.max(1, replicas);
  const cpuCores =
    replicas *
    (profile.cpuBase + profile.cpuPerRps * perRepRps);

  let memGi =
    replicas *
    (profile.memBaseGi +
      (profile.memPerRpsMi * perRepRps) / 1024 +
      (profile.memPerSessionMi * demand.concurrentSessions) /
        1024 /
        Math.max(1, replicas));

  if (id === "core" || id === "webEngine") {
    const sessionMem =
      (demand.concurrentSessions * inputs.sessionBytesKb) / 1024 / 1024;
    memGi = Math.max(memGi, replicas * profile.memBaseGi + sessionMem * 1.3);
    notes.push(
      `Session memory ~${(sessionMem * 1.3).toFixed(1)} Gi (incl 30% safety)`,
    );
  }

  let storageGi = replicas * profile.storageBaseGi;
  if (id === "dam") storageGi += demand.damStorageGiMonth;
  if (id === "openSearch" || id === "remoteSearch") {
    storageGi += demand.searchIndexGi;
  }
  if (id === "externalDb") {
    storageGi += Math.max(50, demand.searchIndexGi * 0.5);
  }

  const capacityRps = replicas * profile.rpsPerReplica;
  const util =
    profile.fixed || capacityRps <= 0 ? 0 : offered / capacityRps;

  const infraCostMonth =
    cpuCores * HOURS_PER_MONTH * costs.vcpuPerHour +
    memGi * HOURS_PER_MONTH * costs.memGiBPerHour +
    storageGi * costs.storageGiBPerMonth;

  const licenseCostMonth =
    profile.licenseNode && replicas > 0
      ? replicas * costs.dxLicensePerNodeMonth
      : 0;

  if (util >= 0.9) notes.push("Saturated at peak — add replicas or reduce RPS");
  else if (util >= 0.7) notes.push("High utilization — limited headroom");

  return {
    id,
    label,
    offeredRps: offered,
    capacityRps,
    util,
    utilBand: utilBand(util, profile.fixed || offered === 0),
    replicas,
    cpuCores,
    memGi,
    storageGi,
    infraCostMonth,
    licenseCostMonth,
    notes,
  };
}

export function edgeRatio(
  key: TopologyEdge["ratioKey"],
  demand: Demand,
  cacheHitRatio: number,
): number {
  const miss = Math.max(0, Math.min(1, 1 - cacheHitRatio));
  switch (key) {
    case "fixed":
      return 1;
    case "cdn_miss":
      return miss;
    case "portal":
      return demand.frontDoorRps > 0
        ? demand.portalRps / (demand.portalRps + demand.iqRps + demand.authRps || 1)
        : 1;
    case "db":
      return demand.portalRps > 0 ? demand.dbRps / demand.portalRps : 0;
    case "search":
      return demand.portalRps > 0 ? demand.searchRps / demand.portalRps : 0;
    case "dam":
      return demand.portalRps > 0 ? demand.damRps / demand.portalRps : 0;
    case "image":
      return demand.damRps > 0 ? demand.imageRps / demand.damRps : 0;
    case "persist":
      return 1;
    case "auth":
      // Absolute-ish: parentRps × ratio ≈ authRps when parent is portal (Core/webEngine).
      return demand.portalRps > 0 ? demand.authRps / demand.portalRps : 0;
    case "iq":
      return demand.frontDoorRps > 0
        ? demand.iqRps / Math.max(demand.portalRps + demand.iqRps, 1)
        : 0;
    case "author":
      return demand.portalRps > 0 ? demand.authorRps / demand.portalRps : 0;
    case "ring":
      return demand.portalRps > 0 ? demand.ringRps / demand.portalRps : 0;
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

export function getProfile(
  capacity: CapacityProfile,
  id: ComponentId,
): ComponentProfile | undefined {
  return capacity.components[id];
}
