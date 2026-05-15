# Bot Arena Roadmap

## Vision

Bot Arena is an experimental trading simulation league where many strategy bots compete across deterministic market matches. The platform should feel like a strategy laboratory, evolutionary arena, and sports league for trading algorithms.

The first product goal is not autonomous live trading. The first goal is a trustworthy local simulation environment where we can replay historical OHLCV data, run multiple bots against the same market stream, inspect every decision, compare performance, and iterate quickly.

The long-term objective is to graduate proven bots into real-money competition. In that future state, bots start with equal capital allocations and compete in live markets through Alpaca accounts or Alpaca API access. That objective should influence architecture now, but it must not expand the MVP scope.

## Non-Goals

- No live trading in the MVP.
- No brokerage integration in the MVP.
- No Electron shell in the MVP.
- No LLM-generated strategies in the MVP.
- No evolution or mutation engine in the MVP.
- No shorts, margin, options, futures, or leverage in the MVP.
- No SQLite or cloud persistence in the MVP.
- No live market data stream in the MVP.
- No promise that simulated results predict live trading results.

## Product Principles

- Simulation core first, app second.
- Fun and visibility first, with enough realism to avoid nonsense.
- Make the system feel like a league: matches, seasons, standings, bot identities, and inspectable histories.
- Every bot should be evaluated against the same market data and starting assumptions.
- Every important engine action should be observable through structured events.
- Prefer small visible milestones over large hidden rewrites.
- Keep the MVP long-only and market-order-only until the basic arena is trustworthy.

## Architecture Principles

- The engine is pure TypeScript and UI-agnostic.
- React observes and controls simulation state; it does not own trading logic.
- Strategies emit broker-neutral `OrderIntent` objects.
- Execution happens behind adapters:
  - `SimulatedExecutionAdapter`
  - future `PaperBrokerAdapter`
  - future `LiveBrokerAdapter`
- The same strategy logic should run in simulation, paper trading, and live trading without rewrite.
- Determinism is a first-class feature. The same config, dataset, and bot specs should produce the same events and metrics.
- No strategy may access future candles.
- Portfolio math, execution math, and replay determinism require tests before UI polish.
- Future live trading must require explicit manual enablement, secrets management, audit logs, kill switches, max-loss limits, position limits, and symbol allowlists.

## Execution Timing

**Decision (2026-05-15):** Strategies execute at the **close price of the current candle**. The strategy receives the full candle (open, high, low, close, volume) and issues an `OrderIntent`. The simulated execution adapter fills the order at `close + slippage`. This means:

- A strategy _can_ react to the candle's close in the same candle (e.g. a crossover triggered by today's close fills today at close+slippage).
- This is a common backtesting convention and slightly optimistic versus a real "execute at next open" model.
- The tradeoff is documented here so strategies aren't penalized in a live system for unrealistic fill assumptions.
- A future `executionTiming: "close" | "nextOpen"` config field could add the stricter model without engine rewrites.

## Domain Model

### Core Concepts

- `Dataset`: ordered OHLCV candles for one or more symbols.
- `DatasetManifest`: metadata describing symbols, timeframe, source, date range, and normalization assumptions.
- `SimulationConfig`: starting cash, fees, slippage, timeframe, symbols, seed, and execution assumptions.
- `BotSpec`: bot identity, strategy definition, parameters, starting capital allocation, and risk settings.
- `BotInstance`: runtime bot state for a single match, including per-candle equity history.
- `StrategyDefinition`: pure strategy module that evaluates market and portfolio context.
- `StrategyContext`: current candle, historical candles available so far, portfolio snapshot, bot state, and config.
- `OrderIntent`: broker-neutral desired order emitted by a strategy.
- `ExecutionFill`: simulated or broker-confirmed fill result.
- `PortfolioSnapshot`: cash, positions, equity, realized PnL, unrealized PnL, and exposure.
- `Trade`: completed or open trade lifecycle record.
- `ArenaEvent`: structured event emitted by the engine.
- `MetricSnapshot`: return, drawdown, Sharpe-like score, win rate, trade count, and other leaderboard fields.
- `SimulationRun`: complete record of config, dataset, bot specs, events, snapshots, and final standings.
- `Match`: one deterministic simulation run over one dataset/config.
- `Season`: a collection of matches used to evaluate bots across regimes, symbols, or time windows.

### Initial Engine API

```ts
createSimulation(config, dataset, botSpecs)
simulation.step()
simulation.runToEnd()
simulation.reset()
simulation.getSnapshot()
simulation.getEvents()
```

### Initial Order Scope

- Long-only.
- Market orders only.
- Buy by quantity or target allocation.
- Sell by quantity, percent of position, or close position.
- Fees and slippage applied by simulated execution.
- Rejected orders become events with reasons.

## Milestones

### Milestone 1: Pure TypeScript Simulation Core ✅

Goal: run a deterministic match without a UI.

Deliverables:

- New Vite + TypeScript project or TypeScript package scaffold. ✅
- Core domain types. ✅
- Bundled sample OHLCV dataset (504-day synthetic GBM, symbol "ARENA"). ✅
- Replay clock that advances candle by candle. ✅
- `createSimulation` API. ✅
- Event log for replay, decisions, orders, fills, portfolio updates, warnings, and match completion. ✅
- 5 bots: buy-and-hold, moving-average crossover, momentum, mean reversion, seeded random baseline. ✅
- Long-only market order execution. ✅
- Fees and slippage. ✅
- Independent portfolio per bot. ✅
- Basic metrics and final standings. ✅
- Tests for replay determinism, portfolio math, execution math, partial sells, oversell guards. ✅

Acceptance Criteria:

- Running the same match twice produces identical final standings and identical event sequences. ✅
- No bot can inspect future candles. ✅
- A bot can buy, sell, hold, and be rejected for invalid orders. ✅
- Fees and slippage visibly affect fills and equity. ✅
- Final standings can be printed from a CLI or test harness. ✅

### Milestone 2: Browser Arena Dashboard ✅

Goal: watch several bots compete in a local browser UI.

Deliverables:

- React + TypeScript browser app. ✅
- Simulation controls: play, pause, step, reset, speed (1×/4×/16×/max). ✅
- Simulation clock showing UTC date, candle index, and progress %. ✅
- Leaderboard with bot colors, return %, equity, max drawdown. ✅
- Price chart (close line + amber current-candle indicator + buy/sell markers for selected bot). ✅
- Equity curves (per-bot, growing in real time, selected bot highlighted). ✅
- Event feed (filtered to fills/rejections/warnings, auto-scroll, filtered per selected bot). ✅
- Selected bot inspector with parameters, portfolio, trades, and logs. ✅

Acceptance Criteria:

- User can run a match from start to finish in the browser. ✅
- Leaderboard updates during replay. ✅
- Selecting a bot updates the inspector. ✅
- Event feed explains bot behavior clearly enough to debug simple strategies. ✅

### Milestone 3: Match Configuration ✅

Goal: make matches configurable without code edits.

Deliverables:

- Configurable starting cash, fees, slippage, date range, and active bots. ✅
- Bot parameter editing before a match. ✅
- Dataset manifest display. ✅
- Match summary export as JSON. ✅

Acceptance Criteria:

- User can run two different match configs and compare final standings. ✅
- Exported run data includes config, bot specs, key metrics, and event count. ✅

### Milestone 4: Better Metrics and Debugging ✅

Goal: make bot evaluation more informative and trustworthy.

Deliverables:

- Max drawdown. ✅
- Win rate. ✅
- Profit factor. ✅
- Average trade. ✅
- Exposure time. ✅
- Equity curve drawdown view. ✅
- Trade markers on price chart. ✅
- Order rejection and risk warning visibility. ✅

Acceptance Criteria:

- Leaderboard supports ranking by multiple metrics. ✅
- Bot inspector makes it obvious why a bot won, lost, or stopped trading. ✅

### Milestone 5: Persistence and Seasons

Goal: compare bots over many matches.

Deliverables:

- Persisted match history.
- Season runner across multiple datasets or time windows.
- Aggregate standings.
- Per-bot performance history.
- Import/export for datasets and runs.

Acceptance Criteria:

- User can run a season and see aggregate winners.
- Individual match results remain inspectable.

### Milestone 6: Paper Trading Readiness

Goal: prepare the engine for broker-connected paper trading without risking real money.

Deliverables:

- Broker-neutral execution adapter interface.
- Paper trading architecture spike for Alpaca.
- Secrets management plan.
- Account and order reconciliation model.
- Broker event ingestion design.
- Manual enablement gates.

Acceptance Criteria:

- Simulation strategy code can be reused by a paper adapter design.
- Risks and controls are documented before any broker API key is used.

### Milestone 7: Live Trading Governance

Goal: define the safety system required before any real-money bot competition.

Deliverables:

- Kill switch.
- Max daily loss limit.
- Max position size.
- Max orders per day.
- Symbol allowlist.
- Bot-level capital allocation.
- Audit logs.
- Manual live-mode arming flow.
- Incident and rollback process.

Acceptance Criteria:

- No live order can be placed without explicit user arming.
- Every live order intent, submitted order, broker response, fill, cancel, and error is auditable.

## Definition of Done

- The milestone's acceptance criteria are met.
- Relevant tests pass.
- Deterministic behavior is verified where applicable.
- New domain assumptions are documented in this roadmap or nearby docs.
- The UI, if touched, can be run locally and visually checked.
- Event logs are clear enough to diagnose failures without guessing.
- No future-phase scope has leaked into the current milestone.

## Decision Log

- 2026-05-15: Build Bot Arena as a separate project.
- 2026-05-15: Start browser-first with Vite + React + TypeScript; defer Electron.
- 2026-05-15: Build the pure TypeScript simulation core before the app UI.
- 2026-05-15: Use generic OHLCV symbols initially, starting with ETF/stock-style data.
- 2026-05-15: Keep MVP long-only and market-order-only.
- 2026-05-15: Treat live Alpaca trading as a long-term objective, not MVP scope.
- 2026-05-15: Require broker-neutral strategy logic and execution adapters to avoid rewrites later.
- 2026-05-15: Strategies execute at current candle close price (fill = close + slippage). Documented as a known convention. A future `executionTiming` config option can add next-open semantics.
- 2026-05-15: All date generation and formatting uses UTC throughout (`getUTCDay()`, `timeZone:"UTC"`). Local-time date methods are banned to prevent off-by-one display bugs in western timezones.
- 2026-05-15: Max-speed mode (`runToEnd()`) is handled synchronously in the play `useEffect` so switching to max mid-playback completes the match instantly rather than running an unbounded interval.
- 2026-05-15: Milestone 3 config is held in `MatchConfig` (src/app/matchConfig.ts); `applyConfig()` in `useSimulation` rebuilds the sim from scratch and resets selected bot. Bot registry with param definitions lives in `src/app/botRegistry.ts`. Export writes a trimmed JSON (no candles) via a temporary blob URL.
- 2026-05-15: Milestone 4 adds `exposedCandles` counter to `BotInstance` (incremented each candle when positions.size > 0) for exposure time. `MetricSnapshot` gains `profitFactor`, `avgTrade`, `exposureTime`. Leaderboard columns are sortable; equity panel toggles between equity and drawdown view. Inspector guards `profitFactor`/`winRate`/`avgTrade` display on closed-trade count, not total trade count.

## Open Questions

- Should future live competition use one Alpaca account with internal capital sleeves, multiple Alpaca accounts, or Alpaca Broker API-managed accounts?
- What starter capital should each bot receive in simulation?
- Which first symbol and timeframe should the bundled dataset use?
- Should candles execute at close, next open, or configurable execution timing? ← see Decision Log
- What fee and slippage defaults are reasonable for early experiments?
- Should bot scores prioritize total return, risk-adjusted return, survival, or a composite league score?
- What minimum paper-trading track record should be required before a bot can be considered for live mode?
- How should we prevent overfitting when bots are tuned repeatedly against the same sample dataset?

## Risks

- Overfitting bots to a tiny historical dataset.
- Accidentally allowing lookahead bias.
- Treating simulated fills as more realistic than they are.
- Expanding scope into live trading before the simulation engine is trustworthy.
- UI polish distracting from engine correctness.
- Ambiguous order semantics causing incorrect portfolio math.
- Secrets or API keys being mishandled in future broker phases.
- Real-money automation causing losses without adequate controls.
- Regulatory, tax, and account restrictions once live trading enters scope.

## Backlog

- Project scaffold. ✅
- Engine package structure. ✅
- Domain type definitions. ✅
- Sample dataset. ✅
- Dataset validation.
- Replay clock. ✅
- Event bus/event log. ✅
- Simulation snapshot model. ✅
- Portfolio reducer. ✅
- Simulated execution adapter. ✅
- Fee and slippage model. ✅
- Bot registry.
- Buy-and-hold bot. ✅
- Moving-average crossover bot. ✅
- Momentum bot. ✅
- Mean reversion bot. ✅
- Seeded random baseline bot. ✅
- Metrics engine. ✅
- CLI or test harness match runner. ✅
- Determinism tests. ✅
- Portfolio math tests. ✅
- Execution math tests. ✅
- Browser dashboard shell.
- Leaderboard component.
- Price chart component.
- Equity curve chart.
- Event feed.
- Bot inspector.
- Match config panel.
- Run export.
- Season runner.
- Persistence layer.
- Alpaca paper trading research spike.
- Live trading safety design.
