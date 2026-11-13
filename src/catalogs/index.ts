import type { ComponentToggles, Product, ProductCatalog } from "../engine/types";
import { composeCatalog } from "./compose";
import { dxcnCatalog } from "./dxcn";
import { productionPlatformDefaults } from "./platform";

export function getCatalog(product: Product): ProductCatalog {
  return product === "dxcn" ? dxcnCatalog : composeCatalog;
}

/**
 * Force dependent components.
 *
 * RWX rules:
 * - DXCN Core always needs RWX (shared FS)
 * - WebEngine / Compose portal does NOT need RWX
 * - DAM (either product) needs RWX when DAM is on
 */
export function resolveToggles(
  product: Product,
  toggles: ComponentToggles,
  productionPlatform = false,
): ComponentToggles {
  const t: ComponentToggles = { ...toggles };

  if (productionPlatform) {
    Object.assign(t, productionPlatformDefaults);
  }

  if (product === "compose") {
    t.remoteSearch = false;
  }

  if (t.dam) {
    t.imageProcessor = true;
    t.persistenceNode = true;
    t.persistencePool = true;
    t.persistenceMetrics = true;
    t.ringApi = true;
    t.rwxStorage = true; // DAM needs RWX
    if (productionPlatform) t.objectStorage = true;
  }

  // DXCN Core requires RWX even without DAM
  if (product === "dxcn") {
    t.rwxStorage = true;
  }

  // Compose without DAM: never RWX for webEngine
  if (product === "compose" && !t.dam) {
    t.rwxStorage = false;
  }

  if (t.contentComposer) {
    t.ringApi = true;
  }
  if (t.searchMiddleware || t.openSearch || t.fileProcessor) {
    t.searchMiddleware = true;
    t.openSearch = true;
    t.fileProcessor = true;
  }
  if (t.iqIntegrator) {
    t.mcpService = true;
  }

  return t;
}

export function defaultToggles(product: Product): ComponentToggles {
  const platformOff = {
    dnsGslb: false,
    waf: false,
    cloudLb: false,
    dxDbSecondary: false,
    rwxStorage: product === "dxcn", // Core needs RWX
    objectStorage: false,
    redis: false,
    secretsKms: false,
    observability: false,
    backupDr: false,
    containerRegistry: false,
    egressNat: false,
  };

  if (product === "dxcn") {
    return {
      openLdap: false,
      externalIdp: true,
      remoteSearch: true,
      contentComposer: false,
      ringApi: false,
      dam: false,
      imageProcessor: false,
      persistenceNode: false,
      persistencePool: false,
      persistenceMetrics: false,
      damPluginGoogleVision: false,
      damPluginKaltura: false,
      searchMiddleware: false,
      openSearch: false,
      fileProcessor: false,
      licenseManager: false,
      peopleService: false,
      iqIntegrator: false,
      mcpService: false,
      ...platformOff,
      rwxStorage: true,
    };
  }
  return {
    openLdap: false,
    externalIdp: true,
    remoteSearch: false,
    contentComposer: false,
    ringApi: false,
    dam: false,
    imageProcessor: false,
    persistenceNode: false,
    persistencePool: false,
    persistenceMetrics: false,
    damPluginGoogleVision: false,
    damPluginKaltura: false,
    searchMiddleware: false,
    openSearch: false,
    fileProcessor: false,
    licenseManager: false,
    peopleService: false,
    iqIntegrator: false,
    mcpService: false,
    ...platformOff,
    rwxStorage: false,
  };
}

export { productionPlatformDefaults } from "./platform";
