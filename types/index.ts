// ─── 期权基础数据结构 ───────────────────────────────────────────────
export interface OptionContract {
  symbol: string;
  expiry: string;
  strike: number;
  optionType: 'call' | 'put';
  marketPrice: number;
  underlyingPrice: number;
  volume: number;
  openInterest: number;
  bid: number;
  ask: number;
  impliedVol?: number;
  theoreticalPrice?: number;
  delta?: number;
  gamma?: number;
  vega?: number;
  theta?: number;
  // ── 高阶 Greeks ──
  vanna?: number;   // ∂²C/∂S∂σ = ∂Delta/∂σ
  volga?: number;   // ∂²C/∂σ²  = ∂Vega/∂σ
  charm?: number;   // ∂Delta/∂t（时间衰减对delta的影响）
  tte: number;
  moneyness: number;
}

// ─── 波动率曲面节点 ──────────────────────────────────────────────────
export interface IVSurfacePoint {
  expiry: string;
  strike: number;
  tte: number;
  moneyness: number;
  impliedVol: number;
  fittedVol?: number;
  residual?: number;
  zScore?: number;
  // 凸/凹标记
  anomalyType?: 'bump' | 'dip' | null; // bump=凸起, dip=凹陷
  // Dupire LocalVol 曲面异常检测
  localVol?: number;        // 该点实际 Dupire localVol（由散点 IV 反推）
  baselineLocalVol?: number; // SVI-implied localVol（作为光滑基准）
  lvResidual?: number;       // localVol - baselineLocalVol（绝对差）
  lvZScore?: number;         // 跨曲面归一化后的 z-score（主信号）
}

// ─── SVI 参数 ─────────────────────────────────────────────────────────
export interface SVIParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
  tte?: number; // 年化到期时间（前端生成曲面用）
}

// ─── 无套利检验结果 ──────────────────────────────────────────────────
export interface ArbitrageCheck {
  // Put-Call Parity
  pcpViolation: boolean;
  pcpDiff: number;          // C - P - (F·e^{-rT} - K·e^{-rT}) 偏差
  // 蝶式凸性（butterfly convexity）
  butterflyViolation: boolean;
  butterflyAmount: number;  // 负值 = 套利空间
  // 日历价差（calendar spread）
  calendarViolation: boolean;
  calendarDetail: string;
  // 综合
  hasArbitrage: boolean;
  confidence: 'high' | 'medium' | 'low'; // 信号可信度（无套利时更高）
}

// ─── 信号方向 ─────────────────────────────────────────────────────────
export type SignalDirection = 'long_vol' | 'short_vol';
export type AnomalyType = 'bump' | 'dip'; // bump=凸起(做空vol), dip=凹陷(做多vol)
export type AnomalyGrade = 'A' | 'B' | 'C';

// ─── P&L 路径估算 ────────────────────────────────────────────────────
export interface PnLEstimate {
  vegaPnL: number;        // Vega × ΔIV
  volgaPnL: number;       // ½ × Volga × (ΔIV)²
  vannaPnL: number;       // Vanna × ΔS/S × ΔIV
  thetaPnL: number;       // Theta × Δt（每天）
  totalExpected: number;  // 预期总P&L（IV回归至拟合值）
  breakEvenDays: number;  // theta 收益多少天覆盖建仓成本
  // ── 新增：百分比与概率 ──
  profitReturnPct: number;   // 盈利预测相对入场成本的百分比
  maxLossPct: number;        // 最大亏损相对入场成本的百分比
  winProbability: number;    // 盈利概率（0~1），基于 z-score 正态分布估算
  expectedValue: number;     // 期望值 = 胜率×盈利% - 亏损率×亏损%（正数才值得操作）
  lossProbability: number;   // 亏损概率（0~1）
}

// ─── Delta 中性仓位 ───────────────────────────────────────────────────
export interface DeltaNeutralPosition {
  optionContracts: number;   // 期权手数（方向=action）
  underlyingUnits: number;   // 标的对冲量（负=做空标的）
  netDelta: number;          // 建仓后净 delta（应≈0）
  netGamma: number;          // 净 gamma 暴露
  netVega: number;           // 净 vega 暴露
  netTheta: number;          // 净 theta（每天时间价值）
  rebalanceThreshold: number; // delta 偏移多少时需要再平衡
  tailHedgeSuggestion: string; // 尾部风险对冲建议
}

// ─── 异常信号 ─────────────────────────────────────────────────────────
export interface AnomalySignal {
  id: string;
  symbol: string;
  contract: OptionContract;
  surfacePoint: IVSurfacePoint;
  direction: SignalDirection;
  anomalyType: AnomalyType;  // 明确标注凸起/凹陷
  grade: AnomalyGrade;
  zScore: number;
  ivDiff: number;
  ivDiffPct: number;
  detectedAt: number;
  // ── 净边际（借鉴隧道模型）──────────────────────────────────────────
  // spreadIV     = (IV_ask - IV_bid) / 2  估算单边执行成本（IV 单位）
  // netEdge      = |ivDiff| - spreadIV    扣除执行成本后的真实利润空间
  // slippageWarn = spreadIV > |ivDiff| * 0.5  价差吃掉超过一半偏差时预警
  spreadIV?: number;         // 半价差（IV 单位，0~1）
  netEdge?: number;          // 净边际（负值 = 价差过宽，建议不执行）
  slippageWarning?: boolean; // 滑点预警
  // 无套利检验
  arbitrageCheck: ArbitrageCheck;
  // 策略
  strategy: TradeStrategy;
  // P&L 路径
  pnlEstimate: PnLEstimate;
  // Delta 中性仓位
  position: DeltaNeutralPosition;
}

// ─── 交易策略 ─────────────────────────────────────────────────────────
export interface TradeStrategy {
  action: 'BUY' | 'SELL';
  entryPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  maxHoldDays: number;
  rationale: string;
  riskRewardRatio: number;
  sizeRecommendation: string;
  hedgeSuggestion?: string;
  // 风控条件
  riskControls: RiskControl[];
}

export interface RiskControl {
  type: 'greeks_limit' | 'circuit_breaker' | 'liquidity' | 'tail_hedge';
  label: string;
  value: string;
  status: 'ok' | 'warning' | 'breach';
}

// ─── 组合风控状态 ─────────────────────────────────────────────────────
export interface PortfolioRisk {
  netVega: number;
  netGamma: number;
  netDelta: number;
  netTheta: number;
  vegaBudgetUsed: number;    // 0~1
  gammaBudgetUsed: number;
  circuitBreakerTriggered: boolean;
  circuitBreakerReason?: string;
  tailHedgeCost: number;     // 尾部对冲建议成本占比
}

// ─── 数据源 ───────────────────────────────────────────────────────────
export type DataSource = 'deribit' | 'polygon' | 'mock';

export interface MarketSnapshot {
  symbol: string;
  source: DataSource;
  underlyingPrice: number;
  fetchedAt: number;
  contracts: OptionContract[];
}

// ─── 曲面分析结果 ──────────────────────────────────────────────────────
export interface SurfaceAnalysis {
  symbol: string;
  source: DataSource;           // 数据来源（deribit / polygon / mock）
  analysedAt: number;
  underlyingPrice: number;
  surfacePoints: IVSurfacePoint[];
  anomalies: AnomalySignal[];
  sviParams: Record<string, SVIParams>;
  statsPerSlice: Record<string, SliceStats>;
  portfolioRisk: PortfolioRisk;
  // 局部波动率曲面（Dupire）
  localVolSurface: LocalVolPoint[];
}

export interface SliceStats {
  expiry: string;
  tte: number;
  atmVol: number;
  skew: number;
  kurtosis: number;
  rmse: number;
  // 无套利状态
  hasArbitrageViolation: boolean;
}

// ─── Dupire 局部波动率点 ──────────────────────────────────────────────
export interface LocalVolPoint {
  strike: number;
  tte: number;
  localVol: number;           // SVI-implied 局部波动率（光滑基准曲面）
  // 以下字段在散点匹配后填充
  impliedLocalVol?: number;   // 由散点 IV 直接 Dupire 反推的 localVol
  lvResidual?: number;        // impliedLocalVol - localVol
  lvZScore?: number;          // 跨曲面归一化 z-score
}
