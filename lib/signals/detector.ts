/**
 * 信号引擎 v2
 *
 * 完整链路：
 * 1. 快照 → IVSurfacePoint[]（含 call/put 分离 IV）
 * 2. SVI 曲面拟合 → 残差 + zScore
 * 3. 凸起/凹陷双向异常检测（bump / dip）
 * 4. 无套利三重验证（PCP + 蝶式 + 日历）
 * 5. 高阶 Greeks 计算（Vanna/Volga/Charm）
 * 6. P&L 路径 Taylor 展开估算
 * 7. Delta 中性仓位自动构建
 * 8. 风控项目检查（流动性/Greeks预算/熔断/尾部风险）
 * 9. Dupire 局部波动率曲面
 * 10. 组合级风控汇总
 */

import type {
  OptionContract, IVSurfacePoint, AnomalySignal, SurfaceAnalysis,
  SVIParams, MarketSnapshot, TradeStrategy, AnomalyGrade,
  SignalDirection, AnomalyType, SliceStats,
} from '@/types';
import { fitSurface, computeSliceStats } from '@/lib/engine/svi';
import { bsPrice, estimatePnL } from '@/lib/engine/blackScholes';
import { runArbitrageChecks } from '@/lib/engine/arbitrageCheck';
import { computeLocalVolSurface, computeLVResiduals } from '@/lib/engine/dupire';
import {
  buildDeltaNeutralPosition,
  buildRiskControls,
  computePortfolioRisk,
  computePnLEstimate,
} from '@/lib/signals/riskEngine';
import { nanoid } from 'nanoid';

const Z_THRESHOLD_A = 2.8;
const Z_THRESHOLD_B = 2.0;
const Z_THRESHOLD_C = 1.8;  // 提高C级阈值：减少噪音信号
const RISK_FREE = 0.05;

// 空间去重：同到期日内 moneyness 差值在此范围内视为"相邻点"
// 只保留其中 |zScore| 最大的一个
const SPATIAL_DEDUP_MONEYNESS = 0.30;

// ─── 评级 ─────────────────────────────────────────────────────────────
function gradeFromZ(absZ: number): AnomalyGrade | null {
  if (absZ >= Z_THRESHOLD_A) return 'A';
  if (absZ >= Z_THRESHOLD_B) return 'B';
  if (absZ >= Z_THRESHOLD_C) return 'C';
  return null;
}

// ─── 策略生成（完整版）────────────────────────────────────────────────
function buildStrategy(
  contract: OptionContract,
  direction: SignalDirection,
  zScore: number,
  fittedVol: number,
  symbol: string,
): TradeStrategy {
  const isCall = contract.optionType === 'call';
  const S = contract.underlyingPrice;
  const K = contract.strike;
  const T = contract.tte;
  const r = RISK_FREE;
  const currentIV = contract.impliedVol!;
  const entryPrice = contract.marketPrice;
  const action = direction === 'short_vol' ? 'SELL' : 'BUY';

  // 目标价：IV 回归拟合值
  const targetBS = bsPrice(S, K, T, r, fittedVol, isCall);
  const targetPrice = targetBS.price;

  // 止损 IV
  const stopIV = direction === 'short_vol'
    ? currentIV * 1.5
    : currentIV * 0.6;
  const stopBS = bsPrice(S, K, T, r, stopIV, isCall);
  const stopLossPrice = stopBS.price;

  const reward = Math.abs(targetPrice - entryPrice);
  const risk = Math.abs(stopLossPrice - entryPrice);
  const riskRewardRatio = risk > 1e-8 ? reward / risk : 0;

  // 持仓上限随到期日动态调整（T * 365 = 距到期天数）
  // 取到期剩余天数的 40%，无固定硬上限
  // 做空 vol 因 Theta 衰减加速，系数略小；做多 vol 需要等待回归，系数略大
  const daysToExpiry = T * 365;
  const holdCoeff = direction === 'short_vol' ? 0.35 : 0.45;
  const maxHoldDays = Math.max(Math.floor(daysToExpiry * holdCoeff), 1);

  // 高阶 Greeks 加入对冲说明
  const greeks = bsPrice(S, K, T, r, currentIV, isCall);
  const delta = greeks.delta;
  const vanna = greeks.vanna;
  const volga = greeks.volga;

  const hedgeSuggestion =
    `Delta=${delta.toFixed(3)}：${Math.abs(delta) > 0.05
      ? `${delta > 0 ? '做空' : '做多'} ${Math.abs(delta).toFixed(3)} 单位标的实现方向中性`
      : 'delta 接近零，无需对冲'
    }。` +
    `Vanna=${vanna.toFixed(4)}（标的价格对vega暴露的敏感度）；` +
    `Volga=${volga.toFixed(4)}（vega凸性，vol大幅变化时盈亏加速）。`;

  const absZ = Math.abs(zScore);
  const sizePct = absZ >= Z_THRESHOLD_A ? '2-3%' : absZ >= Z_THRESHOLD_B ? '1-2%' : '0.5-1%';
  const ivDiffPct = ((currentIV - fittedVol) / fittedVol * 100).toFixed(1);

  // 风控项目
  const riskControls = buildRiskControls(
    contract, action, greeks,
    currentIV - fittedVol,
    gradeFromZ(absZ)!,
    symbol,
  );

  let rationale = '';
  if (direction === 'short_vol') {
    rationale =
      `【凸起点·做空波动率】IV=${(currentIV * 100).toFixed(1)}% 高于曲面拟合值 ${(fittedVol * 100).toFixed(1)}%` +
      `（偏差 +${ivDiffPct}pp，z=${zScore.toFixed(2)}）。` +
      `期权定价偏贵，卖出该期权收取 theta：每日收益 $${Math.abs(greeks.theta).toFixed(2)}。` +
      `预期 IV 回归后收益 $${reward.toFixed(2)}（${(reward / entryPrice * 100).toFixed(0)}%）。` +
      `Vega 暴露：每1%IV变化盈亏 $${(Math.abs(greeks.vega) * S / 100).toFixed(1)}。`;
  } else {
    rationale =
      `【凹陷点·做多波动率】IV=${(currentIV * 100).toFixed(1)}% 低于曲面拟合值 ${(fittedVol * 100).toFixed(1)}%` +
      `（偏差 ${ivDiffPct}pp，z=${zScore.toFixed(2)}）。` +
      `期权定价偏便宜，买入该期权等待 IV 均值回归。` +
      `每1%IV上涨盈利 $${(greeks.vega * S / 100).toFixed(1)}（Vega收益）；` +
      `时间衰减成本 $${Math.abs(greeks.theta).toFixed(2)}/天，需在 ${maxHoldDays} 天内完成回归。`;
  }

  return {
    action,
    entryPrice,
    targetPrice,
    stopLossPrice,
    maxHoldDays,
    rationale,
    riskRewardRatio,
    sizeRecommendation: `建议仓位占总资金 ${sizePct}`,
    hedgeSuggestion,
    riskControls,
  };
}

// ─── 快照 → IVSurfacePoint[] ─────────────────────────────────────────
// BTC/ETH 等加密货币 IV 正常可达 80%~200%，股票期权通常 < 150%
const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'BNB']);

function contractsToSurfacePoints(contracts: OptionContract[]): IVSurfacePoint[] {
  const isCrypto = contracts.length > 0 && CRYPTO_SYMBOLS.has(contracts[0].symbol);
  const ivMax = isCrypto ? 3.0 : 1.5;  // 加密货币上限300%，股票150%

  return contracts
    .filter(c =>
      c.impliedVol &&
      c.impliedVol > 0.01 &&
      c.impliedVol < ivMax &&
      c.tte > 1 / 365 &&
      // 股票期权要求有 bid（流动性），加密货币允许用 mark_price（bid 可为0）
      (isCrypto ? c.marketPrice > 0 : c.bid > 0) &&
      Math.abs(c.moneyness) <= (isCrypto ? 3 : 2)   // 股票≤2σ，加密货币≤3σ
    )
    .map(c => ({
      expiry: c.expiry,
      strike: c.strike,
      tte: c.tte,
      moneyness: c.moneyness,
      impliedVol: c.impliedVol!,
    }));
}

// ─── 主分析函数 ───────────────────────────────────────────────────────
export function analyseSnapshot(snapshot: MarketSnapshot): SurfaceAnalysis {
  const { symbol, source, underlyingPrice, contracts, fetchedAt } = snapshot;

  // 1. IV 曲面点
  const rawPoints = contractsToSurfacePoints(contracts);

  // 2. SVI 拟合
  const { fittedPoints, sviParams } = fitSurface(rawPoints);

  // 2b. 计算每个切片的 SVI RMSE，用于后续 LV 信号降权
  //     RMSE 高 → SVI 拟合差 → LV 基准不可信 → 该切片 LV 信号权重降低
  const sliceRmse: Record<string, number> = {};
  const byExpiryForRmse = new Map<string, typeof fittedPoints>();
  for (const p of fittedPoints) {
    if (!byExpiryForRmse.has(p.expiry)) byExpiryForRmse.set(p.expiry, []);
    byExpiryForRmse.get(p.expiry)!.push(p);
  }
  for (const [expiry, pts] of byExpiryForRmse) {
    const residuals = pts.map(p => p.residual ?? 0);
    const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / Math.max(residuals.length, 1));
    sliceRmse[expiry] = rmse;
  }
  // RMSE 降权系数：RMSE < 2% → 权重 1.0；RMSE 4% → 权重 0.5；RMSE > 8% → 权重 0.1
  const lvWeightFromRmse = (expiry: string): number => {
    const rmse = sliceRmse[expiry] ?? 0;
    if (rmse < 0.02) return 1.0;
    if (rmse > 0.08) return 0.1;
    return 1.0 - 0.9 * (rmse - 0.02) / 0.06;
  };

  // 3. LocalVol 残差分析（含 RBF 平滑）
  //    - 散点有限差分 → impliedLocalVol（真实值）
  //    - RBF 平滑 impliedLocalVol → smoothedLV（消除差分噪音）
  //    - SVI 解析 baselineLocalVol（光滑基准）
  //    - relResidual = (smoothedLV - baseline) / baseline
  //    - lvZScore 用绝对阈值归一化（物理意义：相对偏差 20% ≈ 1σ）
  const pointsWithLV = computeLVResiduals(fittedPoints, underlyingPrice, sviParams);

  // 4. 标注凸起/凹陷
  //    改进：
  //    a. 两层 z-score 同向才激活 combinedZ
  //    b. LV 权重按 SVI RMSE 加权（拟合质量差的切片 LV 信号降权）
  const annotatedPoints: IVSurfacePoint[] = pointsWithLV.map(p => {
    const lvZ = p.lvZScore;
    const sviZ = p.zScore;

    const lvValid = lvZ !== undefined && isFinite(lvZ);
    const sviValid = sviZ !== undefined && isFinite(sviZ);

    // 该切片 LV 信号权重（SVI RMSE 越高 → LV 基准越不可信 → 权重越低）
    const lvW = lvWeightFromRmse(p.expiry);
    // SVI 权重固定 0.45，LV 权重最高 0.55 * lvW
    const wLV = 0.55 * lvW;
    const wSVI = 0.45;

    let combinedZ: number | undefined;
    if (lvValid && sviValid) {
      const sameDir = (lvZ! > 0 && sviZ! > 0) || (lvZ! < 0 && sviZ! < 0);
      if (sameDir) {
        combinedZ = (lvZ! * wLV + sviZ! * wSVI) / (wLV + wSVI);
      } else {
        // 方向相反：取较小绝对值并打折
        const smaller = Math.abs(lvZ!) < Math.abs(sviZ!) ? lvZ! : sviZ!;
        combinedZ = smaller * 0.4;
      }
    } else if (lvValid) {
      combinedZ = lvZ! * lvW; // LV 单独时也按质量加权
    } else {
      combinedZ = sviZ;
    }

    const anomalyType = combinedZ !== undefined
      ? (combinedZ >= Z_THRESHOLD_C ? 'bump'
        : combinedZ <= -Z_THRESHOLD_C ? 'dip'
          : null)
      : null;

    return { ...p, zScore: combinedZ, anomalyType };
  });

  // 4. Contract 索引
  const contractMap = new Map<string, OptionContract>();
  for (const c of contracts) {
    contractMap.set(`${c.expiry}-${c.strike}-${c.optionType}`, c);
  }

  // 5. 空间去重：同到期日内 moneyness 相邻的异常点只保留 |zScore| 最大的一个
  //    目的：避免同一个真实曲面凸起触发多个相邻 strike 的冗余信号
  const dedupedAnomalyPoints = spatialDedup(annotatedPoints);

  // 6. 异常检测 → 生成完整信号
  const anomalies: AnomalySignal[] = [];
  for (const fp of dedupedAnomalyPoints) {
    if (!fp.zScore || !fp.fittedVol || !fp.anomalyType) continue;
    const absZ = Math.abs(fp.zScore);
    let grade = gradeFromZ(absZ);
    if (!grade) continue;

    // lvZScore 有效时，若 lvZScore 绝对值更高，升级信号等级
    // 逻辑：SVI 残差 + LocalVol 残差同向且 lvZScore 超阈值 → 信号更可靠
    if (fp.lvZScore !== undefined && isFinite(fp.lvZScore)) {
      const absLvZ = Math.abs(fp.lvZScore);
      const sameDirection = (fp.zScore > 0 && fp.lvZScore > 0) || (fp.zScore < 0 && fp.lvZScore < 0);
      if (sameDirection) {
        if (absLvZ >= Z_THRESHOLD_A && grade !== 'A') grade = 'A';
        else if (absLvZ >= Z_THRESHOLD_B && grade === 'C') grade = 'B';
      }
    }

    for (const optionType of ['call', 'put'] as const) {
      const key = `${fp.expiry}-${fp.strike}-${optionType}`;
      const contract = contractMap.get(key);
      if (!contract?.impliedVol) continue;

      const direction: SignalDirection = fp.zScore > 0 ? 'short_vol' : 'long_vol';
      const anomalyType: AnomalyType = fp.zScore > 0 ? 'bump' : 'dip';
      const isCall = optionType === 'call';

      // 高阶 Greeks
      const greeks = bsPrice(
        contract.underlyingPrice, contract.strike, contract.tte,
        RISK_FREE, contract.impliedVol, isCall
      );

      // 无套利验证
      const arbitrageCheck = runArbitrageChecks(contract, contracts, annotatedPoints);

      // 策略
      const strategy = buildStrategy(contract, direction, fp.zScore, fp.fittedVol, symbol);

      // P&L 路径
      const pnlEstimate = computePnLEstimate(contract, greeks, fp.fittedVol, strategy.action, fp.zScore);

      // Delta 中性仓位
      const position = buildDeltaNeutralPosition(contract, strategy.action, greeks, symbol);

      // ── 净边际（参考隧道模型的 netEdge 概念）────────────────────────
      // 用 bid/ask 价差估算执行成本，扣除后才是真实利润空间
      // IV spread 估算：(ask_price - bid_price) / vega / underlyingPrice
      // vega 单位是"每1%IV变化时期权价格变化/标的价格"，此处用绝对 vega
      const vegaAbs = Math.abs(greeks.vega); // = ∂C/∂σ（IV以小数计）
      const priceMidAbs = Math.abs(fp.residual ?? 0); // IV 偏差（小数）
      let spreadIV: number | undefined;
      let netEdge: number | undefined;
      let slippageWarning: boolean | undefined;
      if (vegaAbs > 1e-8 && contract.ask > contract.bid && contract.bid > 0) {
        // 价差转为 IV 单位：spread_price / vega
        spreadIV = (contract.ask - contract.bid) / (2 * vegaAbs);
        netEdge = priceMidAbs - spreadIV;
        // 价差超过偏差的 50% → 执行成本过高
        slippageWarning = spreadIV > priceMidAbs * 0.5;
      }

      anomalies.push({
        id: nanoid(8),
        symbol,
        contract: {
          ...contract,
          delta: greeks.delta,
          gamma: greeks.gamma,
          vega: greeks.vega,
          theta: greeks.theta,
          vanna: greeks.vanna,
          volga: greeks.volga,
          charm: greeks.charm,
        },
        surfacePoint: fp,
        direction,
        anomalyType,
        grade,
        zScore: fp.zScore,
        ivDiff: fp.residual ?? 0,
        ivDiffPct: fp.fittedVol > 0 ? (fp.residual ?? 0) / fp.fittedVol : 0,
        detectedAt: fetchedAt,
        spreadIV,
        netEdge,
        slippageWarning,
        arbitrageCheck,
        strategy,
        pnlEstimate,
        position,
      });
    }
  }

  // 7. 切片统计（含无套利标记）
  const statsPerSlice: Record<string, SliceStats> = {};
  const byExpiry = new Map<string, IVSurfacePoint[]>();
  for (const fp of annotatedPoints) {
    if (!byExpiry.has(fp.expiry)) byExpiry.set(fp.expiry, []);
    byExpiry.get(fp.expiry)!.push(fp);
  }
  for (const [expiry, pts] of byExpiry) {
    const t = pts[0]?.tte ?? 0;
    const stats = computeSliceStats(pts, t, expiry, sviParams[expiry] ?? null);
    const hasArbitrageViolation = anomalies
      .filter(s => s.contract.expiry === expiry)
      .some(s => s.arbitrageCheck.hasArbitrage);
    statsPerSlice[expiry] = { ...stats, hasArbitrageViolation };
  }

  // 8. 排序：先按 grade（A>B>C），再按 |zScore|
  anomalies.sort((a, b) => {
    const gradeOrder = { A: 3, B: 2, C: 1 };
    const gd = gradeOrder[b.grade] - gradeOrder[a.grade];
    if (gd !== 0) return gd;
    return Math.abs(b.zScore) - Math.abs(a.zScore);
  });

  // 9. 组合风控
  const portfolioRisk = computePortfolioRisk(anomalies);

  // 10. SVI-implied LocalVol 基准曲面（用于 3D 渲染）
  const localVolSurface = computeLocalVolSurface(underlyingPrice, sviParams);

  return {
    symbol,
    source,
    analysedAt: Date.now(),
    underlyingPrice,
    surfacePoints: annotatedPoints,
    anomalies,
    sviParams,
    statsPerSlice,
    portfolioRisk,
    localVolSurface,
  };
}

// ─── 空间去重 ─────────────────────────────────────────────────────────
/**
 * 对同一到期日内 moneyness 相邻的异常点去重：
 *   1. 只考虑有 anomalyType（即 |zScore| >= 阈值）的点
 *   2. 按到期日分组，按 moneyness 排序
 *   3. 贪心：遍历时若当前点与上一个保留点的 moneyness 差 < 阈值，
 *      只保留 |zScore| 更大的那个
 *   4. 未触发异常（anomalyType=null）的点原样保留（用于统计）
 */
function spatialDedup(points: IVSurfacePoint[]): IVSurfacePoint[] {
  // 按到期日分组
  const byExpiry = new Map<string, IVSurfacePoint[]>();
  for (const p of points) {
    if (!byExpiry.has(p.expiry)) byExpiry.set(p.expiry, []);
    byExpiry.get(p.expiry)!.push(p);
  }

  const result: IVSurfacePoint[] = [];

  for (const [, slicePts] of byExpiry) {
    // 非异常点直接放入结果
    const normalPts = slicePts.filter(p => !p.anomalyType);
    result.push(...normalPts);

    // 异常点按 moneyness 排序，贪心去重
    const anomalyPts = slicePts
      .filter(p => !!p.anomalyType)
      .sort((a, b) => a.moneyness - b.moneyness);

    if (anomalyPts.length === 0) continue;

    // 同一 strike 下 call/put 先合并：取 |zScore| 最大的保留
    const byStrike = new Map<number, IVSurfacePoint>();
    for (const p of anomalyPts) {
      const cur = byStrike.get(p.strike);
      if (!cur || Math.abs(p.zScore ?? 0) > Math.abs(cur.zScore ?? 0)) {
        byStrike.set(p.strike, p);
      }
    }
    const dedupedByStrike = [...byStrike.values()].sort((a, b) => a.moneyness - b.moneyness);

    // 贪心空间去重（按 moneyness 距离）
    const kept: IVSurfacePoint[] = [];
    for (const p of dedupedByStrike) {
      if (kept.length === 0) {
        kept.push(p);
        continue;
      }
      const last = kept[kept.length - 1];
      if (Math.abs(p.moneyness - last.moneyness) < SPATIAL_DEDUP_MONEYNESS) {
        // 相邻：保留 |zScore| 更大的
        if (Math.abs(p.zScore ?? 0) > Math.abs(last.zScore ?? 0)) {
          kept[kept.length - 1] = p;
        }
      } else {
        kept.push(p);
      }
    }

    result.push(...kept);
  }

  return result;
}
