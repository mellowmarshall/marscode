import { describe, expect, it } from "vite-plus/test";

import {
  detectSilentStallSeconds,
  formatCompactElapsed,
  formatMetricValue,
  isPlottableSeries,
  parseCommandOutputMetrics,
  shortJobLabel,
  stripAnsi,
} from "./jobOutputParser";

describe("jobOutputParser", () => {
  it("strips ANSI SGR and OSC escapes cleanly", () => {
    const raw = "\u001b[32m✓\u001b[0m passed \u001b[1;34mloss=0.412\u001b[0m";
    expect(stripAnsi(raw)).toBe("✓ passed loss=0.412");
  });

  it("extracts progress, ETA, rate, KPIs, and plottable series from ML training logs", () => {
    const log = [
      "\u001b[2m[00:31:02] epoch 3/5 step=650/1000 loss=0.438 eval_loss=0.491 lr=1.41e-5 2.41 it/s ETA 02:26\u001b[0m",
      "[00:31:15] epoch 3/5 step=660/1000 loss=0.429 eval_loss=0.482 lr=1.39e-5 2.42 it/s ETA 02:21",
      "[00:31:27] epoch 3/5 step=670/1000 loss=0.421 eval_loss=0.474 lr=1.36e-5 2.40 it/s ETA 02:17",
      "[00:31:41] epoch 3/5 step=680/1000 loss=0.412 eval_loss=0.468 lr=1.34e-5 2.40 it/s ETA 02:13",
    ].join("\n");

    const parsed = parseCommandOutputMetrics(log);
    expect(parsed.progress).toEqual({
      current: 680,
      total: 1000,
      fraction: 0.68,
      unit: "steps",
      stageLabel: "Epoch 3/5",
      rate: "2.40 it/s",
      etaText: "02:13",
    });
    expect(parsed.kpis.map((kpi) => [kpi.key, kpi.text])).toEqual([
      ["loss", "0.412"],
      ["eval_loss", "0.468"],
      ["lr", "1.34e-5"],
    ]);
    const lossSeries = parsed.series.find((item) => item.key === "loss");
    expect(lossSeries?.points).toHaveLength(4);
    expect(lossSeries?.points[3]?.step).toBe(680);
    expect(lossSeries?.points[3]?.value).toBe(0.412);
  });

  it("parses tqdm bars and detects NaN/Inf anomalies", () => {
    const log = [
      "Training:  68%|██████▊   | 680/1000 [14:22<02:13, 2.40it/s] loss=0.55",
      "Training:  69%|██████▉   | 690/1000 [14:26<02:09, 2.40it/s] loss=NaN",
    ].join("\n");

    const parsed = parseCommandOutputMetrics(log);
    expect(parsed.progress).toEqual({
      current: 690,
      total: 1000,
      fraction: 0.69,
      unit: "items",
      rate: "2.40 it/s",
      etaText: "02:09",
    });
    expect(parsed.kpis[0]).toEqual({
      key: "loss",
      label: "loss",
      value: null,
      text: "NaN",
      anomaly: "nan",
    });
    expect(formatMetricValue(null, "inf")).toBe("Inf");
  });

  it("parses vitest and bracketed build progress cleanly", () => {
    const vitestLog = "Tests  58 passed (126)\n";
    expect(parseCommandOutputMetrics(vitestLog).progress).toEqual({
      current: 58,
      total: 126,
      fraction: 58 / 126,
      unit: "tests",
    });

    const cmakeLog = "[12/24] Building CXX object foo.cpp.o";
    expect(parseCommandOutputMetrics(cmakeLog).progress).toEqual({
      current: 12,
      total: 24,
      fraction: 0.5,
    });
  });

  it("degrades silently to empty metrics for plain shell logs and hides flat series", () => {
    const plain = "Listening on http://127.0.0.1:5817\nConnected to database\n";
    expect(parseCommandOutputMetrics(plain)).toEqual({
      progress: null,
      kpis: [],
      series: [],
    });
    expect(
      isPlottableSeries({
        points: [
          { index: 0, step: 1, value: 0.5 },
          { index: 1, step: 2, value: 0.5 },
        ],
      }),
    ).toBe(false);
    expect(
      isPlottableSeries({
        points: [{ index: 0, step: 1, value: null, anomaly: "nan" }],
      }),
    ).toBe(true);
  });

  it("builds concise rail labels and compact elapsed / stall indicators", () => {
    expect(
      shortJobLabel({
        kind: "command",
        description: "qwen3-lora",
        command: "CUDA_VISIBLE_DEVICES=0 python -m trainer.lora --steps 1000",
      }),
    ).toBe("qwen3-lora");

    expect(
      shortJobLabel({
        kind: "command",
        command: "NODE_ENV=test ./node_modules/.bin/vp test run apps/server/src/ws.test.ts",
      }),
    ).toBe("vp test run");

    expect(
      shortJobLabel({
        kind: "command",
        command: "python3 -m trainer.lora --steps 1000",
      }),
    ).toBe("python3 trainer.lora");

    expect(formatCompactElapsed(45_000)).toBe("45s");
    expect(formatCompactElapsed(14 * 60_000)).toBe("14m");
    expect(formatCompactElapsed(2 * 3_600_000)).toBe("2h");

    expect(detectSilentStallSeconds(100_000, 159_000, true, 60)).toBeNull();
    expect(detectSilentStallSeconds(100_000, 194_000, true, 60)).toBe(94);
    expect(detectSilentStallSeconds(100_000, 194_000, false, 60)).toBeNull();
  });
});
