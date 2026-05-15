// ─── Candle / Dataset ───────────────────────────────────────────────────────

export interface Candle {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DatasetManifest {
  symbol: string;
  timeframe: string; // e.g. "1d"
  source: string;
  startDate: string; // ISO date
  endDate: string;
  candleCount: number;
}

export interface Dataset {
  manifest: DatasetManifest;
  candles: Candle[];
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface SimulationConfig {
  startingCash: number;
  feeBps: number;       // fee in basis points, e.g. 5 = 0.05%
  slippageBps: number;  // slippage in basis points
  seed: number;         // for deterministic random strategies
}

// ─── Orders ─────────────────────────────────────────────────────────────────

export type OrderSide = "buy" | "sell";

export type OrderIntentSize =
  | { type: "quantity"; quantity: number }
  | { type: "targetAllocation"; fraction: number } // 0..1 of total equity
  | { type: "sellPercent"; fraction: number }       // 0..1 of current position
  | { type: "closePosition" };

export interface OrderIntent {
  side: OrderSide;
  symbol: string;
  size: OrderIntentSize;
}

export interface ExecutionFill {
  side: OrderSide;
  symbol: string;
  quantity: number;
  price: number;      // fill price after slippage
  fee: number;        // fee in cash
  timestamp: number;
}

// ─── Portfolio ───────────────────────────────────────────────────────────────

export interface Position {
  symbol: string;
  quantity: number;
  avgCost: number;    // average cost basis per share
}

export interface PortfolioSnapshot {
  cash: number;
  positions: Position[];
  equity: number;     // cash + market value of all positions
  realizedPnl: number;
  unrealizedPnl: number;
  exposure: number;   // fraction of equity in positions (0..1)
}

// ─── Strategies ──────────────────────────────────────────────────────────────

export interface StrategyContext {
  symbol: string;
  candle: Candle;
  candleIndex: number;
  allCandles: readonly Candle[];  // only candles up to and including current index
  portfolio: PortfolioSnapshot;
  botState: Record<string, unknown>;
  config: SimulationConfig;
  seed: number;
}

export type StrategyFn = (ctx: StrategyContext) => OrderIntent | null;

export interface StrategyDefinition {
  name: string;
  fn: StrategyFn;
  defaultParams?: Record<string, unknown>;
}

// ─── Bot ─────────────────────────────────────────────────────────────────────

export interface BotSpec {
  id: string;
  name: string;
  strategy: StrategyDefinition;
  params?: Record<string, unknown>;
}

export interface BotInstance {
  spec: BotSpec;
  portfolio: PortfolioSnapshot;
  positions: Map<string, Position>;
  cash: number;
  realizedPnl: number;
  state: Record<string, unknown>;
  trades: Trade[];
  fillHistory: ExecutionFill[];
  /** Mark-to-market equity recorded once per candle close — used for drawdown and equity curves. */
  equityHistory: number[];
}

// ─── Trades ──────────────────────────────────────────────────────────────────

export interface Trade {
  id: string;
  symbol: string;
  entryTimestamp: number;
  entryPrice: number;
  entryQuantity: number;
  exitTimestamp?: number;
  exitPrice?: number;
  exitQuantity?: number;
  realizedPnl?: number;
  status: "open" | "closed";
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type ArenaEventType =
  | "CANDLE_OPEN"
  | "ORDER_INTENT"
  | "ORDER_FILL"
  | "ORDER_REJECTED"
  | "PORTFOLIO_UPDATE"
  | "MATCH_START"
  | "MATCH_END"
  | "WARNING";

export interface ArenaEvent {
  type: ArenaEventType;
  timestamp: number;
  candleIndex: number;
  botId: string | null;
  payload: Record<string, unknown>;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export interface MetricSnapshot {
  botId: string;
  botName: string;
  totalReturn: number;        // (finalEquity - startCash) / startCash
  finalEquity: number;
  maxDrawdown: number;        // worst peak-to-trough as fraction (0..1)
  winRate: number;            // closed winning trades / total closed trades
  tradeCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  rank: number;
}

// ─── Simulation Run ───────────────────────────────────────────────────────────

export interface SimulationSnapshot {
  candleIndex: number;
  timestamp: number;
  bots: BotInstance[];
  events: ArenaEvent[];
  isComplete: boolean;
}
