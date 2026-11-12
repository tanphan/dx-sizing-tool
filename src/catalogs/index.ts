import type { ComponentToggles, Product, ProductCatalog } from "../engine/types";
import { composeCatalog } from "./compose";
import { dxcnCatalog } from "./dxcn";

export function getCatalog(product: Product): ProductCatalog {
  return product === "dxcn" ? dxcnCatalog : composeCatalog;
}

/** Force Ring API + image processor + persistence when DAM or Content Composer is on. */
export function resolveToggles(
  product: Product,
  toggles: ComponentToggles,
): ComponentToggles {
  const t: ComponentToggles = { ...toggles };
  if (product === "compose") {
    t.remoteSearch = false;
  }
  if (t.dam) {
    t.imageProcessor = true;
    t.persistenceNode = true;
    t.persistencePool = true;
    t.persistenceMetrics = true;
    t.ringApi = true;
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
  if (product === "dxcn" && t.remoteSearch) {
    // classic RS path; Search V2 can coexist but typically one
  }
  return t;
}

export function defaultToggles(product: Product): ComponentToggles {
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
  };
}
