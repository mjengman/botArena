# Bot Arena Roadmap

## Vision

Bot Arena is an experimental trading simulation league where many strategy bots compete across deterministic market matches. The platform should feel like a strategy laboratory, evolutionary arena, and sports league for trading algorithms.

The first product goal is not autonomous live trading. The first goal is a trustworthy local simulation environment where we can replay historical OHLCV data, run multiple bots against the same market stream, inspect every decision, compare performance, and iterate quickly.

The long-term objective is to graduate proven bots into real-money competition. In that future state, bots start with equal capital allocations and compete in live markets through Alpaca accounts or Alpaca API access. That objective should influence architecture now, but it must not expand the MVP scope.

## Non-Goals

- No live-money / real-account trading in v0.1. Alpaca Paper (the real Alpaca paper API — no real money) is a v0.1 goal; live-account / real-money trading is explicitly deferred. The simulated in-process adapter from M8 is a rehearsal tool only, not a substitute for real Alpaca Paper.
- No Electron shell in v0.1.
- No LLM-generated strategies in v0.1.
- No evolution or mutation engine in v0.1.
- No shorts, margin, options, futures, or leverage in v0.1.
- No SQLite or cloud persistence in v0.1 (localStorage for history/config; in-memory audit log).
- No live market data stream in v0.1 for the backtest/simulation modes (CSV import or on-demand Alpaca API fetch). _Exception: Alpaca Paper mode uses the Alpaca IEX WebSocket feed for real-time 1-minute bars (M13)._
- No multi-account or broker-managed account isolation in v0.1 (single Alpaca Paper account with internal capital sleeves).
- No promise that simulated results predict live or paper trading results.

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
- Backtest simulation uses `SimulationExecutionAdapter` (sync, deterministic, no broker connectivity). Only this adapter is accepted by `createSimulation()`.
- Paper and live trading use separate async broker-session orchestrators with a `BrokerAdapter` (async contract: `executeAsync`, `reconcileAccount`, `ingestBrokerEvent`). Single-bot rehearsal uses `PaperSessionRunner`; v0.1 multi-bot Alpaca Paper uses `PaperLeagueRunner` (one account, account-level reconciliation, per-bot sleeve ledgers). These orchestrators are not the simulation loop.
- The same strategy logic runs in simulation, paper trading, and live trading without rewrite — strategies emit broker-neutral `OrderIntent` objects and never touch execution adapters directly.
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

## Release 0.1 Ship Criteria

**Goal:** a usable local app where a new user can understand the product, run bot competitions on real market data, and safely prepare for Alpaca Paper trading. v0.1 is not live-money trading.

### 1. Usability / Onboarding

- A new user can understand what Bot Arena does without external narration.
- `README.md` exists and covers: setup, run commands, app purpose, current limitations, and safety warnings.
- Lightweight in-app first-run guidance or contextual help (tooltips, empty-state prompts, or a help panel) makes the main flow obvious.
- The primary UX path is clear: **configure match → run simulation → inspect leaderboard / bots / events → review history / season → optionally open paper mode**.
- A user can inspect what each bot is *trying to do* — not just its stats. Each bot's inspector shows a Strategy section: plain-English summary, entry rule, exit rule, tunable parameters with descriptions, and risk notes. This metadata lives on the strategy/bot definition, not in a separate document.

### 2. Real Market Data Ingestion

- The synthetic dataset remains available for demos and tests, but v0.1 must support at least one real data path.
- **Preferred incremental path:** CSV OHLCV import first (parse → validate → normalize → replay). Provider-backed fetcher is a stretch goal.
- If a provider-backed fetcher ships, Alpaca market data is the preferred provider — it shares infrastructure with the Alpaca Paper adapter already on the roadmap.
- The internal `Dataset` / `DatasetManifest` format remains the normalized contract; all importers and fetchers produce `Dataset` objects. Strategies and the simulation engine are not aware of the data source.

### 3. Alpaca Paper Readiness

- v0.1 ships with real Alpaca Paper REST/WebSocket integration — not live money, not the simulated adapter from M8.
- Paper trading must remain behind the existing explicit arming and safety-gate system.
- Every broker call (order submission, fill confirmation, reconciliation, disarm) must be auditable via the `AuditLog`.
- Live-account / real-money trading mode is not present in v0.1 and must not be reachable through any UI path.

### 4. Bot Capital Allocation and Eligibility

- Each bot has a first-class capital allocation (its "sleeve") within the shared Alpaca Paper account.
- Governance enforces sleeve limits before every order; the broker account is the single source of truth for settlement.
- A bot that exhausts its allocation or breaches a safety rule becomes **ineligible** to trade until a manual user action re-enables or refunds it.

**Bot eligibility statuses:**

| Status | Meaning |
|---|---|
| `ACTIVE` | Bot is permitted to trade within its allocation. |
| `PAUSED` | Bot is temporarily suspended; no new orders. Resumes on user action. |
| `ELIMINATED` | Bot has lost its full allocation; cannot trade until refunded. |
| `NEEDS_REVIEW` | A safety rule or governance check flagged this bot; user must review before it can trade again. |
| `RETIRED` | Bot has been permanently removed from competition. No re-enable path. |

The UI must show each bot's status, allocation, remaining equity, and the reason for ineligibility (if any). Re-enable and refund are explicit user actions — no auto-recovery.

### 5. Safety and Auditability

- Capital sleeves are internal accounting (enforced by the `GovernanceEngine`), not broker-enforced isolation. The broker sees one account; the engine assigns orders to bots.
- Governance checks before every order (in priority order): gate status, symbol allowlist, bot eligibility status, bot capital allocation, daily order count, daily realised loss, order notional cap, position size cap, and reconciliation state.
- Every order intent, rejection, submission, fill, disarm, re-enable, and refund action is recorded in the `AuditLog`.

### 6. Packaging and Release Readiness

- `README.md` with install/run instructions (Node version, `npm install`, `npm run dev`, `npm run build`, `npm test`).
- Stable localStorage persistence for match history and configuration.
- Known limitations documented (synthetic-only data until real import ships, single-account sleeve model, no live money, no multi-symbol paper trading).
- Tests cover: CSV import and validation, execution math, all governance rules including bot eligibility lifecycle, and end-to-end paper session flow.

---

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

### Milestone 5: Persistence and Seasons ✅

Goal: compare bots over many matches.

Deliverables:

- Persisted match history. ✅
- Season runner across multiple datasets or time windows. ✅
- Aggregate standings. ✅
- Per-bot performance history. ✅
- Import/export for datasets and runs. ✅

Acceptance Criteria:

- User can run a season and see aggregate winners. ✅
- Individual match results remain inspectable. ✅

### Milestone 6: Paper Trading Readiness ✅

Goal: prepare the engine for broker-connected paper trading without risking real money.

Deliverables:

- Broker-neutral execution adapter interface. ✅
- Paper trading architecture spike for Alpaca. ✅
- Secrets management plan. ✅
- Account and order reconciliation model. ✅
- Broker event ingestion design. ✅
- Manual enablement gates. ✅

Acceptance Criteria:

- Simulation strategy code can be reused by a paper adapter design. ✅
- Risks and controls are documented before any broker API key is used. ✅

### Milestone 7: Live Trading Governance ✅

Goal: define the safety system and async session runner required before any real-money bot competition.

Deliverables:

- `PaperSessionRunner`: async event-driven orchestration loop scoped to **one bot / one broker account** *(M7/M8 scope only — for single-bot rehearsal and testing against `SimulatedPaperAdapter`; multi-bot Alpaca Paper sessions use `PaperLeagueRunner` introduced in M11)*. Accepts a single `BotSpec` + `BrokerAdapter`. Shared domain with `createSimulation`: `BotSpec`, `StrategyFn`, `StrategyContext`, `OrderIntent`, `applyFill()`, `makePortfolioSnapshot()`, `ArenaEvent` vocabulary. ✅
- `ConcreteEnablementGate` with async precondition chain (`ArmingPrecondition[]`), auto-disarm timer, `GateLifecycleSubscriber` notification (calls `onArmed()` / `onDisarmed()` on all subscribers synchronously after each transition). ✅
- `ConcreteCredentialStore implements GateLifecycleSubscriber`: credentials may be stored before arming (precondition-first flow); `get()` still requires armed state; wipes credentials on `onDisarmed()`. Wired via `gate.subscribe(store)`. ✅
- Kill switch (via `gate.disarm()` — disarms on broker error, reconciliation drift, or explicit user action). ✅
- Session-start and session-end reconciliation, both fail-closed: reconcile throw or drift → disarm gate immediately. ✅
- `GovernanceEngine` with 7 safety rules (applied in priority order, all per-bot):
  1. `GATE_ARMED` — gate must be ARMED.
  2. `SYMBOL_ALLOWLIST` — symbol in `allowedSymbols`.
  3. `MAX_ORDERS_PER_DAY` — daily order count < `maxOrdersPerDay`.
  4. `MAX_REALIZED_DAILY_LOSS` — cumulative realised loss < `maxRealizedDailyLossUsd`. Note: realised-only; a future `MAX_EQUITY_DRAWDOWN` rule is needed before live deployment.
  5. `MAX_ORDER_NOTIONAL` — single order notional ≤ `maxOrderNotional`.
  6. `MAX_POSITION_SIZE` — projected position ≤ `maxPositionFractionOfEquity × equity`.
  7. `BOT_CAPITAL_ALLOC` — order notional ≤ remaining `botCapitalAllocationUsd`. ✅
- Audit logs (`AuditLog` — append-only in-memory, every governance/order/fill/error/gate/reconcile event; `export()` for persistence). ✅

Acceptance Criteria:

- No live order can be placed without explicit user arming. ✅
- Every live order intent, submitted order, broker response, fill, cancel, and error is auditable. ✅
- The `PaperSessionRunner` uses the same strategy and `OrderIntent` types as `createSimulation` — no strategy code changes required. ✅
- One runner = one bot = one account — no cross-bot order ambiguity. ✅ *(M11 extends this with `PaperLeagueRunner` for multi-bot Alpaca Paper sessions; `PaperSessionRunner` is retained as the single-bot rehearsal primitive.)*

## Definition of Done

- The milestone's acceptance criteria are met.
- Relevant tests pass.
- Deterministic behavior is verified where applicable.
- New domain assumptions are documented in this roadmap or nearby docs.
- The UI, if touched, can be run locally and visually checked.
- Event logs are clear enough to diagnose failures without guessing.
- No future-phase scope has leaked into the current milestone.

### Milestone 8: PaperModePanel UI ✅

Goal: add a paper trading panel to the browser app so the full governance stack can be exercised in the UI without a real Alpaca connection.

Deliverables:

- `SimulatedPaperAdapter` (`src/engine/adapters/simulatedPaperAdapter.ts`): implements `BrokerAdapter` with in-process fill simulation. `setCurrentCandle(price, timestamp)` injects the current price; `executeAsync()` mirrors `executeOrder` fill math (slippage + fee); `reconcileAccount()` always returns ok. No real API calls. ✅
- `usePaperSession` hook (`src/app/hooks/usePaperSession.ts`): owns the governance stack (gate, store, governance engine, audit log, adapter, runner) for one paper session. Exposes `setCredentials()`, `arm()`, `disarm()`, `startSession()`, `stopSession()`. Replay mode drives `PaperSessionRunner.tick()` through the sample dataset on an interval. Gate auto-disarm synced to React state via `GateLifecycleSubscriber`. ✅ _(UI superseded by M11 `PaperLeaguePanel`; `PaperSessionRunner` retained as an engine/test primitive.)_
- `PaperModePanel` (`src/app/components/PaperModePanel.tsx`): modal UI with gate status badge, credential entry (arming precondition), arm/disarm controls, session start/stop, live equity + P&L + % return, governance counters (daily orders, realised loss, committed capital), and a scrollable audit log tail. ✅ _(Deleted in M11; replaced by `PaperLeaguePanel`.)_
- `◎ Paper` button in `App.tsx` header-actions opens the modal. ✅ _(Now opens `PaperLeaguePanel` as of M11.)_
- Tests: `tests/simulatedPaperAdapter.test.ts` (18 tests — mode, price injection, buy fills, sell fills, reconciliation, event ingestion). ✅

Acceptance Criteria:

- User can open the Paper panel, enter (simulated) credentials, arm the gate, start a replay session, and watch equity update candle-by-candle. ✅
- Gate auto-disarm, credential wipe on disarm, and governance rule violations are all observable in the audit log. ✅
- No real Alpaca API calls are made (fills are computed in-process). ✅
- The credential store lifecycle (set → arm → disarm wipes) is exercised in the UI exactly as it will be in live mode. ✅

### Milestone 9: Release Definition + Onboarding Docs

Goal: make the app legible to a new user without external narration; establish the v0.1 release target formally.

Deliverables:

- `README.md`: project purpose, setup (Node version, `npm install`, `npm run dev`, `npm run build`, `npm test`), key concepts (match / season / paper mode), current limitations, safety warning for any future broker integration.
- In-app onboarding: lightweight first-run guidance or contextual help that makes the main flow obvious (configure → run → inspect → history/season → paper). Exact form TBD — tooltip overlay, help panel, or empty-state prompts.
- Document known limitations in `README.md`: synthetic-only data (real import lands in M10), single-account sleeve model (M11), no live money, M8 paper mode is simulated (real adapter lands in M12).
- Confirm `npm run match` CLI still works and is mentioned in `README.md`.

Acceptance Criteria:

- A developer unfamiliar with the project can clone, install, run, and understand the app using `README.md` alone.
- The UI does not dead-end a new user on first open.

---

### Milestone 10: Real Market Data Ingestion ✅

Goal: load real OHLCV data so bots compete on actual market history, not just the synthetic GBM dataset.

Deliverables:

- **CSV OHLCV importer:** parse a standard OHLCV CSV (date, open, high, low, close, volume), validate rows, normalise into the existing `Dataset` / `DatasetManifest` contract. Hard-reject: non-monotonic (out-of-order or duplicate) dates, non-numeric OHLCV fields, zero or negative prices. Warn but allow: date gaps (weekends, holidays, and vendor gaps are normal in daily data; implementing a full exchange calendar is out of scope for v0.1). Gap count and gap positions are surfaced in the `DatasetManifest` so strategies can reason about continuity if needed.
- UI: file picker or drag-and-drop that loads a CSV into the match config in place of (or alongside) the synthetic dataset.
- The synthetic dataset remains the default; imported datasets are an alternative source.
- Tests: CSV parsing (valid file, missing columns, non-numeric prices, out-of-order dates, empty file), deterministic replay on imported data (same CSV → same standings every run).
- Stretch goal: Alpaca market data API fetcher (on-demand bars for a symbol/date range → `Dataset`). This shares infrastructure with M12 and can be added without blocking M10's acceptance criteria.

Acceptance Criteria:

- User can load a real CSV and run a match against it.
- An imported dataset with the same content always produces identical standings.
- Invalid CSVs are rejected with a clear error; the app does not crash.

**M10 sidecar: Strategy metadata (ships with M10, does not block CSV acceptance criteria)**

Each strategy/bot definition is enriched with structured metadata so the BotInspector can show users what a bot is actually doing — not just its stats.

- Add a `StrategyMeta` type to the engine (or `botRegistry.ts`):
  ```ts
  interface StrategyMeta {
    summary: string;          // one-sentence plain-English description
    entryRule: string;        // when the bot buys
    exitRule: string;         // when the bot sells
    params: Array<{ key: string; label: string; description: string; unit?: string }>;
    riskNotes?: string;       // known weaknesses or edge cases
    // Future: evolutionLineage?: string[]; changeLog?: ChangeLogEntry[];
  }
  ```
- All five built-in strategies (`buyAndHold`, `movingAverageCrossover`, `momentum`, `meanReversion`, `randomBaseline`) get `StrategyMeta` entries.
- `BotInspector` gains a **Strategy** section: summary, entry/exit rules, parameter table (current value + description), and risk notes.
- `StrategyMeta` is display-only. It does not affect engine logic, execution, or test determinism.
- Leave a `evolutionLineage` / `changeLog` stub in the type for future evolution tracking — do not implement evolution yet.

---

### Milestone 11: Bot Eligibility + Capital Sleeves

Goal: give each bot a first-class capital allocation within a shared account, and enforce eligibility rules before every order.

Deliverables:

- **`BotEligibilityStatus` type:** `ACTIVE | PAUSED | ELIMINATED | NEEDS_REVIEW | RETIRED`.
- **`BotAllocation` domain model:** configured starting capital per bot, current equity within the sleeve, cumulative realised PnL, status, and a human-readable ineligibility reason.
- **`GovernanceEngine` extension:** add `BOT_ELIGIBILITY` as the first rule after `GATE_ARMED` — block any order from a non-`ACTIVE` bot before checking any other limit. Add `BOT_CAPITAL_ALLOC` enforcement at the sleeve level (separate from the existing per-bot capital check, which was scoped to a single-bot session runner).
- **Manual lifecycle actions:** `pauseBot(botId)`, `resumeBot(botId)`, `eliminateBot(botId, reason)`, `refundBot(botId, amount)`, `retireBot(botId)`. All actions are audited.
- **UI:** bot status badge, allocation bar (remaining / starting), ineligibility reason, and action buttons (Pause / Resume / Refund / Eliminate) visible in the bot inspector or a dedicated panel.
- Tests: each status transition, governance block on non-ACTIVE bot, refund restores allocation, eliminated bot cannot be resumed without refund, retired bot has no re-enable path, audit log entries for every action.

Acceptance Criteria:

- A bot that loses its full allocation is automatically set to `ELIMINATED` and blocked from further orders.
- A bot that triggers a safety rule is set to `NEEDS_REVIEW` and blocked until a user action clears it.
- Re-enable and refund are explicit user actions — no auto-recovery.
- Every status change is recorded in the audit log with a reason.

**Architectural decision (resolved here, not deferred):** M7's `PaperSessionRunner` is scoped to one bot / one broker account — correct as a single-bot rehearsal primitive, but not the right shape for a shared Alpaca Paper account with N bots. v0.1 introduces a new `PaperLeagueRunner` that owns the account layer:

- `PaperLeagueRunner` holds one `BrokerAdapter`, one Alpaca Paper account, and account-level reconciliation. All orders from all bots flow through it.
- Per-bot state (capital sleeve, eligibility status, realised PnL, daily counters) lives in the `PaperLeagueRunner`'s internal ledger — not in separate runners. The runner tags every outbound order with `botId` and attributes every inbound fill back to the correct bot.
- `PaperSessionRunner` (M7/M8) is retained as a single-bot tool for replays and testing against `SimulatedPaperAdapter`. It is not used for multi-bot Alpaca Paper sessions.
- Account-level reconciliation: `PaperLeagueRunner.reconcile()` compares the broker's total position + cash against the sum of all sleeve ledgers. Any drift disarms the gate and halts all bots — not just the one whose order preceded the drift.

This boundary ensures fill attribution is unambiguous, reconciliation covers the whole account, and `AuditLog` entries can always be traced to a specific bot. M12 wires `AlpacaPaperAdapter` into `PaperLeagueRunner`.

---

### Milestone 11.5: Usability + Alpaca Historical Data

Goal: improve UX discoverability for confusing concepts and add an on-demand Alpaca historical data importer so users can fetch real OHLCV data directly from the app.

Deliverables:

- **Tooltip component** (`src/app/components/Tooltip.tsx`): inline `?` badge that shows explanatory text on hover. Pure CSS hover, no JS state. Usable inside `<label>` tags (inline element).
- **ConfigPanel tooltips:** `Fee (bps)`, `Slippage (bps)`, `Seed`, and `Date Range` labels gain explanatory tooltips. Dataset section gains `Feed` and `Timeframe` rows for source labeling.
- **Leaderboard tooltips:** `MaxDD`, `Win%`, `Return`, and `Equity` column headers gain tooltips explaining each metric.
- **PaperLeaguePanel tooltips:** `Gate Status`, `Unallocated Cash`, `NEEDS_REVIEW` badge, and `ELIMINATED` badge gain explanatory tooltips.
- **`DatasetManifest.feed` field** (`src/engine/types.ts`): optional `feed?: string` qualifier (e.g. `"iex"` for Alpaca IEX, `"sip"` for full SIP). Absent for CSV imports and synthetic data.
- **Alpaca market data provider** (`src/data/providers/alpacaMarketData.ts`): `validateMarketDataRequest`, `fetchAlpacaBars` — fetches daily OHLCV from `data.alpaca.markets/v2/stocks/{symbol}/bars`, handles pagination via `next_page_token`, normalizes to `Dataset`. Credentials are NOT stored to localStorage.
- **localStorage market data cache** (`src/data/marketDataCache.ts`): `getCachedDataset`, `setCachedDataset`, `clearMarketDataCache`, `listCachedEntries`. Cache key includes symbol/timeframe/date range but never API credentials.
- **MarketDataPanel** (`src/app/components/MarketDataPanel.tsx`): modal with credential entry (in-memory only), fetch parameter form, cache list, and dataset preview before applying. `⬇ Data` button in `App.tsx` header-actions opens the modal.
- **exportRun.ts**: `feed` field added to dataset block.
- Tests: `tests/alpacaMarketData.test.ts` (validation, mocked fetch, pagination, error cases), `tests/marketDataCache.test.ts` (cache key format, round-trip, clear, list).

Acceptance Criteria:

- User can fetch real Alpaca IEX daily bars for any symbol/date range by entering credentials in the MarketDataPanel.
- Fetched datasets are cached in localStorage (by symbol/date range, not by credentials); cache is listed and clearable from the panel.
- After fetching, user can preview the dataset manifest (symbol, source, feed, date range, candle count) and apply it to the match with one click.
- Tooltips are visible on hover next to every labeled concept in ConfigPanel, Leaderboard, and PaperLeaguePanel.
- API keys are never written to localStorage under any code path.
- All new tests pass.

Status: ✅ Complete

---

### Milestone 12: Alpaca Paper Adapter ✅

Goal: replace `SimulatedPaperAdapter` with a real Alpaca Paper REST + WebSocket integration. _(M13 is the final milestone before v0.1 — see below.)_

Deliverables:

- **`AlpacaPaperAdapter` implements `BrokerAdapter`** (`src/engine/adapters/alpacaPaperAdapter.ts`): REST order submission (`POST /v2/orders`), fill confirmation via polling (`GET /v2/orders/{id}` up to `fillPollMaxRetries` times), `reconcileAccount()` against `GET /v2/account` + `GET /v2/positions` snapshot, `ingestBrokerEvent()` for fill/cancel/reject events. Configurable via `AlpacaPaperAdapterConfig`; defaults in `DEFAULT_ALPACA_PAPER_ADAPTER_CONFIG`. ✅
- **`makeAlpacaArmingPreconditions()` factory** (`src/engine/adapters/alpacaArmingPreconditions.ts`): three-step arming chain — credentials present → `GET /v2/account` returns 200 OK → account status `ACTIVE`. Shared closure state so the account is only fetched once per arming attempt. Uses `store.peekForArming()` to access credentials without requiring ARMED state during preconditions. ✅
- **`ConcreteCredentialStore.peekForArming()`**: returns stored credentials without the armed-gate check — exclusively for use in arming preconditions. ✅
- **Credential UX in `PaperLeaguePanel`**: mode selector (Simulated / Alpaca Paper) shown when DISARMED. Simulated mode unchanged (any key value). Alpaca Paper mode: separate API Key + API Secret fields (password type for secret); fields cleared on disarm. In-session warning banner ("REAL orders submitted to Alpaca Paper"). ✅
- **`GovernanceEngine.resetStats()` boundary fix**: optional `forceReset = true` param. When `false`, daily order/loss counters are preserved if the UTC calendar day has not changed — prevents intra-day session restarts from circumventing daily limits in real trading. Simulated replay passes `true` (unchanged behaviour). ✅
- **`usePaperLeague` mode support**: `LeagueMode = "simulated" | "alpaca-paper"`. `setMode()` action rebuilds governance stack; only allowed when DISARMED. In alpaca-paper mode: `AlpacaPaperAdapter` + real arming preconditions; `SimulatedPaperAdapter.setCurrentCandle()` skipped. Date-aware `resetStats()` used for real mode; force reset for simulated replay. ✅
- Tests: `tests/alpacaPaperAdapter.test.ts` — adapter interface compliance, `toAlpacaOrder` / `fromAlpacaFill` conversion, `executeAsync` (immediate fill, polling, timeout, rejected order, HTTP 403, network error), `reconcileAccount` (no drift, cash drift, position drift, tolerance bounds, symbol absent in engine), `ingestBrokerEvent` (fill, rejected, connection error), `makeAlpacaArmingPreconditions` (all 3 preconditions, full gate arm success and failure), `resetStats` forceReset boundary. ✅

Acceptance Criteria:

- User can enter real Alpaca Paper credentials, arm the gate (3-step precondition chain verifies credentials live against Alpaca), submit orders through the real Alpaca Paper REST API, and see the confirmed fill in the audit log. ✅
- Credential wipe on disarm or page unload is enforced by `ConcreteCredentialStore`'s `beforeunload` handler and `onDisarmed()` subscriber. ✅
- A reconciliation drift (cash or position beyond tolerance) immediately disarms the gate and blocks further orders. ✅
- No live-account / real-money trading path exists or is reachable from the UI. ✅
- Simulated mode (existing replay behaviour) remains fully functional and unaffected. ✅

**→ v0.1 ships after M13 acceptance criteria are met and `README.md` reflects the final state.**

> **Note:** M12 acceptance criteria are met. However, the current `PaperLeaguePanel` in
> "Alpaca Paper" mode still drives strategy decisions from a 350 ms replay loop over the
> synthetic candle dataset, which can fire real Alpaca Paper orders faster than once per
> trading session. M13 (below) is required before calling the live-paper feature
> "production-ready." v0.1 ships when M13 lands.

---

### Milestone 13: Browser Live-Paper Runner (PaperLiveRunner) ✅

Goal: replace the synthetic-replay loop with a real-time candle driver so that Alpaca Paper
strategies run at a sane cadence — one decision per bot per completed 1-minute bar, bounded
by market hours — rather than at a fixed 350 ms interval over historical data.

**Problem:** M12's `usePaperLeague` (alpaca-paper mode) still drives order submission from a
`setInterval` loop replaying the synthetic dataset. This submits real Alpaca Paper REST orders
at ~3 orders/second (one per 350 ms tick × N bots × N strategies). The fill prices are correct
(Alpaca fills at current market price), but the timing is incoherent: strategies see 2020 candle
data while the fills arrive at 2026 prices, and the loop can fire thousands of synthetic candles
in minutes.

**Scope:**

- `PaperLiveRunner` (`src/engine/paperLiveRunner.ts`): browser-based async runner similar to
  `PaperLeagueRunner` but driven by real market bars instead of a synthetic dataset.
  - Subscribes to completed 1-minute bars via Alpaca WebSocket (`wss://stream.data.alpaca.markets/v2/iex`).
  - Falls back to REST polling (`GET /v2/stocks/{symbol}/bars?timeframe=1Min`) when WebSocket
    is unavailable or reconnecting.
  - Fires exactly one strategy tick per bot per completed bar. Bars that arrive out of order
    or with gaps are flagged in the audit log but still processed.
  - Enforces a market-hours guard: no strategy ticks or order submissions outside regular
    market hours (9:30–16:00 ET, Mon–Fri). Guard uses the Alpaca `GET /v2/clock` endpoint to
    confirm market open/close rather than local system time.
  - Respects the existing `GovernanceEngine` rules (gate, symbol allowlist, daily limits,
    capital allocation, reconciliation) unchanged.
  - Session start: fetches account cash, computes `initialUnallocatedCash`, arms
    `PaperLeagueRunner` exactly as M12 does.
  - Session restart within the same market session: reconciliation + date-aware `resetStats()`
    (preserves daily counters — M12's `forceReset = false` path).
  - Audit/sleeve state durability: serialize audit log + sleeve state to localStorage on each
    bar close (allows recovery after a page reload within the same session).

- `usePaperLive` hook (`src/app/hooks/usePaperLive.ts`): replaces or extends `usePaperLeague`
  for the "Alpaca Paper" mode. Holds the `PaperLiveRunner`, WebSocket connection state, and
  last-received bar. Exposes `isMarketOpen`, `lastBarAt`, `barsReceived` to the UI.

- `PaperLeaguePanel` updates:
  - "Alpaca Paper" mode shows a live market-hours indicator and the most recent bar timestamp.
  - Remove the synthetic-candle replay progress bar in live mode (irrelevant).
  - Display a "Market closed" banner when outside regular hours — no orders are being placed.

- Tests: WebSocket bar ingestion (mock WS), fallback to REST polling, market-hours guard
  (open / closed / boundary), restart reconciliation, bar-gap audit entry.

**Acceptance Criteria:**

- In Alpaca Paper mode, strategies fire at most once per completed 1-minute bar. ✅
- No strategy ticks or order submissions occur when the market is closed. ✅
- A page reload within the same market session recovers sleeve state and daily counters without
  requiring a manual re-arm. ✅
- The synthetic-replay progress bar is hidden in live mode. ✅

**Deliverables shipped:**
- `src/engine/paperLiveRunner.ts`: `PaperLiveRunner` — browser WS + true REST fallback (not parallel) + market-hours guard + bar dedup (closed-market bars update `_lastBarAt`) + gap detection + same-day session recovery via localStorage
- `src/engine/liveSessionStorage.ts`: `saveLiveSession` / `loadLiveSession` / `clearLiveSession` / `utcDateKey` helpers — includes full sleeve state (`PersistedSleeveState`: cash, positions, allocation, eligibility)
- `GovernanceEngine.getStats()` / `injectStats()` for per-bot stats serialization and recovery
- `PaperLeagueRunner.getSleeveSnapshots()` / `injectSleeveState()` for full sleeve recovery on page reload (P0 fix)
- `usePaperLeague` wired for live mode: no `setInterval` in alpaca-paper mode; `PaperLiveRunner` drives ticks
- `PaperLeaguePanel`: market-closed banner, WS status chip, bars-received counter (replaces candle progress in live mode)
- Tests: 49 new tests (25 original + 11 P0/P1 + 4 P1/P2 second-pass + 9 resolveInitialCash) covering WS auth flow, bar processing, dedup, market-hours guard, clock fail-closed, gap detection, reconnect, REST polling, stop, localStorage v2 round-trip, v1 rejection, governance stats injection, sleeve snapshot/inject round-trip, recovery path, cash gate bypass (fresh start, floor error, recovery bypass, edge cases). Total: 467/467 passing.

---

## Post-v0.1 Direction: Evolutionary Bot System

### Product Vision

Bot Arena should evolve from a static league of hard-coded bots into a generational strategy ecosystem. Bots should eventually feel like configurable strategy organisms with inheritable parameter "DNA." Successful bots survive, reproduce, mutate, specialize, and form lineages across matches and seasons.

The long-term product feel should move from:

> "a few trading scripts"

toward:

> "a living ecosystem of competing financial organisms evolving under market selection pressure."

### Critical Principle: Parameters First, Code Never (Near-Term)

Early evolution must mutate **parameters only**, not arbitrary strategy code.

This keeps the system deterministic, inspectable, testable, scientifically useful, and safe ahead of any paper or live integration. No AI-generated executable strategy code in the near-term roadmap.

The mutation engine operates on bounded numeric and boolean parameters — lookback windows, buy/sell thresholds, allocation sizing, stop-loss %, take-profit %, cooldown duration, volatility filters, confirmation thresholds — within declared per-archetype bounds. Strategies remain human-authored TypeScript; the engine only tunes their knobs.

`EvolvableBotSpec.params` is typed as `Record<string, number | boolean | string>` to accommodate categorical metadata (e.g. regime label, display color). **String params are not mutated in M14.** Only `number` and `boolean` params with declared bounds are eligible for mutation. String params are copied verbatim from parent to child. A future milestone may introduce bounded enum mutation (e.g. `"fast" | "slow" | "adaptive"`) if archetypes require it.

### Domain Model Extension

```ts
type EvolvableBotSpec = {
  id: string;
  name: string;
  archetype: string;                         // references a built-in strategy archetype
  params: Record<string, number | boolean | string>;
  generation: number;
  parentIds: string[];
  mutationRate: number;
  capital: number;
  metadata: {
    lineageId: string;
    createdAt: string;
    mutationSummary?: string;
    notes?: string;
  };
};
```

### Evolution Loop

1. Run match or season
2. Score bots by composite fitness (not raw return alone — see Fitness Model below)
3. Retire the weakest bots
4. Clone survivors
5. Apply bounded, seeded parameter mutations to clones
6. Generate next generation with lineage metadata
7. Repeat

### Population Retention Model

Evolution should **archive by default, not delete by default**.

The product model is an active population plus a compact fossil record:

- **Active population** — the current generation of bots eligible to compete, reproduce, or be manually inspected. This set should stay intentionally small enough to remain legible.
- **Archived bot records** — compact immutable records for bots removed from active competition. Each record stores bot id, generation, archetype, params, parent ids, lineage id, fitness score, window metrics summary, final status, and retirement reason.
- **Deep retention only for important bots** — full detail such as trade logs, equity curves, and rich inspection payloads is retained for champions, top-N per generation, manually starred bots, parents of the active generation, paper-promoted candidates, and unusual outliers. Ordinary failed bots keep only the compact record.
- **Continuity by default** — evolution runs persist their current generation, archive, config, seed, dataset/season manifest, selection rules, and mutation rules. Reopening the app should resume an evolution run unless the user explicitly resets it.
- **Human controls** — users can star/pin a bot, resurrect an archived bot into a future generation, export an evolution run, prune old detail, or intentionally reset an experiment.

Non-survivors leave active competition, but they are not erased. This preserves lineage, reproducibility, and the ability to learn from extinct branches without storing every tick forever.

### Fitness Model

Evolution should optimize for generalization, not single-window overfitting. Raw return is a poor sole objective — it rewards gambling on one period and ignores survival, consistency, and capital efficiency. The first fitness function must penalize:

- **Drawdown** — a bot that crashes 40% to gain 50% is not better than one that gains 30% cleanly
- **Volatility / inconsistency** — erratic equity curves predict fragile real-world performance
- **Overtrading** — excessive order counts signal noise-chasing and inflate costs
- **Inactivity** — bots that never trade cannot demonstrate fitness
- **Survival failure** — elimination from a match (full allocation loss) is a hard fitness penalty

**Multi-window season scoring is mandatory from the first generation.** Single-match fitness is not permitted as the sole selection criterion — it is the primary mechanism by which evolution produces overfit bots. M14 must score bots across multiple time windows (via the existing season runner) before selecting survivors.

Required fitness formula (multi-window season scoring):

```
fitness = average_window_score − inconsistency_penalty
```

Where each window score uses:

```
window_score = return
             − drawdown_penalty
             − volatility_penalty
             − inactivity_penalty
             − overtrading_penalty
```

The inconsistency penalty discourages bots that win some windows by gambling and lose others badly. A bot that returns +5% consistently across six windows beats one that returns +40% in one window and −20% in the rest.

### Evolution Validation Layer

All evolved bot specs must pass a validation layer before being admitted to any match, season, or paper session. The validation layer is responsible for:

- **Parameter bounds** — every mutated value must remain within the declared bounds for that archetype
- **Risk constraints** — no combination of params that would violate governance limits (e.g. a stop-loss of 0% or take-profit of 10000%)
- **Determinism checks** — the same seed and parent must always produce the same child spec
- **Forbidden configs** — configs known to cause degenerate behavior (e.g. lookback window of 0, allocation of 0) are rejected
- **Strategy compatibility** — evolved params must be compatible with the target archetype's parameter contract
- **Sanity validation** — numeric ranges are finite, non-NaN, and positive where required
- **Paper/live block** — evolved bots cannot be deployed to paper or live trading without a separate explicit human approval step (separate from the match admission gate)

---

### Milestone 14 — Parameter Evolution Sandbox *(planned)*

**Goal:** build the first deterministic evolution loop using existing hand-written strategy archetypes.

**Scope:**
- Simulation/backtest only — no paper or live evolution
- No LLM execution, no generated strategy code
- Parameter mutation only, within declared per-archetype bounds
- Built-in archetypes only (the five existing strategies)

**Deliverables:**
- `EvolvableBotSpec` type with lineage metadata
- Parameter bounds declarations per archetype
- Mutation engine: bounded, seeded, deterministic
- Survivor selection from match/season results using composite fitness score
- Clone + mutate pipeline: parent → bounded mutation → child spec
- Lineage metadata tracking (generation, parentIds, lineageId, mutationSummary)
- Active-vs-archived population ledger: non-survivors become compact archive records, not deleted records
- Evolution run persistence: current generation, archive, config, seed, dataset/season manifest, selection rules, and mutation rules survive app reload
- Champion history: highest-fitness bot per archetype across all generations
- Generation summary: generation number, population size, survivors, retirees, avg/best fitness
- Evolution validation layer (bounds, determinism, forbidden-config checks)
- Basic UI: "Next Generation" button, generation summary panel, champion list
- Tests: determinism (same seed → same child), bounds enforcement, lineage round-trip, scoring, survivor selection, validation layer rejections

**Acceptance Criteria:**
- Running the same evolution loop twice with the same seed produces identical child specs, fitness scores, and survivor selections.
- No child spec contains a parameter value outside its declared archetype bounds.
- String params are copied verbatim from parent to child; no string param is modified by the mutation engine.
- Every bot's lineage (generation, parentIds, lineageId, mutationSummary) is recorded and retrievable from the champion history.
- Retired/non-surviving bots are removed from the active population but retained as compact archived records with retirement reason and fitness summary.
- Reopening the app resumes the latest evolution run state; users do not start from scratch unless they explicitly reset the run.
- The champion bot is reproducible: given the champion's spec and the same dataset, the simulation produces the same metrics.
- Fitness scoring uses multi-window season results — no single-match score is used as the sole selection criterion.
- Evolved bots cannot be started in paper or live mode; the paper-readiness gate blocks them at the UI and engine level.
- The validation layer rejects out-of-bounds, forbidden, and NaN/Infinity param values before a child spec reaches any match.

**Does not include:**
- LLM involvement of any kind
- New strategy archetypes generated by AI
- Paper or live deployment of evolved bots

---

### Milestone 15 — AI Analyst / Mutation Advisor *(planned, after M14)*

**Goal:** introduce an LLM layer that analyzes generation results and proposes parameter mutations — as a researcher and coach, not as an autonomous code generator.

The AI should be allowed to:
- Analyze winning and losing bots across generations
- Identify parameter strengths, weaknesses, and regime specializations
- Propose bounded parameter changes with per-change rationale
- Suggest new archetypes for human review (text proposals only — no executable code)
- Explain why a bot succeeded or failed in a given window

The AI must not:
- Directly execute arbitrary strategy or parameter changes
- Bypass the validation layer
- Generate executable TypeScript strategy logic
- Apply any suggestion without explicit human approval

**AI suggestion shape:**
```ts
type AISuggestedMutation = {
  botId: string;
  rationale: string;
  proposedParamChanges: Array<{
    param: string;
    from: number;
    to: number;
    reason: string;
  }>;
  riskNotes: string[];
};
```

**Validation gate:** every AI suggestion passes through the same validation layer as deterministic mutations. Human reviews and approves suggestions before they are applied. The engine applies only validated, human-approved changes.

---

### Milestone 16 — Evolution Visualization *(planned, after M15)*

**Goal:** make the evolutionary history of the bot population legible and inspectable.

**Deliverables:**
- Genealogy tree: parent → child lineage visualization
- Lineage panel: full ancestor chain, generation-by-generation param delta, fitness history
- Champion history browser: highest-fitness bot per archetype, all-time and per-regime
- Species / archetype stats: population count, avg fitness, extinction / dominance trends
- Mutation history: what changed, when, from what parent, with what seed
- Evolutionary replay: step through generation-by-generation fitness progression
- Regime specialization maps: which bots excel in trending vs. mean-reverting vs. volatile windows

---

### Explicitly Deferred (Post-M16)

The following capabilities are intentionally excluded from the near-term roadmap:

- **AI-generated strategy templates** — LLM proposes an entirely new strategy logic skeleton; human reviews before it is ever compiled or run. Requires robust sandboxing and review pipeline not yet designed.
- **Human-reviewed new archetypes** — a human author writes a new archetype inspired by AI analysis; standard archetype review and test process applies.
- **Sandboxed AI-generated strategy logic** — executable TypeScript generated by LLM, run in an isolated environment. Deferred until the validation layer and inspection tooling are mature enough to make this safe.
- **Autonomous evolutionary systems** — evolution loops that run and apply mutations without human review. Requires a long track record of inspectable, validated evolution results first.

---

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
- 2026-05-15: Milestone 5 persists completed matches to localStorage (50-run cap, silent failure). Season runner splits `[dataStartIdx, dataEndIdx]` into N equal windows (last window absorbs remainder) and runs each synchronously via `createSimulation` + `runToEnd`. Aggregate standings compute avg return, compounded return (product of 1+r − 1), wins, avg drawdown, avg profit factor (Infinity capped at 10). Auto-save uses a `wasCompleteRef` to detect the false→true transition and guards on `candleIndex > 1` to avoid saving resets.
- 2026-05-15: Milestone 6 introduces `SimulationExecutionAdapter` interface (`src/engine/adapter.ts`) so strategies remain broker-neutral. `simulatedAdapter` wraps the existing `executeOrder` function unchanged — all callers pass no adapter and get it by default. `PaperBrokerAdapter` (`src/engine/adapters/paperAdapter.ts`) is a compile-time–verified spike that implements `BrokerAdapter` (not `SimulationExecutionAdapter`) and throws `NOT_IMPLEMENTED` for everything. `brokerTypes.ts` contains the full design document for secrets management, enablement gates, Alpaca API types, reconciliation model, and broker event ingestion — expressed as TypeScript types with inline comments.
- 2026-05-15: Milestone 7 implements `GovernanceEngine` with 7 safety rules in priority order (GATE_ARMED, SYMBOL_ALLOWLIST, MAX_ORDERS_PER_DAY, MAX_REALIZED_DAILY_LOSS, MAX_ORDER_NOTIONAL, MAX_POSITION_SIZE, BOT_CAPITAL_ALLOC) — all per-bot, checked before every broker submission. `ConcreteEnablementGate` enforces an async `ArmingPrecondition[]` chain; notifies `GateLifecycleSubscriber` instances (including `ConcreteCredentialStore`) synchronously on every arm/disarm. `PaperSessionRunner` is scoped to one bot/account pair — the correct boundary for live-money safety. `AuditLog` is append-only in-memory; callers call `export()` for persistence. Session-start and session-end reconciliation both fail closed (disarm on throw or drift).
- 2026-05-15: **Strategy metadata (`StrategyMeta`) shipped in M10.** Each bot definition gains a `StrategyMeta` record (summary, entry rule, exit rule, parameter descriptions, risk notes). `BotInspector` renders a Strategy section from this metadata. Display-only — no engine or test impact. A `evolutionLineage` / `changeLog` stub is reserved in the type for future evolution tracking; evolution is not implemented in v0.1. Rationale: users should be able to understand what a bot is trying to do without reading source code; this also forces strategy authors to articulate their logic clearly.
- 2026-05-15: **Resizable dashboard panels deferred post-M12.** First useful slice: resizable sidebar + event-log height, persisted to localStorage. Not a blocker for CSV import or Alpaca Paper. Prefer a small proven library or scoped pointer-event implementation when it ships.
- 2026-05-15: **ADR — `PaperLeagueRunner` for multi-bot Alpaca Paper sessions (resolved in roadmap, implemented in M11).** v0.1 uses one Alpaca Paper account shared by N bots with internal capital sleeves. Multiple independent `PaperSessionRunner` instances against one broker adapter would make fill attribution and account-level reconciliation ambiguous. The chosen shape: a new `PaperLeagueRunner` owns one `BrokerAdapter`, one account, account-level reconciliation, and per-bot sleeve ledgers. `PaperSessionRunner` (M7/M8) is retained as the single-bot rehearsal primitive for simulated replays and testing; it is not used for multi-bot Alpaca Paper sessions.
- 2026-05-15: Milestone 8 introduces `SimulatedPaperAdapter` — an in-process `BrokerAdapter` that simulates fills without real API calls. This lets the full governance stack (gate arming, credential store lifecycle, governance rules, audit log, session runner) be exercised from the UI before any Alpaca integration. The `usePaperSession` hook managed the stack and drove a candle replay loop via `setInterval`. `GateLifecycleSubscriber` is used to sync gate state changes (including auto-disarm) to React state without polling. `GovernanceEngine.resetStats(botId)` was added as the explicit session boundary. _Note: `usePaperSession` and `PaperModePanel` were deleted in M11 when `usePaperLeague` / `PaperLeaguePanel` superseded them. `PaperSessionRunner` and `SimulatedPaperAdapter` are retained as engine/test primitives._ Future caution: for real paper/live trading, daily order/loss limits should survive session restarts until the UTC day changes — `resetStats()` as written would wipe them. The simulated replay scope makes this acceptable for M8; the real-adapter milestone should revisit this boundary.
- 2026-05-15: **ADR — Sync simulation / async broker session runner split (Option B).** The backtest simulation loop (`createSimulation`) is synchronous and deterministic; it accepts only `SimulationExecutionAdapter` (sync interface). Paper and live trading use a separate `PaperSessionRunner` / `LiveSessionRunner` (Milestone 7+) with a `BrokerAdapter` (async interface). These are fundamentally different orchestration models: backtesting is deterministic replay; paper/live is an event-driven operating system. Partial fills, delayed confirmations, reconnects, cancel/replace, and account drift belong entirely in the session runner — not in the simulation loop. Shared domain: strategies, `StrategyContext`, `OrderIntent`, portfolio/fill helpers, event vocabulary, metrics snapshots, and risk policy types. Separate: orchestration loop, adapter interface, timing model, reconciliation, safety gates, credential handling, and broker event ingestion.

- 2026-05-16: **ADR — M13 second-pass safety fixes (P1/P2/P3) — v0.1 greenlight.** Four further issues found before v0.1 sign-off: **(P1)** Same-day recovery was still blocked by the $30k uninvested-cash floor check in `usePaperLeague.startSession()`. If a prior session left open positions, the free cash could be below $30k even though the persisted sleeve state + broker positions reconcile correctly. Fixed: `loadLiveSession(symbol)` is called before the cash check; if a same-day session with sleeve data exists, the floor check is skipped and `initialUnallocatedCash` comes from `persistedSession.unallocatedCash`. Session-start reconciliation validates correctness. **(P1)** Clock fetch errors in `_processBar()` silently kept the cached `_isMarketOpen` value. Once the runner had seen the market open, a transient network error could allow ticks/orders without a fresh confirmation. Fixed: clock errors now fail closed — the bar is skipped, `_lastBarAt` is updated (dedup), and the error is logged. **(P2)** `PersistedLiveSession` was still version 1 despite adding required `sleeves`/`unallocatedCash` fields; old v1 records from the first M13 commit would pass schema validation and silently omit sleeve recovery. Fixed: bumped to version 2; `loadLiveSession` rejects any record that is not version 2. **(P3)** Non-Goals section said "No live market data stream / no WebSocket price feed in v0.1" (now false since M13). Fixed with an exception clause. M12 goal line said "last milestone before v0.1" — corrected.

- 2026-05-16: **ADR — M13 post-review fixes (P0/P1/P2/P3) — v0.1 acceptance.** Four issues found in M13 review before v0.1 sign-off: **(P0)** Same-day recovery did not persist sleeve state (cash, positions, allocation, eligibility) — on reload, `PaperLeagueRunner` started with fresh $10k sleeves while Alpaca held positions from the prior run, causing reconciliation drift. Fixed by adding `PersistedSleeveState` to `liveSessionStorage.ts`, `getSleeveSnapshots()` / `injectSleeveState()` to `PaperLeagueRunner`, and wiring both into `PaperLiveRunner._saveSession()` and `start()`. **(P1a)** REST polling ran in parallel with WebSocket unconditionally ("fallback" in name only). Fixed: `_pollRestBar()` returns early when `_wsStatus === "connected"`. **(P1b)** Market-closed bars were not deduped — `_lastBarAt` was not updated in the closed-market branch, so the same bar re-appeared on every REST poll while the market was closed. Fixed: `_lastBarAt = timestamp` before returning. **(P2/P3)** "Headless" naming removed from M13 (implementation is browser-bound: uses browser `WebSocket` and `localStorage`); README limitations updated to reflect that WebSocket price feeds and same-day recovery now exist. 11 new tests added.

- 2026-05-16: **ADR — M12 is a REST paper-order smoke harness, not a live-paper runner (M13 gap).** The M12 `PaperLeaguePanel` in "Alpaca Paper" mode drives Alpaca Paper order submission from a 350 ms synthetic-candle replay loop. This proves the governance/adapter/credentials/reconciliation stack works end-to-end against real Alpaca Paper REST, but it is not a valid live-paper cadence: strategies observe 2020 synthetic prices while fills arrive at 2026 market prices, and the loop can fire thousands of candles in minutes. M13 (`PaperLiveRunner`) addresses this by replacing the synthetic replay with a real 1-minute-bar WebSocket driver, a market-hours guard, and bar-close serialization. Until M13 ships, the "Alpaca Paper" mode should be treated as a governance/adapter smoke test, not a production live-paper runner.

- 2026-05-16: **ADR — Evolutionary Bot System: parameters first, AI deferred, validation gated.** The post-v0.1 product direction introduces generational strategy evolution starting with M14. Four decisions are locked in at the roadmap level: **(1) Parameter mutation only in M14.** The first evolution loop mutates numeric and boolean parameters within declared per-archetype bounds. No LLM involvement, no generated TypeScript. Strategies remain human-authored; the engine tunes their knobs. This keeps the system deterministic, inspectable, and testable before any complexity is added. **(2) AI is deferred until M15, after the mutation/scoring/lineage loop is proven.** The LLM layer is a mutation advisor — it proposes bounded parameter changes and explains winners/losers; it does not write, modify, or execute strategy code. This boundary is enforced by the `AISuggestedMutation` output contract, which contains only param deltas and rationale, never executable logic. **(3) Every AI suggestion must pass the validation layer and receive explicit human approval before being applied.** The validation layer (bounds, risk constraints, determinism, forbidden configs, strategy compatibility) is not bypassed for AI-sourced changes. **(4) Evolved bots are blocked from paper and live deployment without a separate approval step.** Winning a backtest generation is not sufficient evidence of live-readiness. A future paper-readiness gate — analogous to the existing gate arming flow — is required before any evolved bot reaches a broker adapter. Rationale: the risks of selection pressure producing overfit, high-drawdown, or opaque bots are highest when the feedback loop is automated. Keeping humans in the loop at every transition point (generation approval, paper promotion, AI suggestion) preserves explainability and safety as the population grows.

- 2026-05-17: **ADR — Evolution retention policy and small-account defaults.** Evolution uses active population + archive, not deletion. Non-survivors are removed from active competition but retained as compact archived records with params, lineage, fitness summary, and retirement reason; rich detail is kept only for champions, top-N bots, starred bots, parents of the active generation, paper-promoted candidates, and unusual outliers. Evolution runs persist their current generation, archive, config, seed, dataset manifest, selection rules, and mutation rules so users do not restart from scratch unless they explicitly reset. Default simulation/paper sleeve capital is aligned with the intended real experiment size: **$100 per bot**. Default fee bps is **0** to match Alpaca's commission-free US stock/ETF model; SEC/FINRA sell-side regulatory fees are acknowledged but not yet modeled by the simple all-fill bps field. Default slippage is **0** for idealized paper parity; users can increase it to stress-test spread/market-impact assumptions. Because $100 accounts require fractional/notional orders to trade ~$100 symbols, simulated fills support fractional quantities, matching Alpaca's fractional stock/ETF order model.

## Open Questions

- Should future live competition use one Alpaca account with internal capital sleeves, multiple Alpaca accounts, or Alpaca Broker API-managed accounts?
- What starter capital should each bot receive in simulation? → resolved default: $100 per bot; still configurable.
- Which first symbol and timeframe should the bundled dataset use?
- Should candles execute at close, next open, or configurable execution timing? ← see Decision Log
- What fee and slippage defaults are reasonable for early experiments? → resolved default: 0 bps fees and 0 bps slippage; regulatory fee modeling remains future precision work.
- Should bot scores prioritize total return, risk-adjusted return, survival, or a composite league score?
- What minimum paper-trading track record should be required before a bot can be considered for live mode?
- How should we prevent overfitting when bots are tuned repeatedly against the same sample dataset?

**Evolution-specific open questions (M14+):**

- What is the right default population size — enough diversity to find good mutations without creating an unreadable swarm?
- How many generations should a population run before champion results are considered stable enough to trust?
- Should elimination from a match (full sleeve loss) be a hard disqualifier from reproduction, or a soft fitness penalty?
- How do we detect regime specialization early (a bot that only wins in trending markets) and surface it clearly to the user before they promote it?
- What is the right paper-readiness gate for evolved bots — a minimum number of winning seasons, a minimum fitness score, a minimum live-trading track record, or some combination?
- How should the UI present large evolved populations without overwhelming the user? (Champion view, species clustering, generational comparison?)
- When the AI mutation advisor (M15) proposes a param change, how much rationale is enough for a user to make an informed approval decision?

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

**Evolution-specific risks (M14+):**

- **Single-window overfitting:** bots evolved against one symbol or date range may perform well in that window and fail everywhere else. Fitness must always be measured across multiple windows or seasons.
- **Return-only optimization:** a fitness function that rewards only raw return will select for reckless, high-drawdown bots. The fitness model must penalize drawdown, volatility, and survival failure from the first generation.
- **Bot swarm illegibility:** large evolved populations can become unreadable — hundreds of near-identical bots with small parameter deltas and no clear champion narrative. Generation summaries, champion tracking, and lineage pruning are needed to keep the population interpretable.
- **Confusing backtest winners with paper/live-ready bots:** a bot that wins in simulation against historical data is not validated for live markets. Evolved bots must not be deployable to paper or live trading without a separate explicit approval step and a documented paper track record.
- **AI proposing plausible but unsafe parameter changes:** an LLM mutation advisor can generate confident-sounding but poorly grounded suggestions. Every AI suggestion must pass the validation layer and receive human approval before being applied — the AI is an advisor, not an executor.
- **Explainability debt:** as lineages grow, it becomes hard to trace why a bot has a given set of params. Lineage metadata, mutation summaries, and the genealogy UI are not optional polish — they are a correctness requirement for the evolution system.

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
- Season runner. ✅
- Persistence layer. ✅
- Alpaca paper trading research spike.
- Live trading safety design.
- **Strategy metadata + BotInspector Strategy section** (M10 sidecar — `StrategyMeta` type, all five built-in bots annotated, inspector UI). ✅
- **Resizable dashboard panels** (UX polish — not a blocker for M10/M11/M12). First useful slice: resizable sidebar width and event-log height, both persisted to localStorage. Prefer a small proven panel-resize library or a very scoped CSS/pointer-event implementation. Schedule after CSV import and Alpaca Paper wiring are complete to avoid derailing core milestones.
