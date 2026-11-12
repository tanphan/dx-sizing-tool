import { useMemo, useState } from "react";
import { defaultToggles } from "./catalogs";
import { CalibratePanel } from "./components/CalibratePanel";
import { Estimator } from "./components/Estimator";
import { InputForm } from "./components/InputForm";
import { LiveComparePanel } from "./components/LiveComparePanel";
import { Simulator } from "./components/Simulator";
import {
  defaultUnitCosts,
  defaultUsageInputs,
  getDefaultProfileId,
  runSizing,
  type ComponentToggles,
  type Product,
  type UnitCosts,
  type UsageInputs,
} from "./engine";

type Tab = "estimator" | "simulator" | "calibrate" | "live";

const STORAGE_KEY = "dx-sizing-tool-v1";

function loadState(): {
  product: Product;
  inputs: UsageInputs;
  toggles: ComponentToggles;
  costs: UnitCosts;
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as {
      product: Product;
      inputs: UsageInputs;
      toggles: ComponentToggles;
      costs: UnitCosts;
    };
  } catch {
    return null;
  }
}

export default function App() {
  const saved = loadState();
  const [product, setProduct] = useState<Product>(saved?.product ?? "dxcn");
  const [inputs, setInputs] = useState<UsageInputs>(
    saved?.inputs ?? defaultUsageInputs,
  );
  const [toggles, setToggles] = useState<ComponentToggles>(
    saved?.toggles ?? defaultToggles("dxcn"),
  );
  const [costs, setCosts] = useState<UnitCosts>(
    saved?.costs ?? defaultUnitCosts,
  );
  const [tab, setTab] = useState<Tab>("estimator");
  const [profileId, setProfileId] = useState<string | undefined>();

  const result = useMemo(
    () =>
      runSizing({
        product,
        inputs,
        toggles,
        costs,
        profileId: profileId ?? getDefaultProfileId(product),
      }),
    [product, inputs, toggles, costs, profileId],
  );

  const persist = (
    next: Partial<{
      product: Product;
      inputs: UsageInputs;
      toggles: ComponentToggles;
      costs: UnitCosts;
    }>,
  ) => {
    const payload = {
      product: next.product ?? product,
      inputs: next.inputs ?? inputs,
      toggles: next.toggles ?? toggles,
      costs: next.costs ?? costs,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  };

  const switchProduct = (p: Product) => {
    setProduct(p);
    const t = defaultToggles(p);
    setToggles(t);
    setProfileId(undefined);
    persist({ product: p, toggles: t });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>HCL DX Sizing / Estimation</h1>
          <span>
            Estimator + traffic simulator · {result.profileId} · not official
            SCU
          </span>
        </div>
        <div className="controls">
          <div className="seg">
            <button
              type="button"
              className={product === "dxcn" ? "active" : ""}
              onClick={() => switchProduct("dxcn")}
            >
              DXCN
            </button>
            <button
              type="button"
              className={product === "compose" ? "active" : ""}
              onClick={() => switchProduct("compose")}
            >
              DX Compose
            </button>
          </div>
          <div className="seg">
            {(
              [
                ["estimator", "Estimator"],
                ["simulator", "Simulator"],
                ["calibrate", "Calibrate"],
                ["live", "Live vs est"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar">
          <InputForm
            product={product}
            inputs={inputs}
            toggles={toggles}
            costs={costs}
            onInputs={(v) => {
              setInputs(v);
              persist({ inputs: v });
            }}
            onToggles={(v) => {
              setToggles(v);
              persist({ toggles: v });
            }}
            onCosts={(v) => {
              setCosts(v);
              persist({ costs: v });
            }}
          />
        </aside>
        <main className="panel">
          {tab === "estimator" && <Estimator result={result} />}
          {tab === "simulator" && (
            <Simulator
              product={product}
              inputs={inputs}
              toggles={toggles}
              costs={costs}
              result={result}
              onInputs={(v) => {
                setInputs(v);
                persist({ inputs: v });
              }}
              onToggles={(v) => {
                setToggles(v);
                persist({ toggles: v });
              }}
            />
          )}
          {tab === "calibrate" && (
            <CalibratePanel
              product={product}
              inputs={inputs}
              result={result}
              onProfileId={setProfileId}
            />
          )}
          {tab === "live" && <LiveComparePanel result={result} />}
        </main>
      </div>
    </div>
  );
}
