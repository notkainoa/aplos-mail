# Timing-validity spike (plan 30 U1), 2026-10-27

**Question.** Can a never-shown Electron window (`show: false`) give trustworthy `requestAnimationFrame` cadence, long-animation-frame (LoAF) and Event Timing data, and real pixels from `webContents.capturePage()`? The answer decides where `test:perf` runs and whether the onboarding-window checks can be headless.

**Setup.** Electron 44.7.2 (Chrome 152) on the owner's MacBook Pro. `main.cjs` runs as an accessory app with no Dock icon and is never activated. Its window is created hidden and stays hidden (`isVisible()` false throughout). `page.html` animates a box with CSS, samples rAF for 2 s, injects one 120 ms long task at 1 s, and handles 20 synthetic J keys (`sendInputEvent`). Each key has a 20 ms keydown handler.

**Result** (`report.json` from one run; both passes in one window):

| Measure | Throttling off | Throttling on | Verdict |
|---|---|---|---|
| `document.visibilityState` | visible | visible | The hidden window counts as visible (`paintWhenInitiallyHidden` defaults to true) |
| rAF frames in 2 s, median / p95 / max delta | 115, 16.7 / 18.6 / 115.9 ms | 115, 16.7 / 18.5 / 114.7 ms | 60 Hz cadence; the injected long task shows as one long frame |
| LoAF entries | one, 138 ms | one, 139 ms | The injected long task is detected |
| Event Timing | 60 entries (20 × keydown, keypress, keyup); keydown 24 ms with 20–21 ms processing | same | Every key is measured; processing matches the 20 ms handler |
| CSS animation `currentTime` advancing | yes | yes | The compositor runs |
| `capturePage()` | 2880 × 1496 (2×), 40 sampled colours, not empty; the PNG shows the box mid-move | same | Real pixels |

**Decision.** `test:perf` and the visual harness can run in a hidden Electron window on this Mac. The data is valid for frame, long-frame and input-timing budgets. The window must be created with `show: false` and never shown, and `backgroundThrottling: false` is still set as a safeguard for occluded or minimised cases. The frame clock is 60 Hz in a hidden window even on a 120 Hz display, so budgets stay in 16.7 ms frames. Budgets that need the packaged, signed build (DESIGN 12.6) still run in the packaged app, driven the same way.

**Caveat found.** In sandboxed agent shells (such as the T3 agent environment), macOS refuses a second renderer process (`bootstrap_look_up … MachPortRendezvousServer: Permission denied`). The first window loads, and every later renderer fails with `ERR_FAILED (-2)`. The harness therefore:

- reuses one window and webContents for every state (navigate by route, not a new `BrowserWindow`);
- or runs from an unsandboxed shell (a normal Terminal or CI).

Playwright's `_electron.launch` may need the same treatment. Confirm when F8's Playwright base lands.

Run it again: `SPIKE_OUT=/tmp/out env -u ELECTRON_RUN_AS_NODE <path to Electron.app/Contents/MacOS/Electron> tests/perf/timing-spike/main.cjs`.
