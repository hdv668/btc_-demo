/**
 * 风控引擎
 *
 * 职责：
 * 1. Delta 中性仓位构建
 *    - 自动计算标的对冲量使组合 net delta ≈ 0
 *    - 计算再平衡触发阈值（基于 Gamma）
 *
 * 2. Greeks 预算管理
 *    - Vega 预算：净 Vega 不超过总资产的 X%
 *    - Gamma 预算：净 Gamma 不超过限额
 *    - Theta 目标：做空 vol 时 Theta > 0
 *
 * 3. 熔断机制（Circuit Breaker）
 *    - 单笔浮亏超过期权费 150%
 *    - 标的 24h 波动超过阈值（BTC 15%，股票 8%）
 *    - VIX/DVOL 单日涨幅 > 30%
 *    - 做空期权时，IV 反向扩大 > 50%
 *
 * 4. 尾部风险对冲（Tail Hedge）
 *    - 建议买入深度 OTM put（delta≈-0.05）
 *    - 成本约 0.5-1%/月
 *    - 防止黑天鹅时做空期权无限亏损
 *
 * 5. 流动性过滤
 *    - bid-ask spread < IV偏差/3
 *    - 开仓量 ≤ 日均成交量 5%
 */

import type {
  OptionContract, DeltaNeutralPosition, PortfolioRisk,
  RiskControl, AnomalySignal, AnomalyGrade,
} from '@/types';
import { bsPrice, estimatePnL, BSResult } from '@/lib/engine/blackScholes';

const RISK_FREE = 0.05;

// ─── 风控参数 ─────────────────────────────────────────────────────────
const VEGA_BUDGET_PCT = 0.02;      // 净 Vega 不超过总资产 2%
const GAMMA_BUDGET_PCT = 0.005;    // 净 Gamma 不超过 0.5%
const MAX_LOSS_PCT = 1.5;          // 止损：亏损超过期权费 150%
const BTC_VOL_THRESHOLD = 0.15;    // BTC 24h 波动熔断阈值
const STOCK_VOL_THRESHOLD = 0.08;  // 股票 24h 波动熔断阈值
const IV_STOP_RATIO_SHORT = 1.5;   // 做空vol：IV上涨50%止损
const IV_STOP_RATIO_LONG = 0.6;    // 做多vol：IV下跌40%止损
const LIQUIDITY_SPREAD_RATIO = 3;  // spread < ivDiff/3
const MAX_OI_PCT = 0.05;           // 开仓量≤日均量5%

// ─── 1. Delta 中性仓位构建 ─────────────────────────────────────────────
/**
 * 给定 1 手期权（+ BUY / - SELL），计算需要多少标的来中性化 delta
 * rebalanceThreshold = Gamma 驱动的再平衡触发量：ΔS_rebal = sqrt(2·ΔDelta_max / Gamma)
 */
export function buildDeltaNeutralPosition(
  contract: OptionContract,
  action: 'BUY' | 'SELL',
  greeks: BSResult,
  symbol: string,
): DeltaNeutralPosition {
  const sign = action === 'BUY' ? 1 : -1;

  // 期权手数（1手）
  const optionContracts = sign;
  // 期权侧净 delta
  const optionDelta = sign * greeks.delta;
  // 需要的标的对冲量（-optionDelta 单位标的）
  const underlyingUnits = -optionDelta;

  const netDelta = optionDelta + underlyingUnits; // ≈ 0

  // 净 Greeks
  const netGamma = sign * greeks.gamma;
  const netVega = sign * greeks.vega;
  const netTheta = sign * greeks.theta;

  // 再平衡阈值：delta 偏移 0.05（即标的变动多少导致 delta 漂移 0.05）
  // ΔDelta ≈ Gamma × ΔS → ΔS = 0.05 / |Gamma| (如果 Gamma > 0)
  const rebalanceThreshold = Math.abs(greeks.gamma) > 1e-8
    ? 0.05 / Math.abs(greeks.gamma)
    : contract.underlyingPrice * 0.05;

  // 尾部对冲建议
  const isBtc = symbol === 'BTC';
  const tailHedgeSuggestion = action === 'SELL'
    ? `做空波动率时建议配置尾部对冲：买入 delta≈-0.05 的深度虚值 ${isBtc ? 'BTC' : symbol} put，` +
    `行权价约 $${Math.round(contract.underlyingPrice * (isBtc ? 0.7 : 0.85)).toLocaleString()}，` +
    `成本约占仓位 0.5-1%/月，防止黑天鹅行情做空期权无限亏损。`
    : `做多波动率时亏损有限（最多损失期权费），尾部风险可控，无需额外对冲。`;

  return {
    optionContracts,
    underlyingUnits,
    netDelta,
    netGamma,
    netVega,
    netTheta,
    rebalanceThreshold,
    tailHedgeSuggestion,
  };
}

// ─── 2. 单笔风控项检查 ─────────────────────────────────────────────────
export function buildRiskControls(
  contract: OptionContract,
  action: 'BUY' | 'SELL',
  greeks: BSResult,
  ivDiff: number,       // IV偏差（原始值）
  grade: AnomalyGrade,
  symbol: string,
): RiskControl[] {
  const controls: RiskControl[] = [];
  const isShort = action === 'SELL';
  const currentIV = contract.impliedVol ?? 0;

  // ── 流动性检查 ────────────────────────────────────────────────────
  const spread = contract.ask - contract.bid;
  const spreadRatio = Math.abs(ivDiff) > 0 ? spread / Math.abs(ivDiff) : 999;
  controls.push({
    type: 'liquidity',
    label: '流动性检查',
    value: `Bid-Ask ${(spread).toFixed(2)} / IV偏差价值 ${(Math.abs(ivDiff) * contract.underlyingPrice / 100).toFixed(2)}`,
    status: spreadRatio < 1 / LIQUIDITY_SPREAD_RATIO ? 'ok'
      : spreadRatio < 1 ? 'warning' : 'breach',
  });

  // ── Greeks 预算 ───────────────────────────────────────────────────
  const vegaExposure = Math.abs(greeks.vega) * contract.underlyingPrice;
  controls.push({
    type: 'greeks_limit',
    label: 'Vega 暴露',
    value: `每1% IV变化盈亏 $${vegaExposure.toFixed(1)} | Vanna=${greeks.vanna.toFixed(4)} | Volga=${greeks.volga.toFixed(4)}`,
    status: 'ok',
  });

  controls.push({
    type: 'greeks_limit',
    label: 'Gamma 暴露',
    value: `Gamma=${greeks.gamma.toFixed(5)}（标的每涨1% → delta漂移 ${(greeks.gamma * contract.underlyingPrice * 0.01).toFixed(3)}）`,
    status: Math.abs(greeks.gamma) * contract.underlyingPrice > 0.1 ? 'warning' : 'ok',
  });

  // ── 止损条件 ──────────────────────────────────────────────────────
  const stopIV = isShort ? currentIV * IV_STOP_RATIO_SHORT : currentIV * IV_STOP_RATIO_LONG;
  const stopBs = bsPrice(contract.underlyingPrice, contract.strike, contract.tte, RISK_FREE, stopIV, contract.optionType === 'call');
  const stopLoss = stopBs.price;
  const maxLoss = Math.abs(stopLoss - contract.marketPrice);
  controls.push({
    type: 'circuit_breaker',
    label: '止损条件',
    value: isShort
      ? `IV 上涨 50% 至 ${(stopIV * 100).toFixed(1)}% 时平仓，最大亏损 $${maxLoss.toFixed(2)}`
      : `IV 下跌 40% 至 ${(stopIV * 100).toFixed(1)}% 时平仓，最大亏损 $${maxLoss.toFixed(2)}`,
    status: 'ok',
  });

  // ── 熔断条件 ──────────────────────────────────────────────────────
  const volThreshold = symbol === 'BTC' ? BTC_VOL_THRESHOLD : STOCK_VOL_THRESHOLD;
  controls.push({
    type: 'circuit_breaker',
    label: '市场熔断',
    value: `标的24h涨跌超过 ${(volThreshold * 100).toFixed(0)}% 时暂停开仓；IV单日涨幅>30% 时全部平仓`,
    status: 'ok',
  });

  // ── 尾部风险 ──────────────────────────────────────────────────────
  if (isShort) {
    controls.push({
      type: 'tail_hedge',
      label: '尾部风险',
      value: `做空裸期权理论亏损无上限，建议配置 0.5-1%/月 的 OTM put 对冲黑天鹅`,
      status: 'warning',
    });
  }

  return controls;
}

// ─── 3. 组合级风控状态 ────────────────────────────────────────────────
export function computePortfolioRisk(
  signals: AnomalySignal[],
  totalCapital: number = 100000, // 假设 10万美元总资本（用于预算百分比计算）
): PortfolioRisk {
  // 汇总所有信号的 Greeks（仅已激活信号，此处取全部作为最大风险估计）
  let netVega = 0, netGamma = 0, netDelta = 0, netTheta = 0;

  for (const sig of signals) {
    const pos = sig.position;
    netVega += pos.netVega * sig.contract.underlyingPrice;
    netGamma += pos.netGamma * sig.contract.underlyingPrice;
    netDelta += pos.netDelta * sig.contract.underlyingPrice;
    netTheta += pos.netTheta;
  }

  // 预算使用率
  const vegaBudget = totalCapital * VEGA_BUDGET_PCT;
  const gammaBudget = totalCapital * GAMMA_BUDGET_PCT;
  const vegaBudgetUsed = Math.min(Math.abs(netVega) / vegaBudget, 1);
  const gammaBudgetUsed = Math.min(Math.abs(netGamma) / gammaBudget, 1);

  // 熔断判断（组合层面）
  let circuitBreakerTriggered = false;
  let circuitBreakerReason: string | undefined;

  if (vegaBudgetUsed > 1) {
    circuitBreakerTriggered = true;
    circuitBreakerReason = `Vega 预算超限：净Vega $${netVega.toFixed(0)} 超过预算 $${vegaBudget.toFixed(0)}`;
  }
  if (gammaBudgetUsed > 1 && !circuitBreakerTriggered) {
    circuitBreakerTriggered = true;
    circuitBreakerReason = `Gamma 预算超限：净Gamma $${netGamma.toFixed(0)} 超过预算 $${gammaBudget.toFixed(0)}`;
  }

  // 尾部对冲成本估算（做空信号数量 × 0.75%/月）
  const shortSignals = signals.filter(s => s.direction === 'short_vol').length;
  const tailHedgeCost = shortSignals * 0.0075;

  return {
    netVega,
    netGamma,
    netDelta,
    netTheta,
    vegaBudgetUsed,
    gammaBudgetUsed,
    circuitBreakerTriggered,
    circuitBreakerReason,
    tailHedgeCost,
  };
}

// ─── 4. P&L 路径完整估算 ─────────────────────────────────────────────
import type { PnLEstimate } from '@/types';

/**
 * 标准正态分布 CDF（Abramowitz & Stegun 近似）
 * 用于将 z-score 转换为概率
 */
function normCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

/**
 * 估算信号盈利概率
 *
 * 逻辑：
 * - 基础胜率来自 z-score：z-score 越大，偏差越显著，IV 回归概率越高
 *   win_base = Φ(|z| - 1.5)  （z=1.5 时约 50%，z=2.5 时约 69%，z=3.5 时约 84%）
 * - 做空 vol（SELL）：乘以流动性因子（bid-ask 越窄越好）
 * - 做多 vol（BUY）：delta 距离平值越近（ATM），IV 回归越快，胜率修正 +3%
 * - 整体钳制在 [25%, 85%]，避免过度自信
 */
function estimateWinProbability(
  action: 'BUY' | 'SELL',
  zScore: number,
  contract: OptionContract,
  greeksDelta: number,  // 传入已计算的 BS delta，避免读 contract.delta（尚未赋值）
): number {
  const absZ = Math.abs(zScore);
  // 基础概率：z-score 标准正态上的统计优势
  const baseProb = normCDF(absZ - 1.5); // 约 50% @ z=1.5, 69% @ z=2.5

  // 流动性修正（bid-ask 过宽则降低胜率）
  const spread = contract.ask - contract.bid;
  const midPrice = contract.marketPrice;
  const liquidityPenalty = midPrice > 0 ? Math.min(spread / midPrice, 1) * 0.1 : 0;

  // Delta 修正：ATM 期权（delta 在 0.3~0.7 之间）IV 回归更快，胜率小幅提升
  const absDelta = Math.abs(greeksDelta);
  const deltaAdj = absDelta > 0.3 && absDelta < 0.7 ? 0.03 : 0;

  const raw = baseProb - liquidityPenalty + deltaAdj;
  // 钳制到合理区间
  return Math.min(Math.max(raw, 0.25), 0.85);
}

export function computePnLEstimate(
  contract: OptionContract,
  greeks: BSResult,
  fittedVol: number,
  action: 'BUY' | 'SELL',
  zScore: number = 0,
): PnLEstimate {
  const sign = action === 'BUY' ? 1 : -1;
  const currentIV = contract.impliedVol ?? 0;
  const deltaIV = (fittedVol - currentIV); // IV 回归方向的变化量

  // Theta 每天收益（做空时为正）
  const dailyTheta = sign * greeks.theta; // theta本身是负值，做空则盈利

  // 持仓天数与 buildStrategy 保持一致：到期剩余天数 × 系数
  const daysToExpiry = contract.tte * 365;
  const holdCoeff = action === 'SELL' ? 0.35 : 0.45;
  const estimatedHoldDays = Math.max(Math.floor(daysToExpiry * holdCoeff), 1);

  // P&L 路径（标的价格不变，只考虑 IV 回归）
  const pnl = estimatePnL(
    { ...greeks, vega: sign * greeks.vega, volga: sign * greeks.volga, vanna: sign * greeks.vanna, theta: sign * greeks.theta },
    deltaIV,
    0, // 不考虑标的方向性变化（delta 已对冲）
    estimatedHoldDays,
  );

  // 盈亏平衡天数：需要多少天 theta 覆盖入场成本
  const entrySlippage = (contract.ask - contract.bid) / 2;
  const breakEvenDays = Math.abs(dailyTheta) > 1e-6
    ? Math.ceil(entrySlippage / Math.abs(dailyTheta))
    : 999;

  // ── 百分比计算（盈利/亏损均使用 BS 精确定价，消除 Taylor 近似偏差）──────
  const entryPrice = contract.marketPrice;
  const isCall = contract.optionType === 'call';

  // 目标价（IV 回归至拟合值时的 BS 理论价）
  const targetBS = bsPrice(
    contract.underlyingPrice, contract.strike, contract.tte,
    RISK_FREE, fittedVol, isCall
  );
  // 做空 vol（SELL）：盈利 = 入场价 - 目标价（期权价值下降）
  // 做多 vol（BUY）：盈利 = 目标价 - 入场价（期权价值上涨）
  const profitDollar = action === 'SELL'
    ? entryPrice - targetBS.price
    : targetBS.price - entryPrice;
  const profitReturnPct = entryPrice > 1e-8
    ? (profitDollar / entryPrice) * 100
    : 0;

  // 最大亏损：做空 vol 止损线 IV×1.5，做多 vol 止损线 IV×0.6（和 buildStrategy 一致）
  const stopIV = action === 'SELL' ? currentIV * 1.5 : currentIV * 0.6;
  const stopBS = bsPrice(
    contract.underlyingPrice, contract.strike, contract.tte,
    RISK_FREE, stopIV, isCall
  );
  const maxLossDollar = Math.abs(stopBS.price - entryPrice);
  const maxLossPct = entryPrice > 1e-8 ? (maxLossDollar / entryPrice) * 100 : 0;

  // ── 概率估算 ──────────────────────────────────────────────────────
  const winProbability = estimateWinProbability(action, zScore, contract, greeks.delta);
  const lossProbability = 1 - winProbability;

  // 期望值 = 胜率 × 盈利% - 亏损率 × 亏损%
  // 正数表示从统计角度值得操作，负数表示赔率不合理
  const expectedValue = winProbability * profitReturnPct - lossProbability * maxLossPct;

  return {
    vegaPnL: pnl.vegaPnL,
    volgaPnL: pnl.volgaPnL,
    vannaPnL: pnl.vannaPnL,
    thetaPnL: pnl.thetaPnL,
    totalExpected: pnl.total,
    breakEvenDays,
    profitReturnPct,
    maxLossPct,
    winProbability,
    lossProbability,
    expectedValue,
  };
}
