import { useState } from "react";
import {
  calibrateFromLocust,
  exportLocustScenarioMix,
  locustMeasurementsFromJson,
} from "../engine/calibrate";
import { downloadText, helmHintsYaml } from "../engine/export";
import { getDefaultProfileId, loadProfile } from "../engine/profiles";
import type { Product, SizingResult, UsageInputs } from "../engine/types";

interface Props {
  product: Product;
  inputs: UsageInputs;
  result: SizingResult;
  onProfileId: (id: string) => void;
}

const SAMPLE = `{
  "measurements": [
    { "componentId": "core", "rps": 140, "cpuCores": 6, "replicas": 2, "util": 0.7 },
    { "componentId": "haproxy", "rps": 800, "cpuCores": 0.4, "replicas": 2, "util": 0.5 }
  ]
}`;

export function CalibratePanel({ product, inputs, result, onProfileId }: Props) {
  const [json, setJson] = useState(SAMPLE);
  const [log, setLog] = useState<string[]>([]);

  return (
    <div>
      <div className="section">
        <h2>Locust → profile patch</h2>
        <p className="muted">
          Paste measurements from lab Locust + CPU metrics. Patches{" "}
          <code>rpsPerReplica</code> / <code>cpuPerRps</code> and registers a
          lab-calibrated profile.
        </p>
        <textarea
          className="mono"
          value={json}
          onChange={(e) => setJson(e.target.value)}
        />
        <div className="btn-row">
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              try {
                const base = loadProfile(getDefaultProfileId(product));
                const measurements = locustMeasurementsFromJson(json);
                const { profile, notes } = calibrateFromLocust(
                  base,
                  measurements,
                  `${base.id}-lab`,
                );
                onProfileId(profile.id);
                setLog([
                  `Registered ${profile.id} (${profile.confidence})`,
                  ...notes,
                ]);
              } catch (e) {
                setLog([e instanceof Error ? e.message : String(e)]);
              }
            }}
          >
            Apply calibration
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadText(
                "locust-scenario-mix.json",
                exportLocustScenarioMix(inputs),
                "application/json",
              )
            }
          >
            Export Locust scenario mix
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadText(
                `helm-hints-${result.product}.yaml`,
                helmHintsYaml(result.helmHints),
                "text/yaml",
              )
            }
          >
            Export Helm hints from BOM
          </button>
        </div>
        {log.length > 0 && (
          <ul className="warnings" style={{ marginTop: 12 }}>
            {log.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <h2>Helm scaling / resources (preview)</h2>
        <textarea
          className="mono"
          readOnly
          value={helmHintsYaml(result.helmHints)}
        />
      </div>
    </div>
  );
}
