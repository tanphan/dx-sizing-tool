import { getCatalog, resolveToggles } from "../catalogs";
import type {
  ComponentId,
  ComponentToggles,
  Product,
  ProductCatalog,
  TopologyEdge,
  TopologyNode,
} from "./types";

export function selectTopology(
  product: Product,
  toggles: ComponentToggles,
): { catalog: ProductCatalog; nodes: TopologyNode[]; edges: TopologyEdge[]; toggles: ComponentToggles } {
  const resolved = resolveToggles(product, toggles);
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

  const nodes = catalog.nodes.filter((n) => active.has(n.id));
  const edges = catalog.edges.filter(
    (e) => active.has(e.source) && active.has(e.target),
  );

  return { catalog, nodes, edges, toggles: resolved };
}
