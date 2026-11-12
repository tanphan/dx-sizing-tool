# HCL DX Sizing / Estimation Tool

Local Vite + React app: **Estimator** (BOM / cost / sessions) + **Simulator** (topology, edge RPS, util colors, load slider). Product switch: **DXCN** | **DX Compose**. Shared TypeScript sizing engine.

> Estimation aid — not an HCL official SCU.

## Live (GitHub Pages)

https://tanphan.github.io/dx-sizing-tool/

## Run locally

```bash
cd dx-sizing-tool
npm install
npm run dev
```

```bash
npm test
npm run build
# local preview with Pages base path:
# VITE_BASE=/dx-sizing-tool/ npm run build && npx vite preview --base /dx-sizing-tool/
```

## Layout

- `src/engine/` — pure sizing kernel (`normalizeInputs`, `runSizing`, Helm hints, Locust calibrate, live compare)
- `src/catalogs/` — DXCN / Compose topology + toggle forcing
- `src/profiles/` — CF-tagged capacity JSON (`dxcn-cf238`, `compose-cf237`)
- `src/components/` — Estimator, Simulator, Calibrate, Live panels

## Auth topology note

External IdP (OIDC/SAML) is **not** behind HAProxy: browser → IdP redirect, then Core/webEngine → IdP back-channel (token/JWKS). OpenLDAP binds are Core/webEngine → LDAP. Login callback/ACS returns as portal traffic via HAProxy.

## Calibration

1. Run Locust scenarios on lab; capture RPS + CPU per component.
2. Paste JSON in **Calibrate** tab (see `scripts/sample-locust-measurements.json`).
3. Profile registers as `*-lab` with `confidence: lab-calibrated`.

Helm-ish `scaling` / `resources` hints export from the BOM (Estimator or Calibrate).

## Live compare

Paste `kubectl top pods` into **Live vs est**; names matched via substring map.
