import { getCatalog, resolveToggles } from "../catalogs";
import type {
  ComponentId,
  ComponentToggles,
  Product,
  ProductCatalog,
  TopologyEdge,
  TopologyNode,
} from "./types";

const ORIGIN_EDGE_IDS = new Set(["cdn-waf", "waf-lb", "lb-hap", "u-dns", "dns-cdn"]);
const LAB_CDN_EDGE = "cdn-hap";

export function selectTopology(
  product: Product,
  toggles: ComponentToggles,
  productionPlatform = false,
): {
  catalog: ProductCatalog;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  toggles: ComponentToggles;
} {
  const resolved = resolveToggles(product, toggles, productionPlatform);
  const catalog = getCatalog(product);
  const active = new Set<ComponentId>();

  for (const n of catalog.nodes) {
    if (n.always) {
      active.add(n.id);
      continue;
    }
    if (n.optionalKey && resolved[n.optionalKey]) {
      active.add(n.id);
    }
  }

  // DXCN: RWX always present for Core
  if (product === "dxcn") active.add("rwxStorage");

  let nodes = catalog.nodes.filter((n) => active.has(n.id));
  // Dedupe by id (dxcn merges platformNodes excluding rwx already always)
  const seen = new Set<ComponentId>();
  nodes = nodes.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });

  let edges = catalog.edges.filter(
    (e) => active.has(e.source) && active.has(e.target),
  );

  const originPath = active.has("waf") && active.has("cloudLb");
  if (originPath) {
    edges = edges.filter((e) => e.id !== LAB_CDN_EDGE);
  } else {
    edges = edges.filter((e) => !ORIGIN_EDGE_IDS.has(e.id));
  }

  // No users→cdn if DNS sits in front
  if (active.has("dnsGslb")) {
    edges = edges.filter((e) => e.id !== "u-cdn");
  }

  return { catalog, nodes, edges, toggles: resolved };
}
