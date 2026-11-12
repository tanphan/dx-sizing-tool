import { describe, expect, it } from "vitest";
import { defaultToggles } from "../catalogs";
import { calibrateFromLocust } from "./calibrate";
import { defaultUnitCosts, defaultUsageInputs } from "./defaults";
import { normalizeInputs } from "./demand";
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
    const demand = normalizeInputs(inputs, defaultToggles("dxcn"));
    // U*req/(T*60) = 5000*25/1200 ≈ 104.17; miss 0.6 → portal ≈ 62.5
    expect(demand.frontDoorRps).toBeCloseTo(104.166, 1);
    expect(demand.portalRps).toBeCloseTo(62.5, 1);
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
    );
    expect(demand.iqEnabled).toBe(true);
    expect(demand.tokensPerMonth).toBe(1000 * 30 * 0.2 * 4 * 150);
  });
});

describe("runSizing", () => {
  it("applies HA floor for Core even at tiny RPS", () => {
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
  });

  it("example 5k peak, 40% search, 10% DAM produces plausible BOM", () => {
    const result = runSizing({
      product: "dxcn",
      inputs: {
        ...defaultUsageInputs,
        peakConcurrentUsers: 5000,
        searchAttachRate: 0.4,
        damAttachRate: 0.1,
        growthCagr: 0,
        cacheHitRatio: 0.4,
      },
      toggles: {
        ...defaultToggles("dxcn"),
        remoteSearch: true,
        dam: true,
      },
      costs: defaultUnitCosts,
    });
    const core = result.nodes.find((n) => n.id === "core")!;
    const dam = result.nodes.find((n) => n.id === "dam")!;
    const rs = result.nodes.find((n) => n.id === "remoteSearch")!;
    expect(core.replicas).toBeGreaterThanOrEqual(2);
    expect(dam.replicas).toBeGreaterThanOrEqual(1);
    expect(rs.replicas).toBeGreaterThanOrEqual(1);
    expect(result.costs.totalMonth).toBeGreaterThan(0);
    expect(result.helmHints.scaling.core).toBe(core.replicas);
  });

  it("load 3x turns a hot path red or amber", () => {
    const base = runSizing({
      product: "dxcn",
      inputs: { ...defaultUsageInputs, growthCagr: 0, loadMultiplier: 1 },
      toggles: defaultToggles("dxcn"),
      costs: defaultUnitCosts,
    });
    const stressed = runSizing({
      product: "dxcn",
      inputs: { ...defaultUsageInputs, growthCagr: 0, loadMultiplier: 3 },
      toggles: defaultToggles("dxcn"),
      costs: defaultUnitCosts,
    });
    const coreBase = base.nodes.find((n) => n.id === "core")!;
    const coreHot = stressed.nodes.find((n) => n.id === "core")!;
    expect(coreHot.util).toBeGreaterThan(coreBase.util);
    expect(["amber", "red", "green"]).toContain(coreHot.utilBand);
  });

  it("auth edges are Core/users→IdP and Core→LDAP, not HAProxy→IdP", () => {
    const { edges } = selectTopology("dxcn", {
      ...defaultToggles("dxcn"),
      externalIdp: true,
      openLdap: true,
    });
    expect(edges.some((e) => e.source === "haproxy" && e.target === "externalIdp")).toBe(false);
    expect(edges.some((e) => e.source === "haproxy" && e.target === "openLdap")).toBe(false);
    expect(edges.some((e) => e.source === "users" && e.target === "externalIdp")).toBe(true);
    expect(edges.some((e) => e.source === "core" && e.target === "externalIdp")).toBe(true);
    expect(edges.some((e) => e.source === "core" && e.target === "openLdap")).toBe(true);
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

  it("estimator and topology share same node set", () => {
    const toggles = { ...defaultToggles("dxcn"), dam: true };
    const { nodes } = selectTopology("dxcn", toggles);
    const result = runSizing({
      product: "dxcn",
      inputs: defaultUsageInputs,
      toggles,
      costs: defaultUnitCosts,
    });
    const topoIds = new Set(
      nodes.filter((n) => n.id !== "users" && n.id !== "cdn").map((n) => n.id),
    );
    const bomIds = new Set(result.nodes.map((n) => n.id));
    expect(bomIds).toEqual(topoIds);
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
    expect(live.find((r) => r.componentId === "core")?.cpuCoresObserved).toBe(1.5);
    const cmp = compareEstimateVsLive(result.nodes, live);
    expect(cmp.find((r) => r.componentId === "core")?.status).not.toBe("missing");
  });
});
