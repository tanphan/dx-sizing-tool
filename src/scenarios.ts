import type { ComponentToggles, UsageInputs } from "./engine/types";
import { defaultUsageInputs } from "./engine/defaults";
import { hclAuthPercents, HCL_RENDERING_MIX, HCL_TIERS } from "./engine/hclGuidance";
import { defaultToggles } from "./catalogs";

export interface ScenarioPreset {
  id: string;
  label: string;
  description: string;
  patch: Partial<UsageInputs>;
  toggles?: Partial<ComponentToggles>;
}

const hclAuth = hclAuthPercents();

export const scenarioPresets: ScenarioPreset[] = [
  {
    id: "hcl-small",
    label: HCL_TIERS.small.label,
    description:
      "HCL CF239 K8s rendering mix: WCM 40% / pages 30% / DAM 30%, 1k concurrent VU",
    patch: {
      peakConcurrentUsers: HCL_TIERS.small.concurrentUsers,
      pctAnonymous: hclAuth.pctAnonymous,
      pctAuthenticated: hclAuth.pctAuthenticated,
      pctBrowse: Math.round((HCL_RENDERING_MIX.wcm + HCL_RENDERING_MIX.pagesPortlets) * 100),
      pctAuthor: 5,
      pctFormPost: 5,
      damAttachRate: HCL_RENDERING_MIX.dam,
      assetsPerPage: 2,
      contentItems: 12800,
      productionPlatform: true,
    },
    toggles: { dam: true, openLdap: true },
  },
  {
    id: "hcl-large",
    label: HCL_TIERS.large.label,
    description:
      "HCL CF239 large rendering anchor: 30k concurrent VU, same mix as small",
    patch: {
      peakConcurrentUsers: HCL_TIERS.large.concurrentUsers,
      pctAnonymous: hclAuth.pctAnonymous,
      pctAuthenticated: hclAuth.pctAuthenticated,
      pctBrowse: Math.round((HCL_RENDERING_MIX.wcm + HCL_RENDERING_MIX.pagesPortlets) * 100),
      pctAuthor: 5,
      pctFormPost: 5,
      damAttachRate: HCL_RENDERING_MIX.dam,
      assetsPerPage: 3,
      contentItems: 50000,
      productionPlatform: true,
      cacheHitRatio: 0.5,
    },
    toggles: { dam: true, openLdap: true },
  },
  {
    id: "anon-browse",
    label: "Anonymous browse",
    description: "Mostly anonymous portal page views",
    patch: {
      pctAnonymous: 90,
      pctAuthenticated: 10,
      pctBrowse: 90,
      pctAuthor: 2,
      pctFormPost: 8,
      searchAttachRate: 0.15,
      damAttachRate: 0.05,
      iqAttachRate: 0,
    },
  },
  {
    id: "login-wcm",
    label: "Login + WCM",
    description: "Authenticated browsing with forms",
    patch: {
      pctAnonymous: 20,
      pctAuthenticated: 80,
      pctBrowse: 70,
      pctAuthor: 5,
      pctFormPost: 25,
      searchAttachRate: 0.3,
      damAttachRate: 0.1,
    },
  },
  {
    id: "authoring",
    label: "Authoring",
    description: "Content Composer heavy",
    patch: {
      pctAuthor: 40,
      pctBrowse: 40,
      pctFormPost: 20,
      peakAuthoringUsers: 50,
      damAttachRate: 0.25,
    },
    toggles: { contentComposer: true, ringApi: true },
  },
  {
    id: "dam-heavy",
    label: "DAM heavy",
    description: "Asset-rich pages + uploads",
    patch: {
      damAttachRate: 0.5,
      assetsPerPage: 8,
      uploadsPerDay: 500,
      avgUploadMb: 5,
    },
    toggles: { dam: true },
  },
  {
    id: "search-heavy",
    label: "Search heavy",
    description: "High search attach rate",
    patch: {
      searchAttachRate: 0.7,
      searchesPerHit: 2,
    },
    toggles: { remoteSearch: true },
  },
  {
    id: "iq-chat",
    label: "IQ chat",
    description: "AI assistant attach path",
    patch: {
      iqAttachRate: 0.25,
      iqMsgsPerSession: 6,
      iqTokensIn: 1000,
      iqTokensOut: 500,
    },
    toggles: { iqIntegrator: true, mcpService: true },
  },
];

export function applyScenario(
  product: "dxcn" | "compose",
  base: UsageInputs,
  toggles: ComponentToggles,
  preset: ScenarioPreset,
): { inputs: UsageInputs; toggles: ComponentToggles } {
  const nextToggles = {
    ...defaultToggles(product),
    ...toggles,
    ...preset.toggles,
  };
  if (product === "compose") {
    nextToggles.remoteSearch = false;
    if (preset.id === "search-heavy") {
      nextToggles.searchMiddleware = true;
      nextToggles.openSearch = true;
      nextToggles.fileProcessor = true;
    }
  }
  return {
    inputs: { ...base, ...preset.patch },
    toggles: nextToggles,
  };
}

export { defaultUsageInputs };
