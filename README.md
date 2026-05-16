# Bot Arena

A deterministic trading simulation league where strategy bots compete over historical OHLCV data. Watch five algorithms battle across 500+ candles, inspect every decision, compare seasons, and rehearse the paper trading governance stack — all without touching a live brokerage account.

---

## Requirements

- **Node.js 22+** (`node --version` to check)
- `npm` (bundled with Node)

---

## Quick Start

```bash
npm install
npm run dev        # start local dev server → http://localhost:5173
```

```bash
npm run build      # production build → dist/
npm test           # run all tests (Vitest)
npm run match      # headless CLI match — prints final standings to stdout
```

---

## What It Does

**Bot Arena runs deterministic backtests.** Every match replays historical (or synthetic) OHLCV candles in order. Five built-in strategy bots each manage an independent portfolio from the same starting cash. Fills are simulated with configurable fees and slippage. The same config always produces the same result.

### Primary flow

```
Configure match → ▶ Run → Inspect leaderboard / bots / events
     → History (save & compare) → Season (multi-window aggregate)
     → ◎ Paper (governance rehearsal, no real broker)
```

### The five bots

| Bot | Strategy |
|---|---|
| **Buy & Hold** | Buys 99% of equity on candle 1, holds until the end |
| **MA Crossover** | Buys when the short MA crosses above the long MA; sells on cross-down |
| **Momentum** | Buys when recent return exceeds a threshold; exits when it falls below |
| **Mean Reversion** | Buys on dips below the rolling mean; sells on recovery |
| **Random Baseline** | Seeded random buy/sell decisions — a sanity-check floor |

All bots are long-only, market-order-only.

---

## Key Concepts

**Match** — one deterministic replay of a dataset. Every bot starts with equal cash. Final standings rank bots by return, drawdown, win rate, and profit factor.

**Season** — splits the dataset into N time windows and runs a full match over each. Aggregate standings rank bots by compounded return across all windows.

**History** — completed matches are auto-saved to localStorage (50-run cap). Use the History panel to browse, compare, and import past runs. Export a run as JSON using the **↓ JSON** button that appears in the header when a match is complete.

**Paper mode** — the ◎ Paper button opens a simulated paper trading panel. It exercises the full governance stack (enablement gate, credential store, safety rules, audit log) using an in-process fill simulator — no real Alpaca API calls are made. This is a rehearsal tool for the real broker integration planned in a future release.

---

## Configuration

Click **⚙** in the header to open the Config panel:

- **Starting cash** — initial portfolio value per bot
- **Fee** and **slippage** (basis points) — applied to every fill
- **Date range** — subset of candles to replay
- **Active bots** — enable/disable individual strategies
- **Bot parameters** — tune lookback windows and thresholds per strategy

Changes take effect on the next **Reset + Play**.

---

## CLI Match Runner

```bash
npm run match
```

Runs a headless match with default config and prints final standings to stdout. Useful for scripting and CI checks.

---

## Tests

```bash
npm test           # run once
npm run test:watch # watch mode
```

Tests cover: determinism, portfolio math, execution math, metrics, seasons, broker adapter compliance, governance rules (all 7, per-bot isolation), paper session runner, simulated paper adapter, audit log, and enablement gate lifecycle.

---

## Current Limitations

| Area | Status |
|---|---|
| **Market data** | Synthetic dataset included. CSV OHLCV import supported. Alpaca historical daily bars (IEX feed) available via the ⬇ Data panel — requires free Alpaca paper account credentials. |
| **IEX data quality** | Alpaca free-tier IEX data is partial-market volume (~2–5% of total market share). Volume-sensitive strategies may produce skewed results. Full SIP consolidated data requires an Alpaca premium subscription. |
| **Paper trading** | Multi-bot league panel (⚔ Paper) uses an in-process fill simulator — no real Alpaca order submission yet. Governance gate, eligibility lifecycle, and audit log are fully exercised. Real Alpaca Paper REST/WebSocket execution integration is planned for M12+. |
| **Bot capital model** | Multi-bot shared-account sleeve model implemented (M11): up to N bots per league session, per-bot capital allocation, auto-elimination, and eligibility lifecycle. |
| **Order types** | Long-only, market orders only. No shorts, limit orders, options, or margin. |
| **Persistence** | localStorage only (50-run history cap, market data cache). No cloud sync or database. |
| **Data source** | No live market data stream. No WebSocket price feed. Alpaca fetch is on-demand only. |

---

## Safety Warning

Bot Arena is a **simulation and rehearsal tool**. The paper league panel (⚔ Paper) currently makes no real order-submission API calls — all fills are computed in-process. The market data panel (⬇ Data) does make real HTTPS requests to the Alpaca Data API to fetch historical bars; no credentials are stored to disk.

When real Alpaca Paper integration ships in a future release:

- Credentials will only be accepted through the in-app credential form and will be wiped from memory on panel close or page unload.
- Every order intent, fill, governance block, and disarm event will be recorded in the in-app audit log.
- An explicit manual arming step is required before any broker order can be submitted.
- **No live-money / real-account trading path exists or will exist in v0.1.** Alpaca Paper API is paper-only; live-account trading requires separate configuration not present in this app.

---

## Project Structure

```
src/
  engine/           # pure TS simulation core (UI-agnostic)
    adapters/       # SimulatedPaperAdapter, PaperBrokerAdapter (spike)
    governance/     # EnablementGate, CredentialStore, GovernanceEngine, AuditLog
    types.ts        # all domain types
    simulation.ts   # createSimulation() API
    execution.ts    # executeOrder fill math
    metrics.ts      # computeMetrics, rankBots
    paperSessionRunner.ts  # single-bot async session runner (rehearsal/tests)
  app/
    components/     # React UI components
    hooks/          # useSimulation, usePaperLeague
    matchConfig.ts  # MatchConfig, defaultMatchConfig, buildSimConfig
    season.ts       # buildWindowDefs, runSeason
    history.ts      # localStorage persistence
  data/
    sampleDataset.ts  # 504-candle synthetic GBM "ARENA" dataset
  strategies/       # buyAndHold, movingAverageCrossover, momentum, meanReversion, randomBaseline
  cli/
    run-match.ts    # headless CLI runner
tests/              # Vitest test suite
roadmap.MD          # full project roadmap and decision log
```

---

## Roadmap

See [`roadmap.MD`](./roadmap.MD) for the full milestone plan, architecture decisions, and v0.1 ship criteria.

**Next milestones:**

- **M10** — CSV OHLCV import (real market data)
- **M11** — Bot eligibility + capital sleeves (`PaperLeagueRunner`)
- **M12** — Real Alpaca Paper adapter (REST + WebSocket)
- **v0.1** — ships after M12
