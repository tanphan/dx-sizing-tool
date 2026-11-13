import { describe, expect, it } from "vitest";
import { defaultToggles, resolveToggles } from "../catalogs";
import { calibrateFromLocust } from "./calibrate";
import { defaultUnitCosts, defaultUsageInputs } from "./defaults";
import { normalizeInputs } from "./demand";
import { HCL_CORE_POD, HCL_TIERS, hclAuthPercents } from "./hclGuidance";
import { buildHelmHints } from "./helm";
import { compareEstimateVsLive, parseKubectlTop } from "./liveCompare";
import { loadProfile } from "./profiles";
import { runSizing } from "./runSizing";
import { selectTopology } from "./topology";

describe("normalizeInputs", () => {
  it("derives portal RPS from peak users and session math", () => {
    const inputs = {
      ...defaultUsageInputs,
      peakConcurrentUsers: 5000,
      reqPerSession: 25,
      sessionDurationMin: 20,
      cacheHitRatio: 0.4,
      loadMultiplier: 1,
      growthCagr: 0,
      peakRpsOverride: 0,
    };
    const demand = normalizeInputs(inputs, defaultToggles("dxcn"), "dxcn");
    expect(demand.frontDoorRps).toBeCloseTo(104.166, 1);
    expect(demand.portalRps).toBeCloseTo(62.5, 1);
    expect(demand.originRps).toBeCloseTo(62.5, 1);
    expect(demand.concurrentSessions).toBe(5000);
  });

  it("fans search/DAM from attach rates", () => {
    const demand = normalizeInputs(
      {
        ...defaultUsageInputs,
        growthCagr: 0,
        cacheHitRatio: 0,
        searchAttachRate: 0.4,
        searchesPerHit: 1.5,
        damAttachRate: 0.1,
        assetsPerPage: 3,
        peakRpsOverride: 100,
      },
      { ...defaultToggles("dxcn"), dam: true, remoteSearch: true },
      "dxcn",
    );
    expect(demand.portalRps).toBe(100);
    expect(demand.searchRps).toBeCloseTo(60, 5);
    expect(demand.damRps).toBeCloseTo(30, 5);
    expect(demand.imageRps).toBeCloseTo(6, 5);
  });

  it("computes IQ tokens when enabled", () => {
    const demand = normalizeInputs(
      {
        ...defaultUsageInputs,
        growthCagr: 0,
        dau: 1000,
        iqAttachRate: 0.2,
        iqMsgsPerSession: 4,
        iqTokensIn: 100,
        iqTokensOut: 50,
      },
      { ...defaultToggles("compose"), iqIntegrator: true },
      "compose",
    );
    expect(demand.iqEnabled).toBe(true);
    expect(demand.tokensPerMonth).toBe(1000 * 30 * 0.2 * 4 * 150);
  });
});

describe("RWX rules", () => {
  it("DXCN always forces RWX for Core", () => {
    const t = resolveToggles("dxcn", { ...defaultToggles("dxcn"), dam: false });
    expect(t.rwxStorage).toBe(true);
    const { nodes } = selectTopology("dxcn", t);
    expect(nodes.some((n) => n.id === "rwxStorage")).toBe(true);
    expect(nodes.some((n) => n.id === "core")).toBe(true);
  });

  it("Compose webEngine has no RWX without DAM", () => {
    const t = resolveToggles("compose", {
      ...defaultToggles("compose"),
      dam: false,
      rwxStorage: true,
    });
    expect(t.rwxStorage).toBe(false);
    const { nodes, edges } = selectTopology("compose", t);
    expect(nodes.some((n) => n.id === "rwxStorage")).toBe(false);
    expect(edges.some((e) => e.target === "rwxStorage")).toBe(false);
  });

  it("Compose enables RWX when DAM is on", () => {
    const t = resolveToggles("compose", {
      ...defaultToggles("compose"),
      dam: true,
    });
    expect(t.rwxStorage).toBe(true);
    const { edges } = selectTopology("compose", t);
    expect(edges.some((e) => e.id === "dam-rwx")).toBe(true);
    expect(edges.some((e) => e.id === "core-rwx")).toBe(false);
  });
});

describe("runSizing", () => {
  it("applies HA floor and HCL Core pod floors", () => {
    const result = runSizing({
      product: "dxcn",
      inputs: {
        ...defaultUsageInputs,
        peakConcurrentUsers: 10,
        peakRpsOverride: 1,
        growthCagr: 0,
        azCount: 2,
      },
      toggles: defaultToggles("dxcn"),
      costs: defaultUnitCosts,
    });
    const core = result.nodes.find((n) => n.id === "core");
    expect(core?.replicas).toBeGreaterThanOrEqual(2);
    expect(core?.cpuCores).toBeGreaterThanOrEqual(2 * HCL_CORE_POD.cpu);
    expect(core?.memGi).toBeGreaterThanOrEqual(2 * HCL_CORE_POD.podMemoryGi);
    expect(core?.plane).toBe("hcl");
  });

  it("production platform uses origin WAF path", () => {
    const result = runSizing({
      product: "compose",
      inputs: { ...defaultUsageInputs, productionPlatform: true, growthCagr: 0 },
      toggles: defaultToggles("compose"),
      costs: defaultUnitCosts,
      cloudProvider: "aws",
    });
    expect(result.nodes.some((n) => n.id === "waf")).toBe(true);
    expect(result.nodes.some((n) => n.id === "cloudLb")).toBe(true);
    expect(result.nodes.some((n) => n.id === "dxDbSecondary")).toBe(true);
    expect(result.edges.some((e) => e.id === "cdn-waf")).toBe(true);
    expect(result.edges.some((e) => e.id === "cdn-hap")).toBe(false);
    expect(result.nodes.find((n) => n.id === "waf")?.plane).toBe("platform");
  });

  it("HCL small tier auth mix is ~65% anonymous", () => {
    const { pctAnonymous } = hclAuthPercents();
    expect(pctAnonymous).toBe(65);
    expect(HCL_TIERS.small.concurrentUsers).toBe(1000);
    expect(HCL_TIERS.large.concurrentUsers).toBe(30000);
  });

  it("Compose has webEngine not core; no remoteSearch node", () => {
    const result = runSizing({
      product: "compose",
      inputs: defaultUsageInputs,
      toggles: { ...defaultToggles("compose"), remoteSearch: true },
      costs: defaultUnitCosts,
    });
    expect(result.nodes.some((n) => n.id === "webEngine")).toBe(true);
    expect(result.nodes.some((n) => n.id === "core")).toBe(false);
    expect(result.nodes.some((n) => n.id === "remoteSearch")).toBe(false);
  });

  it("auth edges are Core/users→IdP and Core→LDAP, not HAProxy→IdP", () => {
    const { edges } = selectTopology("dxcn", {
      ...defaultToggles("dxcn"),
      externalIdp: true,
      openLdap: true,
    });
    expect(
      edges.some((e) => e.source === "haproxy" && e.target === "externalIdp"),
    ).toBe(false);
    expect(edges.some((e) => e.source === "users" && e.target === "externalIdp")).toBe(
      true,
    );
    expect(edges.some((e) => e.source === "core" && e.target === "externalIdp")).toBe(
      true,
    );
  });
});

describe("calibrate + helm + live", () => {
  it("calibrates rpsPerReplica from Locust", () => {
    const base = loadProfile("dxcn-cf238");
    const { profile, notes } = calibrateFromLocust(base, [
      { componentId: "core", rps: 140, cpuCores: 6, replicas: 2, util: 0.7 },
    ]);
    expect(profile.confidence).toBe("lab-calibrated");
    expect(profile.components.core.rpsPerReplica).toBe(100);
    expect(notes.length).toBe(1);
  });

  it("builds helm hints", () => {
    const result = runSizing({
      product: "dxcn",
      inputs: defaultUsageInputs,
      toggles: defaultToggles("dxcn"),
      costs: defaultUnitCosts,
    });
    const hints = buildHelmHints(result.nodes);
    expect(hints.scaling.core).toBeGreaterThanOrEqual(2);
    expect(hints.resources.core.limits.memory).toMatch(/Gi|Mi/);
  });

  it("parses kubectl top and compares", () => {
    const result = runSizing({
      product: "dxcn",
      inputs: defaultUsageInputs,
      toggles: defaultToggles("dxcn"),
      costs: defaultUnitCosts,
    });
    const live = parseKubectlTop(
      `NAME              CPU(cores)   MEMORY(bytes)
dx-core-0         1500m        4096Mi
haproxy-0         200m         256Mi`,
      { "dx-core": "core", haproxy: "haproxy" },
    );
    expect(live.find((r) => r.componentId === "core")?.cpuCoresObserved).toBe(
      1.5,
    );
    const cmp = compareEstimateVsLive(result.nodes, live);
    expect(cmp.find((r) => r.componentId === "core")?.status).not.toBe(
      "missing",
    );
  });
});
