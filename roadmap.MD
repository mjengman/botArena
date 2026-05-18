# Bot Arena Roadmap

## Vision

Bot Arena is a living regime-aware strategy ecosystem where competing bot lineages evolve across market seasons, specialize in regimes, and are promoted through an evidence ladder before ever touching real capital.

The first product goal is not autonomous live trading. The first goal is a trustworthy local simulation environment where we can replay historical OHLCV data, run multiple bots against the same market stream, inspect every decision, compare performance across seasons, and iterate quickly. The system should feel like a league — with matches, seasons, standings, lineages, and inspectable histories — not like a script runner or parameter optimizer.

The long-term objective is to graduate proven, regime-aware bots into real-money competition. In that future state, bots start with equal capital allocations and compete in live markets through Alpaca accounts or Alpaca API access. That objective must influence architecture now, but must not expand the MVP scope.

---

## Core Strategic Shift

Bot Arena is **not** primarily a parameter optimizer. It is an ecosystem simulator.

The distinction matters:

| Optimizer mindset | Ecosystem mindset |
|---|---|
| Find the best params for this backtest | Grow lineages that survive multiple regimes |
| Fitness = raw return | Fitness = season performance across return, drawdown, consistency, and survival |
| (no confidence concept) | Confidence = how trustworthy the evidence is (separate from fitness) |
| Win the season | Build a species that earns the right to compete |
| Retire bad bots | Archive extinct lineages; learn from them |
| Promote the winner | Graduate through the Evidence Ladder |
| Algorithm tunes itself | Human reviews every generation transition |

The product should feel like a **strategy habitat**. Bots hatch, compete, reproduce, specialize, and eventually either get promoted to paper competition or become archived fossils. The simulation engine is the environment. Seasons are the selection mechanism. Regimes are ecological niches. The user is the evolutionary steward, not a passive observer.

Every generation is a proposal. The user reviews the evidence and decides whether to advance, prune, or intervene. Automation runs the simulations; humans approve the conclusions.

---

## Product Experience Principles

1. **Ecosystem identity over anonymous scores.** Each bot has a lineage, a generation number, a parent, an archetype, and a name. The UI surfaces this identity at every opportunity — champion tables, inspector panels, archive views. A score without a story is not informative.

2. **Seasons over matches.** A single match result is noise. The primary unit of evidence is a season: multiple time windows, multiple regimes, one composite fitness score. Every generation advances on season evidence, never on a single match result.

3. **Regime awareness over universal rankings.** A bot ranked #1 in a trending market is not necessarily #1 overall. The UI surfaces regime specialization prominently so users understand *where* a bot's fitness was earned, not just *how much*.

4. **Confidence is not fitness.** A bot with three generations of strong results has more trustworthy fitness than an identically-scoring bot with one generation of results. Confidence (how much evidence backs the score) is surfaced separately from the score itself.

5. **Review loop, not black box.** Evolution should feel like a collaborative research process, not a background job. Each generation ends with a review step: the user sees what happened, what the engine proposes, and decides what to do next. The engine never advances a generation silently.

6. **Evidence ladder as a first-class concept.** Promotion from one competition tier to the next (simulation → paper → live) requires explicit evidence at each step. The ladder is visible, inspectable, and non-negotiable. No shortcut paths.

7. **Archive by default, delete never.** Bots removed from competition become fossils in the archive — compact, immutable, reproducible. The evolutionary history is the product's scientific value. Deleting it is deleting the experiment.

8. **Language shapes the model.** The product uses ecosystem vocabulary consistently: leagues, species, cohorts, regimes, champions, lineages, seasons, habitats, survival, extinction, specialization. This language is not decorative — it reflects the actual computational model and trains users to think in those terms.

9. **Evolution creates memorable events.** Comeback lineages, rivalries, extinction events, regime specialists, dynasties, and surprising mutations should be surfaced as product moments — not buried in tables. The ecosystem narrative is part of the product experience, not a UX polish afterthought.

---

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

## Anti-Goals / Guardrails

These are **not goals**, ever — regardless of how useful they might sound in isolation:

- **Autonomous evolution without human review.** The system must never advance a generation, apply mutations, or promote a bot to a higher competition tier without an explicit human approval step. Fully autonomous loops — even gated ones — are excluded from this roadmap until the inspection and auditability tooling is mature enough to make the risk legible.

- **Raw-return as the sole fitness criterion.** Optimizing for return alone selects for reckless, high-drawdown, overfit bots. Every fitness function must include drawdown penalty and consistency penalty from the first generation. Regime coverage must be surfaced as evidence once regime labels exist (Slice 4A) and may become a promotion criterion later, but it is not yet a fitness component.

- **Single-window fitness scoring.** A bot that won one backtest match is not an evolved bot. Multi-window season scoring is mandatory for generation advancement. This is an architectural constraint, not a UI decision.

- **AI-generated executable strategy code (near-term).** The LLM mutation advisor proposed in M15 may suggest parameter changes and explain reasoning — it may never emit, patch, or execute TypeScript strategy code without a formal sandboxing, review, and audit infrastructure that does not yet exist.

- **Silent context drift.** An evolution run must always be evaluated against the dataset and config it was created with. Cross-dataset or cross-config advancement without an explicit context-change warning and user consent is a correctness violation, not a UX tradeoff.

- **Paper or live promotion without the evidence ladder.** A backtest champion is not a paper candidate. A paper candidate is not a live candidate. Each transition requires documented evidence at the current tier and explicit user approval. The evolution system may not create shortcut paths around the ladder.

- **Swarm illegibility.** A population large enough that the user cannot name and understand each active bot is too large. The product targets small, inspectable populations. Legibility is a product constraint, not a future UX polish task.

---

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
- `EvolvableBotSpec`: a bot with lineage metadata — generation, parentIds, lineageId, archetype, mutationSummary.
- `EvolutionRunState`: the active-population ledger, archive, generation counter, and fitness records for one evolution experiment.
- `EvolutionRunContext`: the identity fingerprint of the dataset/config at run creation; used to detect silent context drift between generations.
- `EvolutionSessionData`: `{ runState, context }` — the unit of persistence for an evolution experiment.

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

## Post-v0.1 Direction: Living Strategy Ecosystem

### The Ecosystem Vision

Bot Arena grows from a static backtest league into a **living regime-aware strategy ecosystem** — a habitat where bot lineages hatch, compete across market seasons, specialize in regimes, accumulate evidence, and earn their way up an evidence ladder before ever touching real capital.

The system is not an optimizer seeking a global best parameter set. It is an evolutionary stewardship tool: the user is the curator of a living population, the engine is the environment, and seasons are the selection mechanism.

The long-term product feel moves from:

> "a few trading scripts that compete against each other"

toward:

> "a living ecosystem of competing financial organisms — hatching from archetypes, evolving across generations, earning league promotions through documented evidence, and eventually qualifying for deployment in real markets."

### Season Types

Evolution scoring uses seasons, not individual matches. Two season types are relevant:

**Backtest Season** (M14 core)
- Multiple time windows sliced from a historical dataset
- Each window is a separate match; scores are aggregated across windows
- Regime coverage is a property of window diversity: did the bot survive a downturn window as well as an uptrend window?
- The `runEvolutionSeason()` function in `season.ts` implements this
- Window count is fixed at run creation and cannot change within a run (context integrity constraint)

**Live Calendar Season** (post-M14, deferred)
- One window = one calendar period (day, week, month) of real live-paper trading
- Scores accumulate as real market time passes
- A bot's live-paper record becomes its evidence for the Evidence Ladder
- Regime labels are derived from market data, not from historical slicing
- This season type is the bridge between backtest evolution and paper deployment

Both season types produce the same `SeasonResult` shape; the difference is the data source and the temporal relationship to real calendar time.

### Market Regime Awareness

A bot's fitness score is meaningless without the regime context in which it was earned.

**Near-term regime dimensions (M14+):**

| Regime axis | States | Detection method |
|---|---|---|
| Trend direction | Uptrend / Sideways / Downtrend | N-period price slope vs. threshold |
| Volatility | High vol / Normal vol / Low vol | ATR or rolling return std dev |
| Volume character | Heavy / Normal / Light | Volume vs. N-period average |

Each season window should be labeled with its dominant regime(s) so that:
- A bot's aggregate score can be broken down by regime
- The UI can show "strong in uptrend, fragile in sideways"
- Champion selection can prefer regime generalists over regime specialists (configurable)
- The Evidence Ladder can require regime coverage as a promotion criterion

**Regime detection is read-only and display-first.** The first implementation computes regime labels from completed windows after simulation. Strategies do not see regime labels and cannot adapt to them (that would introduce future-data leakage). Regime labels are a post-hoc analytical tool for the user.

**Deferred dimensions (post-M14):** sector rotation, liquidity regimes, cross-asset correlation states, macro regime tagging.

### Confidence vs. Fitness

**Fitness** answers: how well did this bot perform?
**Confidence** answers: how much should I trust that fitness score?

They are different quantities and must be surfaced differently in the UI.

A bot with three seasons of strong fitness has higher evidence quality than an identically-scoring bot with one season of results. The former has been tested across more windows, more regimes, and more generations of selection pressure.

**Confidence factors (M14+ tracking):**

| Factor | Why it matters |
|---|---|
| Season count | One season is noise; five seasons are signal |
| Window diversity | Winning the same regime repeatedly is not confidence |
| Generation count | A lineage that has survived N generations of selection has been tested |
| Param stability | A bot whose params are near their bounds may be overfit to its exact params |
| Champion survival | Did the bot hold its fitness rank across multiple generations? |

Confidence is not a single number but a bundle of evidence indicators. The UI should surface it as a set of labeled indicators ("3 seasons · 2 regimes covered · survived 4 generations") rather than as a single synthetic score. Collapsing it to a number before the evidence model is mature is premature and misleading.

### Evolution Review Loop

Each generation of evolution should feel like a **collaborative research session**, not a background job that returns results for passive acceptance.

The intended UX flow for one generation cycle:

1. **Configure** — user sets season windows, fitness weights, survivor count, mutation rate
2. **Run season** — engine runs all active bots across all windows; progress visible
3. **Inspect season results** — per-window standings, aggregate scores, regime breakdown
4. **Review fitness scoring** — user can see how the composite score was computed for each bot
5. **Review survivor selection** — who survived and why; who was retired and why
6. **Inspect proposed mutations** — what params changed, by how much, within what bounds
7. **Review next-generation population** — the proposed new active population before it is committed
8. **Optionally override** — user can pin a bot to survive, veto a survivor, adjust params manually, or pause the run
9. **Commit** — user explicitly advances the generation; archive records are written; next generation becomes active

This is a 9-step review loop, not a single button. The panel should scaffold these steps with clear state transitions so the user always knows where they are in the cycle and what decisions they have made vs. deferred.

The current `EvolutionPanel` (M14 Slices 1–3) handles steps 1–2 and a compressed version of steps 3–9. The M14 Slice 4 sub-slices expand steps 3–9 into the full comprehension and review UX: **4A** covers steps 3–4 (inspect results, fitness breakdown); **4B** covers step 7 (next-gen preview before commit); **4C** covers step 8 (pin/veto/seed re-roll); **4D** covers confidence indicators and Evidence Ladder tier display.

### Evidence and Responsibility Ladder

Every bot starts as a hatchling. Advancement between tiers requires documented evidence at the current tier and an explicit user decision.

| Tier | Label | Evidence required to advance |
|---|---|---|
| 0 | **Hatchling** | Bot exists, has archetype and default params, has never competed |
| 1 | **Arena contender** | Has completed at least one backtest season; has a fitness score |
| 2 | **Backtest champion** | Top fitness score in its archetype across ≥2 seasons; regime coverage label |
| 3 | **Paper candidate** | Nominated by user after reviewing backtest evidence; not automatic |
| 4 | **Paper active** | Deployed to Alpaca Paper; accumulating live-cadence trade records |
| 5 | **Regime specialist** | Has documented regime-specific fitness advantage (e.g. strong in uptrend, ≥3 paper seasons) |
| 6 | **Live eligible** | Passed paper promotion review; all governance gates armed; user explicit approval |
| 7 | **Live active** | Deployed to real Alpaca account; under continuous governance monitoring |
| 8 | **Retired / Extinct** | Permanently removed from competition; compact record archived |

**Ladder rules:**
- Advancement is always a user action, never automatic.
- Regression is possible: a live-active bot that triggers a safety violation returns to `NEEDS_REVIEW` before any further tier movement.
- Skipping tiers is prohibited: a Hatchling cannot become Paper active without passing through Arena contender, Backtest champion, and Paper candidate first.
- Tier labels are surfaced in the UI wherever a bot appears: leaderboard, inspector, champion table, archive.
- The current system (M14) implements tiers 0–2. Tiers 3–7 are deferred to post-M14 milestones.

---

### Milestone 14 — Parameter Evolution Sandbox *(in progress)*

**Goal:** build the first deterministic evolution loop using existing hand-authored strategy archetypes. Bots mutate their parameters, compete across seasons, accumulate lineage records, and earn positions on the Evidence Ladder. The user reviews and approves each generation transition.

**Scope:**
- Simulation/backtest only — no paper or live evolution
- No LLM execution, no generated strategy code
- Parameter mutation only, within declared per-archetype bounds
- Built-in archetypes only (the five existing strategies)

---

#### M14 Slice 1 — Mutation Engine & Bounds ✅

Engine-only work: `EvolvableBotSpec` type, parameter bounds, the mutation engine, and the validation layer. No fitness scoring, no selection, no UI.

**Deliverables:**
- `EvolvableBotSpec` type with lineage metadata (`generation`, `parentIds`, `lineageId`, `archetype`, `mutationSummary`)
- Parameter bounds declarations per archetype (`src/engine/evolution/bounds.ts`): per-param min/max/step for all five built-in strategies
- Mutation engine: `mutateSpec(parent, seed, bounds, createdAt)` — bounded, seeded, deterministic; `mutateSpecNow` convenience wrapper for callers that don't need fixed timestamps
- Clone pipeline: parent spec → `mutateSpec` → child spec with updated lineage fields
- Validation layer: bounds checking, forbidden-config rejection (e.g. lookback = 0), NaN/Infinity guard, string-param passthrough
- Lineage metadata: `lineageId` assignment, `parentIds`, `mutationSummary` string generation
- Tests: determinism (same seed → same child), bounds enforcement, validation rejections, string param passthrough, lineage round-trip

**Acceptance Criteria:**
- `mutateSpec()` called twice with the same parent, seed, bounds, and timestamp always produces the same child spec
- No mutated param falls outside its declared archetype bounds
- String params are copied verbatim; no string param is ever mutated
- Forbidden configs (zero lookback, zero allocation, etc.) are rejected by the validation layer before reaching any match

---

#### M14 Slice 2 — Fitness, Selection & Generation Lifecycle ✅

Build the scoring, survivor-selection, and generation-advance logic on top of the Slice 1 mutation primitives.

**Deliverables:**
- `EvolutionRunState`: active population ledger, archive, generation counter, fitness records
- Archive model: compact immutable records for retired bots with params, lineage, fitness summary, and retirement reason
- Composite fitness scoring: multi-window `SeasonResult` → `FitnessRecord` (return component, drawdown penalty, inconsistency penalty, inactivity penalty, survival penalty)
- Survivor selection: rank bots by composite fitness, select top-N, retire the rest to archive
- `advanceGeneration(runState, seasonResult, config)`: scores bots → selects survivors → clones + mutates → writes archive records → returns next `EvolutionRunState`
- Champion tracking: highest-fitness bot per archetype across all generations retained in run state
- Tests: scoring formula, survivor selection at threshold boundaries, archive record integrity, `advanceGeneration` determinism (same seed → same next generation)

**Acceptance Criteria:**
- Running `advanceGeneration()` twice with the same seed produces identical child specs, fitness scores, and survivor selections
- Retired bots are compact archive records, not deleted; archive grows monotonically
- Fitness scoring uses multi-window results — no single-match score is used as the sole criterion

---

#### M14 Slice 3 — App Integration, Persistence & Context Integrity ✅

Wire the evolution engine to the season runner, build the initial `EvolutionPanel` UI, and persist run state across page reloads with dataset integrity guarantees.

**Deliverables:**
- `EvolutionRunContext`: identity fingerprint of the dataset/config at run creation — captures symbol, sliced start/end dates, candle count, `dataStartIdx`/`dataEndIdx`, `datasetFingerprint`, source, feed, `windowCount`, `startingCash`, `feeBps`, `slippageBps`, `seed`
- `EvolutionSessionData`: `{ runState: EvolutionRunState, context: EvolutionRunContext }` — the unit of persistence
- `computeDatasetFingerprint(dataset, startIdx, endIdx)`: djb2 hash over all OHLCV values in the slice; detects silent dataset substitution even when symbol/dates/count match
- `contextMatchesCurrent(stored, mc, sourceDataset)`: returns `string[]` of mismatches; any mismatch blocks generation advancement
- `EVOLUTION_SCHEMA_VERSION = 2`: versioned localStorage envelope; v1 and v0 records rejected cleanly on load
- `createEvolutionSession(config, mc, sourceDataset, windowCount, createdAt)`: throws if `config.populationSize !== BOT_REGISTRY.length` (initial population must cover all archetypes)
- `EvolutionPanel` (`src/app/components/EvolutionPanel.tsx`): modal UI for new-run configuration and active-run management; owns persistence (`saveEvolutionSession`, `clearEvolutionSession`); blocks `Run Season & Advance` when context mismatches detected; window count shown as static display (fixed at run creation, not editable)
- `🧬 Evolve` header button in `App.tsx` with `G{N}` generation badge
- `buildInitialPopulation(runId, config, startingCash, createdAt)`: one `EvolvableBotSpec` per registry entry with default params; lineageId and id derived from run + archetype + params hash for determinism
- Tests: 71 tests covering buildInitialPopulation, buildEvolutionManifest (sliced dates), buildRunContext (fingerprint, windowCount), adaptSeasonResult, createEvolutionRun, createEvolutionSession (populationSize guard), computeDatasetFingerprint, contextMatchesCurrent (all mismatch types, fingerprint detection), persistence (stale v1 rejection, missing fields, round-trip), runEvolutionSeason

**Context integrity rules (enforced at panel level):**
- Window count is immutable after run creation; the slider is removed from the active-run view
- Dataset fingerprint mismatch → advance blocked with explicit error message
- Any `contextMatchesCurrent()` mismatch → advance blocked; reset required to start fresh run

---

#### M14 Slice 4A — Season Inspection & Fitness Transparency *(planned)*

**Goal:** replace the compressed "Run Season & Advance" output with a legible season results view that explains exactly how each bot scored and why.

**Problem:** the current panel (Slice 3) runs a season and immediately proposes advancement with no intermediate inspection step. Users cannot see how the fitness score was computed or which windows each bot performed well in. This contradicts the "review loop, not black box" principle.

**Deliverables:**
- `FitnessExplanation` type (engine-owned, `src/engine/evolution/`): produced by an `explainFitness(record: BotFitnessRecord, config: EvolutionConfig)` helper — for `kind: "scored"` results, contains the return component, drawdown penalty contribution, inconsistency penalty contribution, configured weights for each component, and the final composite score; for `kind: "gate-failure"` results, contains the activity gate status or survival gate status (matching `gateFailureReason: "activity" | "survival"`) with no numeric score. This keeps the fitness formula in one place and gives the UI a stable, versioned explanation shape to render.
- Per-window standings table: each bot's return, drawdown, and profit factor per window, sortable by any column
- Regime label column per window (Uptrend / Sideways / Downtrend, derived from window price slope post-simulation)
- Per-bot aggregate row: avg return, avg drawdown, composite fitness score, regime coverage badge
- Expandable "Fitness breakdown" per bot: renders from `explainFitness()` output — one labeled row per component with the numeric contribution and configured weight shown inline
- Tooltip on each fitness component explaining what it measures and why it penalizes
- "Δ vs. last generation" diff row for bots that also competed in the prior generation

**Acceptance Criteria:**
- `explainFitness()` is the single authoritative source for fitness component values; the UI renders its output without recomputing anything from raw season data
- If `record.fitness.kind === "scored"`, `explainFitness(record, config).score === record.fitness.fitnessScore` — tested
- If `record.fitness.kind === "gate-failure"`, `explainFitness()` returns a gate-failure explanation with no numeric score, preserving `gateFailureReason` (`"activity"` or `"survival"`) — tested
- Regime labels are post-hoc and read-only; strategies never see them during simulation
- `explainFitness()` and the window table regime computation have corresponding unit tests

---

#### M14 Slice 4B — Staged Advance: Preview Before Commit *(planned)*

**Goal:** introduce a staging step between "season finished" and "generation committed" so users can review the proposed next generation before it becomes active.

**Deliverables:**
- `GenerationAdvanceProposal` value type: computed deterministically from the current `EvolutionRunState` + `EvolutionSeasonResult` under normal selection rules — contains the full season result, `BotFitnessRecord[]` for every bot, survivor decisions (with "survived because" / "retired because" annotations), archive delta (names + retirement reasons), and proposed child specs with their lineage. The proposal is a pure value; no run state is written until the user commits. *(Slice 4C later extends the input to accept pin/veto/reroll overrides that produce a modified proposal — that extension is not part of 4B's scope.)*
- After season results are reviewed, a separate "Review & Advance" step renders the `GenerationAdvanceProposal` — proposed active population (names, archetypes, generation numbers, parent lineages) and archive delta — before any state is written
- Explicit "Advance to Generation N" commit button — panel does not auto-advance on season completion
- Cancel path: user can abort the proposal and return to results review without side effects

**Acceptance Criteria:**
- No archive records are written and no generation counter is incremented until the user clicks the commit button
- `GenerationAdvanceProposal` is computed from the same `BotFitnessRecord` objects the engine produces — the UI never recomputes fitness from display data
- Slice 4B ships and is functional without any Slice 4C override inputs; override support is additive and deferred
- Cancelling the proposed advance leaves run state unchanged and returns to the season results view

---

#### M14 Slice 4C — Human Controls: Pin, Veto & Seed Re-roll *(planned)*

**Goal:** give the user meaningful override authority at every decision point in the review loop.

**Deliverables:**
- **Pin:** user can force a bot to survive regardless of its fitness rank; pin is recorded in lineage metadata and visible in future generations
- **Veto:** user can force a bot to retire regardless of its fitness rank; veto is recorded in lineage metadata with an optional user-supplied reason
- **Mutation proposal review:** for each proposed child, a diff table showing `param → old value → new value → % change` with archetype bounds as context
- **Seed re-roll:** user can re-roll the mutation seed for a specific child to explore alternative mutations; re-rolled seed is stored in lineage metadata for reproducibility
- Pin, veto, and seed re-roll surface in the Slice 4B staging view before commit

**Acceptance Criteria:**
- A pinned bot survives even if its fitness rank is below the survivor threshold; the pin reason is in its lineage metadata
- A vetoed bot retires even if its fitness rank is above the survivor threshold; the veto reason is in its lineage metadata
- A re-rolled seed produces a deterministic child spec; the child spec and new seed are identical on every subsequent load

---

#### M14 Slice 4D — Confidence Indicators, Regime Coverage & Evidence Ladder *(planned)*

**Goal:** surface the evidence quality and tier standing of each bot so users understand not just how a bot scored but how much they should trust that score.

**Deliverables:**
- Per-bot confidence indicator bundle: seasons completed, distinct regimes covered, generations survived, champion tenure ("held #1 for N generations in this archetype")
- No synthetic confidence score — indicators are always displayed as labeled facts, never collapsed to a single number
- Evidence Ladder tier badge per bot: Hatchling / Arena contender / Backtest champion
- Tier advancement notification: surfaced inline when a bot qualifies (≥2 seasons as top fitness in its archetype)
- Tier labels carried into archive records for retired bots
- Regime coverage summary per lineage: a compact view showing which regime types have been observed in this lineage's history

**Acceptance Criteria:**
- All confidence indicators are computed from stored run history with no synthetic aggregation
- Tier advancement detection is deterministic and testable independently of the UI
- Tier labels appear consistently in the active population table, the archive view, and the champion table

**Does not include (all four sub-slices):**
- M15 AI mutation advisor
- New strategy archetypes
- Paper or live deployment paths (tiers 3–7 of the Evidence Ladder)
- Automated regime detection as a strategy input (only post-hoc labeling)

---

### Milestone 15 — AI Analyst / Mutation Advisor *(planned, after M14)*

**Goal:** introduce an LLM layer that acts as an ecosystem analyst — studying generation results, identifying regime specialists and generalist survivors, and proposing bounded parameter changes with written rationale — as a research partner and coach, not as an autonomous executor.

The AI should be allowed to:
- Analyze winning and losing lineages across generations and regimes
- Identify parameter strengths, weaknesses, and regime specializations
- Propose bounded parameter mutations with per-change rationale and risk notes
- Suggest archetype characteristics worth exploring (text proposals only — no executable code)
- Explain why a lineage succeeded or went extinct in a given season
- Annotate the Evidence Ladder: which bots are close to tier advancement and why

The AI must not:
- Directly execute arbitrary strategy or parameter changes
- Bypass the validation layer or the review loop
- Generate executable TypeScript strategy logic
- Apply any suggestion without explicit human approval
- Advance a generation autonomously

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
  regimeContext?: string;     // e.g. "this lineage underperforms in sideways regimes"
  confidenceNote?: string;    // e.g. "only 2 seasons of evidence — treat as exploratory"
};
```

**Validation gate:** every AI suggestion passes through the same validation layer as deterministic mutations. Human reviews and approves suggestions through the M14 Slice 4B/4C review UI (staged advance + human controls) before they are applied. The engine applies only validated, human-approved changes.

---

### Milestone 16 — Evolution Visualization *(planned, after M15)*

**Goal:** make the evolutionary history of the bot ecosystem legible, inspectable, and beautiful — a genealogy of competing financial organisms across market regimes.

**Deliverables:**
- **Genealogy tree:** parent → child lineage visualization across generations; extinct branches shown as fossils
- **Lineage panel:** full ancestor chain, generation-by-generation param delta, fitness history, regime coverage history, tier advancement events
- **Champion history browser:** highest-fitness bot per archetype, all-time and per-regime; generation-by-generation champion succession
- **Species / archetype stats:** population count over time, avg fitness trend, extinction events, dominance periods
- **Mutation history:** what changed, when, from what parent, with what seed, and (if AI-sourced) with what rationale
- **Evolutionary replay:** step through generation-by-generation fitness progression with regime annotations
- **Regime specialization map:** which lineages excel in trending / sideways / downtrend / high-vol regimes — visualized as a habitat map

---

### Explicitly Deferred (Post-M16)

The following capabilities are intentionally excluded from the near-term roadmap:

- **AI-generated strategy templates** — LLM proposes an entirely new strategy logic skeleton; human reviews before it is ever compiled or run. Requires robust sandboxing and review pipeline not yet designed.
- **Human-reviewed new archetypes** — a human author writes a new archetype inspired by AI analysis; standard archetype review and test process applies.
- **Sandboxed AI-generated strategy logic** — executable TypeScript generated by LLM, run in an isolated environment. Deferred until the validation layer and inspection tooling are mature enough to make this safe.
- **Autonomous evolutionary systems** — evolution loops that run and apply mutations without human review. Requires a long track record of inspectable, validated evolution results first.
- **Live calendar seasons** — real-time Alpaca Paper seasons scored on live-cadence data. Deferred until the Evidence Ladder tiers 3–5 (Paper candidate → Paper active → Regime specialist) are implemented.
- **Cross-symbol regime ecosystems** — running the same lineage against multiple symbols to identify habitat preferences. Deferred until regime labeling is stable.

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

- 2026-05-18: **ADR — Product strategy refinement: ecosystem-first framing, Evidence Ladder, Confidence vs. Fitness, 9-step Review Loop.** After completing M14 Slices 1–3 (engine foundations, season integration, persistence + context integrity), the product strategy was formally refined before continuing development. Four architectural positions are now locked in at the roadmap level: **(1) Bot Arena is an ecosystem simulator, not a parameter optimizer.** The distinction changes how fitness is measured (regime-aware seasons over single matches), how populations are managed (small, legible, named lineages — not anonymous parameter swarms), and how results are communicated (evidence quality + regime context, not just return rank). **(2) Confidence is a first-class concept, separate from fitness.** A fitness score from one season with one regime is not trustworthy. Confidence is surfaced as a bundle of labeled evidence indicators (seasons completed, regimes covered, generations survived, param stability) — never collapsed to a single synthetic number before the evidence model is mature. **(3) The Evidence and Responsibility Ladder is non-negotiable.** Tier advancement (Hatchling → Arena contender → Backtest champion → Paper candidate → Paper active → Regime specialist → Live eligible → Live active) requires documented evidence at each tier and explicit user approval. Skipping tiers is architecturally prohibited. **(4) The evolution review loop is a 9-step collaborative UX, not a background job.** M14 Slice 4 expands the current "Run & Advance" button into a full inspection and approval flow: season results → fitness breakdown → survivor review → mutation proposals → next-gen preview → optional overrides → explicit commit. Rationale: the product's scientific value derives from its auditability. An ecosystem that the user cannot interrogate at each decision point is not a trustworthy research tool — it is just automation.

---

## Open Questions *(→ resolved items annotated inline)*

- Should future live competition use one Alpaca account with internal capital sleeves, multiple Alpaca accounts, or Alpaca Broker API-managed accounts?
- What starter capital should each bot receive in simulation? → resolved default: $100 per bot; still configurable.
- Which first symbol and timeframe should the bundled dataset use?
- Should candles execute at close, next open, or configurable execution timing? → resolved: close price; see Decision Log. A future `executionTiming` config option is noted but deferred.
- What fee and slippage defaults are reasonable for early experiments? → resolved default: 0 bps fees and 0 bps slippage; regulatory fee modeling remains future precision work.
- Should bot scores prioritize total return, risk-adjusted return, survival, or a composite league score? → resolved directionally: composite season score with return + drawdown penalty + consistency penalty + survival penalty; exact weights are configurable per run; see Fitness Model section.
- What minimum paper-trading track record should be required before a bot can be considered for live mode? → resolved structurally: the Evidence Ladder formalizes this as tiers 3–6 (Paper candidate → Paper active → Regime specialist → Live eligible); exact minimum seasons/scores TBD when tier 3 is implemented.
- How should we prevent overfitting when bots are tuned repeatedly against the same sample dataset? → partially addressed: multi-window season scoring, dataset fingerprinting, and context integrity are in place; the deeper answer (out-of-sample holdout windows, cross-symbol seasons) is deferred.

**Evolution-specific open questions (M14+):**

- What is the right default population size — enough diversity to find good mutations without creating an unreadable swarm?
- How many generations should a population run before champion results are considered stable enough to trust?
- Should elimination from a match (full sleeve loss) be a hard disqualifier from reproduction, or a soft fitness penalty?
- How do we detect regime specialization early (a bot that only wins in trending markets) and surface it clearly to the user before they promote it? → partially addressed: regime labels per window are planned in Slice 4A; the open question is the promotion policy.
- What is the right paper-readiness gate for evolved bots — a minimum number of winning seasons, a minimum fitness score, a minimum live-trading track record, or some combination? → deferred to Evidence Ladder tier 3 implementation.
- How should the UI present large evolved populations without overwhelming the user? → resolved directionally: small, legible, named populations are a product constraint (see Anti-Goals); champion view + species clustering addressed in M16.
- When the AI mutation advisor (M15) proposes a param change, how much rationale is enough for a user to make an informed approval decision?
- What is the minimum number of regime types that must be represented in a season before the fitness score is considered regime-credible?
- How should the confidence indicator degrade gracefully when a lineage has only one or two seasons of history?

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
- **Return-only optimization:** a fitness function that rewards only raw return will select for reckless, high-drawdown bots. The fitness model must penalize drawdown, inconsistency (cross-window variance), inactivity, and survival failure from the first generation — matching the engine's `FitnessResult` components.
- **Bot swarm illegibility:** large evolved populations can become unreadable — hundreds of near-identical bots with small parameter deltas and no clear champion narrative. Generation summaries, champion tracking, and lineage pruning are needed to keep the population interpretable.
- **Confusing backtest winners with paper/live-ready bots:** a bot that wins in simulation against historical data is not validated for live markets. Evolved bots must not be deployable to paper or live trading without a separate explicit approval step and a documented paper track record.
- **AI proposing plausible but unsafe parameter changes:** an LLM mutation advisor can generate confident-sounding but poorly grounded suggestions. Every AI suggestion must pass the validation layer and receive human approval before being applied — the AI is an advisor, not an executor.
- **Explainability debt:** as lineages grow, it becomes hard to trace why a bot has a given set of params. Lineage metadata, mutation summaries, and the genealogy UI are not optional polish — they are a correctness requirement for the evolution system.
- **Regime label gaming:** if regime labels are ever surfaced to strategies as inputs, selection pressure will produce bots that overfit to the label rather than the underlying market structure. Regime labels must remain post-hoc analytical tools; strategies must never see them during simulation.
- **Confidence conflation:** collapsing confidence indicators into a single number before the evidence model is mature will create a false sense of trustworthiness. Confidence must remain a bundle of labeled indicators until the model is validated across many real experiments.

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
- **M14 Slice 4A — Season Inspection & Fitness Transparency.** Per-window standings table, regime labels, per-bot fitness breakdown with component weights and tooltips, Δ vs. last generation diff.
- **M14 Slice 4B — Staged Advance: Preview Before Commit.** Separate review step between season complete and generation advance; proposed population summary; explicit commit button; cancel path.
- **M14 Slice 4C — Human Controls: Pin, Veto & Seed Re-roll.** User can force-survive or force-retire any bot; re-roll mutation seed to explore alternatives; all overrides recorded in lineage metadata.
- **M14 Slice 4D — Confidence Indicators, Regime Coverage & Evidence Ladder.** Per-bot evidence indicator bundle (seasons, regimes, generations survived); Evidence Ladder tier badges; tier advancement notifications; no synthetic confidence score.
