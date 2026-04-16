/**
 * 无套利验证模块
 *
 * 三条经典无套利约束：
 *
 * 1. Put-Call Parity（PCP）
 *    C - P = S·e^{-qT} - K·e^{-rT}
 *    违反 → 套利方向明确（买便宜卖贵）
 *
 * 2. 蝶式凸性（Butterfly Convexity）
 *    对任意 K1 < K2 < K3 等间距：
 *    C(K1) - 2·C(K2) + C(K3) ≥ 0
 *    违反（负蝶式）→ 可以用 1蝶式期权 无风险套利
 *    等价偏微分约束：∂²C/∂K² ≥ 0（期权价格对行权价是凸函数）
 *
 * 3. 日历价差无套利
 *    同 strike，总方差 w(T) = σ²(K,T)·T 对 T 单调递增
 *    违反 → 近月期权比远月贵，存在日历价差套利
 *
 * 4. Dupire 条件（局部波动率非负性）
 *    σ²_local = (∂C/∂T) / (½·K²·∂²C/∂K²) ≥ 0
 *    等价于分子分母同号
 */

import type { OptionContract, ArbitrageCheck, IVSurfacePoint } from '@/types';
import { bsPrice } from './blackScholes';

const RISK_FREE = 0.05;

// ─── 1. Put-Call Parity ───────────────────────────────────────────────
export function checkPutCallParity(
  call: OptionContract,
  put: OptionContract,
): { violation: boolean; diff: number; absThreshold: number } {
  const S = call.underlyingPrice;
  const K = call.strike;
  const T = call.tte;
  const r = RISK_FREE;

  // 理论 PCP：C - P = S·e^{-qT} - K·e^{-rT}
  // （此处 q=0 对 BTC 近似成立；股票可用 q=连续股息率）
  const theoretical = S - K * Math.exp(-r * T);
  const actual = call.marketPrice - put.marketPrice;
  const diff = actual - theoretical;

  // 阈值：bid-ask spread 之和的一半（小于spread则为正常摩擦）
  const spreadCall = call.ask - call.bid;
  const spreadPut = put.ask - put.bid;
  const absThreshold = (spreadCall + spreadPut) / 2;

  return {
    violation: Math.abs(diff) > Math.max(absThreshold, call.underlyingPrice * 0.001),
    diff,
    absThreshold,
  };
}

// ─── 2. 蝶式凸性 ──────────────────────────────────────────────────────
/**
 * 检验同一到期日的期权是否满足凸性约束
 * 返回所有违反约束的三元组
 */
export function checkButterflyConvexity(
  contracts: OptionContract[],
  expiry: string,
  optionType: 'call' | 'put'
): { violation: boolean; maxViolation: number; arbitrageAmount: number } {
  const slice = contracts
    .filter(c => c.expiry === expiry && c.optionType === optionType)
    .sort((a, b) => a.strike - b.strike);

  if (slice.length < 3) return { violation: false, maxViolation: 0, arbitrageAmount: 0 };

  let maxViolation = 0;
  let totalArbitrage = 0;

  for (let i = 1; i < slice.length - 1; i++) {
    const K1 = slice[i - 1], K2 = slice[i], K3 = slice[i + 1];
    // 等间距归一化（使用线性插值）
    const dK1 = K2.strike - K1.strike;
    const dK2 = K3.strike - K2.strike;
    const w = dK1 / (dK1 + dK2); // 插值权重

    // 加权蝶式：C(K1)·(1-w) + C(K3)·w - C(K2) ≥ 0
    const butterfly = K1.marketPrice * (1 - w) + K3.marketPrice * w - K2.marketPrice;
    if (butterfly < -1e-4) {
      maxViolation = Math.min(maxViolation, butterfly);
      totalArbitrage += Math.abs(butterfly);
    }
  }

  return {
    violation: maxViolation < -1e-4,
    maxViolation,
    arbitrageAmount: totalArbitrage,
  };
}

// ─── 3. 日历价差无套利 ─────────────────────────────────────────────────
export function checkCalendarSpread(
  surfacePoints: IVSurfacePoint[],
  strike: number,
): { violation: boolean; detail: string } {
  // 找同一 strike 的所有到期切片，检验总方差单调性
  const byStrike = surfacePoints
    .filter(p => Math.abs(p.strike - strike) / strike < 0.02 && p.fittedVol)
    .sort((a, b) => a.tte - b.tte);

  if (byStrike.length < 2) return { violation: false, detail: '' };

  for (let i = 1; i < byStrike.length; i++) {
    const prev = byStrike[i - 1];
    const curr = byStrike[i];
    const wPrev = (prev.fittedVol ?? prev.impliedVol) ** 2 * prev.tte;
    const wCurr = (curr.fittedVol ?? curr.impliedVol) ** 2 * curr.tte;
    if (wCurr < wPrev - 1e-6) {
      return {
        violation: true,
        detail: `总方差倒挂：${prev.expiry} w=${wPrev.toFixed(4)} > ${curr.expiry} w=${wCurr.toFixed(4)}，strike≈${strike}`,
      };
    }
  }
  return { violation: false, detail: '' };
}

// ─── 综合无套利检验 ──────────────────────────────────────────────────
export function runArbitrageChecks(
  contract: OptionContract,
  contracts: OptionContract[],
  surfacePoints: IVSurfacePoint[],
): ArbitrageCheck {
  // 1. PCP
  let pcpViolation = false, pcpDiff = 0;
  const counterType = contract.optionType === 'call' ? 'put' : 'call';
  const counterPart = contracts.find(c =>
    c.expiry === contract.expiry &&
    Math.abs(c.strike - contract.strike) < 0.01 &&
    c.optionType === counterType
  );
  if (counterPart) {
    const call = contract.optionType === 'call' ? contract : counterPart;
    const put = contract.optionType === 'put' ? contract : counterPart;
    const pcp = checkPutCallParity(call, put);
    pcpViolation = pcp.violation;
    pcpDiff = pcp.diff;
  }

  // 2. 蝶式凸性
  const butterfly = checkButterflyConvexity(contracts, contract.expiry, contract.optionType);

  // 3. 日历价差
  const calendar = checkCalendarSpread(surfacePoints, contract.strike);

  const hasArbitrage = pcpViolation || butterfly.violation || calendar.violation;

  // 信号可信度：无套利违反时，IV 偏差更可信（是真的定价异常而非数据错误）
  // 有套利违反时，可能是数据质量问题
  const confidence: 'high' | 'medium' | 'low' = hasArbitrage
    ? 'low'
    : (pcpDiff === 0 ? 'high' : 'medium');

  return {
    pcpViolation,
    pcpDiff,
    butterflyViolation: butterfly.violation,
    butterflyAmount: butterfly.arbitrageAmount,
    calendarViolation: calendar.violation,
    calendarDetail: calendar.detail,
    hasArbitrage,
    confidence,
  };
}
