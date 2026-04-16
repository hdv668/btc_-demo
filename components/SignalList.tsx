'use client';

import { useState } from 'react';
import type { AnomalySignal, RiskControl } from '@/types';
import {
  TrendingUp, TrendingDown, ChevronDown, ChevronUp,
  Target, Shield, Clock, AlertTriangle, CheckCircle,
  Activity, BarChart2, Layers, Zap,
} from 'lucide-react';

interface Props {
  signals: AnomalySignal[];
  onSelect?: (signal: AnomalySignal) => void;
  selectedId?: string;
}

const GRADE_COLOR: Record<string, string> = {
  A: 'bg-red-500/20 text-red-400 border border-red-500/40',
  B: 'bg-orange-500/20 text-orange-400 border border-orange-500/40',
  C: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40',
};

const RISK_STATUS_COLOR: Record<string, string> = {
  ok: 'text-emerald-400',
  warning: 'text-yellow-400',
  breach: 'text-red-400',
};

const RISK_STATUS_ICON: Record<string, React.ReactNode> = {
  ok: <CheckCircle size={10} className="text-emerald-400 flex-shrink-0" />,
  warning: <AlertTriangle size={10} className="text-yellow-400 flex-shrink-0" />,
  breach: <AlertTriangle size={10} className="text-red-400 flex-shrink-0" />,
};

export default function SignalList({ signals, onSelect, selectedId }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState<Record<string, 'strategy' | 'greeks' | 'risk' | 'position'>>({});
  const [positiveEvOnly, setPositiveEvOnly] = useState(false);

  const displaySignals = positiveEvOnly
    ? signals.filter(s => (s.pnlEstimate.expectedValue ?? 0) > 0)
    : signals;

  if (!signals.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-500">
        <div className="text-3xl mb-3">🔍</div>
        <div className="text-sm">当前无异常信号</div>
        <div className="text-xs mt-1">所有期权定价与曲面偏差均在正常范围</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* ─── 筛选栏 ─── */}
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs text-slate-500">
          共 <span className="text-white font-semibold">{signals.length}</span> 个信号
          {positiveEvOnly && (
            <span className="ml-1 text-emerald-400">（正期望 {displaySignals.length} 个）</span>
          )}
        </span>
        <button
          onClick={() => setPositiveEvOnly(v => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-all border
            ${positiveEvOnly
              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-semibold'
              : 'bg-slate-800 text-slate-400 border-slate-700/50 hover:text-white'
            }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${positiveEvOnly ? 'bg-emerald-400' : 'bg-slate-500'}`} />
          仅看正期望
        </button>
      </div>

      {displaySignals.length === 0 && positiveEvOnly && (
        <div className="flex flex-col items-center justify-center py-10 text-slate-500">
          <div className="text-2xl mb-2">📊</div>
          <div className="text-sm">当前无正期望信号</div>
          <div className="text-xs mt-1">所有信号的期望值均为负，赔率不足</div>
        </div>
      )}

      {displaySignals.map(sig => {
        const isExp = expanded === sig.id;
        const isSelected = selectedId === sig.id;
        const isBump = sig.anomalyType === 'bump';
        const currentTab = tab[sig.id] ?? 'strategy';

        return (
          <div
            key={sig.id}
            className={`rounded-xl border transition-all
              ${isSelected ? 'border-blue-500/60 bg-blue-950/30' : 'border-slate-700/50 bg-slate-800/40 hover:border-slate-600'}`}
          >
            {/* ─── 摘要行 ─── */}
            <div
              className="flex items-center gap-3 px-4 py-3 cursor-pointer"
              onClick={() => { onSelect?.(sig); setExpanded(isExp ? null : sig.id); }}
            >
              {/* 方向图标 */}
              <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center
                ${isBump ? 'bg-red-500/20' : 'bg-emerald-500/20'}`}>
                {isBump
                  ? <TrendingDown size={15} className="text-red-400" />
                  : <TrendingUp size={15} className="text-emerald-400" />
                }
              </div>

              {/* 合约信息 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white text-sm">{sig.symbol}</span>
                  <span className="text-slate-400 text-xs">{sig.contract.expiry}</span>
                  <span className="text-slate-400 text-xs">
                    {sig.contract.optionType === 'call' ? 'Call' : 'Put'} K={sig.contract.strike.toLocaleString()}
                  </span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${GRADE_COLOR[sig.grade]}`}>{sig.grade}级</span>
                  {/* 凸起/凹陷标签 */}
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium
                    ${isBump ? 'bg-red-900/30 text-red-300 border border-red-700/30' : 'bg-emerald-900/30 text-emerald-300 border border-emerald-700/30'}`}>
                    {isBump ? '▲凸起' : '▼凹陷'}
                  </span>
                  {/* 无套利信号质量 */}
                  {sig.arbitrageCheck.confidence === 'high' && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-700/30">高置信</span>
                  )}
                  {sig.arbitrageCheck.hasArbitrage && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-orange-900/30 text-orange-300 border border-orange-700/30">数据疑问</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-400">
                  <span>
                    IV <span className="text-white">{(sig.contract.impliedVol! * 100).toFixed(1)}%</span>
                    → 拟合 <span className="text-sky-400">{((sig.surfacePoint.fittedVol ?? 0) * 100).toFixed(1)}%</span>
                  </span>
                  <span className={isBump ? 'text-red-400' : 'text-emerald-400'}>
                    {sig.ivDiff > 0 ? '+' : ''}{(sig.ivDiff * 100).toFixed(1)}pp
                  </span>
                  <span className="font-mono text-yellow-400">z={sig.zScore.toFixed(2)}</span>
                </div>
              </div>

              {/* 右侧：方向 + 盈亏比 */}
              <div className="flex-shrink-0 text-right">
                <div className={`text-xs font-semibold px-2 py-1 rounded
                  ${isBump ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                  {isBump ? '做空波动率' : '做多波动率'}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">RR {sig.strategy.riskRewardRatio.toFixed(1)}x</div>
                {/* 净边际标签 */}
                {sig.netEdge !== undefined && (
                  <div className={`text-xs mt-0.5 font-mono font-semibold ${
                    sig.slippageWarning ? 'text-orange-400' : sig.netEdge > 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {sig.slippageWarning ? '⚠ 价差过宽' : sig.netEdge > 0
                      ? `净边际 +${(sig.netEdge * 100).toFixed(1)}pp`
                      : `净边际 ${(sig.netEdge * 100).toFixed(1)}pp`}
                  </div>
                )}
              </div>

              <div className="flex-shrink-0 text-slate-500 ml-1">
                {isExp ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </div>
            </div>

            {/* ─── 展开详情 ─── */}
            {isExp && (
              <div className="border-t border-slate-700/50 px-4 pb-3">
                {/* Tab 导航 */}
                <div className="flex gap-1 pt-2 pb-3 border-b border-slate-800">
                  {([
                    ['strategy', '策略', <Target size={11} />],
                    ['greeks', 'Greeks', <Activity size={11} />],
                    ['risk', '风控', <Shield size={11} />],
                    ['position', '仓位', <Layers size={11} />],
                  ] as const).map(([id, label, icon]) => (
                    <button
                      key={id}
                      onClick={e => { e.stopPropagation(); setTab(t => ({ ...t, [sig.id]: id })); }}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs transition-all
                        ${currentTab === id ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-white'}`}
                    >
                      {icon}{label}
                    </button>
                  ))}
                </div>

                {/* ── 策略 Tab ── */}
                {currentTab === 'strategy' && (() => {
                  const s = sig.strategy;
                  const c = sig.contract;
                  const pnl = sig.pnlEstimate;
                  const isBumpTab = sig.anomalyType === 'bump';
                  const mktIV = (c.impliedVol! * 100).toFixed(1);
                  const fitIV = ((sig.surfacePoint.fittedVol ?? 0) * 100).toFixed(1);
                  const ivDiffPP = (sig.ivDiff * 100);
                  const ivDiffStr = ivDiffPP >= 0 ? `+${ivDiffPP.toFixed(1)}pp` : `${ivDiffPP.toFixed(1)}pp`;
                  const stopPct = Math.abs((s.stopLossPrice - s.entryPrice) / s.entryPrice * 100).toFixed(0);
                  const tgtPct  = Math.abs((s.targetPrice  - s.entryPrice) / s.entryPrice * 100).toFixed(0);

                  // 找止损 circuit_breaker 条件
                  const stopRule = s.riskControls.find(r => r.type === 'circuit_breaker' && r.label.includes('止损'));
                  const mktBreaker = s.riskControls.find(r => r.type === 'circuit_breaker' && r.label.includes('熔断'));

                  return (
                    <div className="pt-3 space-y-2">
                      {/* ── 结构化策略逻辑 ── */}
                      <div className="bg-slate-900/60 rounded-xl border border-slate-700/40 overflow-hidden">
                        {/* 行渲染helper */}
                        {([
                          {
                            label: '期权类型',
                            value: (
                              <span className={isBumpTab ? 'text-red-400 font-semibold' : 'text-emerald-400 font-semibold'}>
                                {s.action === 'SELL' ? '做空波动率（卖出期权）' : '做多波动率（买入期权）'}
                                　{c.optionType === 'call' ? 'Call' : 'Put'}
                                <span className="text-slate-400 font-normal font-sans">　（到期日 {c.expiry}）</span>
                              </span>
                            ),
                          },
                          {
                            label: '行权价 / 期权费',
                            value: (
                              <span className="text-white font-mono">
                                K = {c.strike.toLocaleString()}　入场 ${s.entryPrice.toFixed(2)}
                                　<span className="text-slate-400 font-sans text-xs">（止盈 ${s.targetPrice.toFixed(2)} +{tgtPct}% / 止损 ${s.stopLossPrice.toFixed(2)} -{stopPct}%）</span>
                              </span>
                            ),
                          },
                          {
                            label: '拟合偏差',
                            value: (
                              <span>
                                <span className={isBumpTab ? 'text-red-400' : 'text-emerald-400'}>
                                  {isBumpTab ? '【凸起·做空vol】' : '【凹陷·做多vol】'}
                                </span>
                                <span className="text-white"> IV={mktIV}% </span>
                                <span className="text-slate-400">{isBumpTab ? '高于' : '低于'}曲面拟合值 </span>
                                <span className="text-sky-400">{fitIV}%</span>
                                <span className="text-slate-400">（偏差 </span>
                                <span className={isBumpTab ? 'text-red-400 font-semibold' : 'text-emerald-400 font-semibold'}>{ivDiffStr}</span>
                                <span className="text-slate-400">，z=</span>
                                <span className="text-yellow-400 font-mono">{sig.zScore.toFixed(2)}</span>
                                <span className="text-slate-400">）</span>
                              </span>
                            ),
                          },
                          {
                            label: '净边际',
                            value: sig.netEdge !== undefined ? (
                              <span>
                                <span className="text-slate-400">半价差 </span>
                                <span className="text-slate-300 font-mono">{sig.spreadIV !== undefined ? `${(sig.spreadIV * 100).toFixed(1)}pp` : '-'}</span>
                                <span className="text-slate-400">　净利润空间 </span>
                                <span className={`font-semibold font-mono ${sig.netEdge > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {sig.netEdge > 0 ? '+' : ''}{(sig.netEdge * 100).toFixed(1)}pp
                                </span>
                                {sig.slippageWarning && (
                                  <span className="ml-2 px-1.5 py-0.5 rounded bg-orange-900/30 text-orange-300 border border-orange-700/30 font-semibold">
                                    ⚠ 价差过宽，慎执行
                                  </span>
                                )}
                                {!sig.slippageWarning && sig.netEdge > 0 && (
                                  <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-300 border border-emerald-700/30 font-semibold">
                                    ✓ 价差可覆盖
                                  </span>
                                )}
                              </span>
                            ) : <span className="text-slate-500">bid 为 0，无法估算执行成本</span>,
                          },
                          {
                            label: '偏差类型',
                            value: (
                              <span className={isBumpTab ? 'text-red-300' : 'text-emerald-300'}>
                                {isBumpTab ? '期权定价偏贵，存在卖出套利机会' : '期权定价偏便宜，存在买入套利机会'}
                              </span>
                            ),
                          },
                          {
                            label: '操作建议',
                            value: (
                              <span className="text-white">
                                {s.action === 'SELL' ? '卖出该期权收取 Theta' : '买入该期权等待 IV 回升'}，每日 Theta 收益{' '}
                                <span className="text-orange-400 font-semibold font-mono">
                                  ${Math.abs(c.theta! * (s.action === 'SELL' ? 1 : -1)).toFixed(2)}
                                </span>
                                {s.hedgeSuggestion && (
                                  <span className="text-slate-400">　· {s.hedgeSuggestion.split('：')[0]}</span>
                                )}
                              </span>
                            ),
                          },
                          {
                            label: '盈利预测',
                            value: (
                              <span>
                                <span className="text-slate-400">IV 回归后收益 </span>
                                <span className="text-emerald-400 font-semibold font-mono">${pnl.totalExpected.toFixed(2)}</span>
                                {pnl.profitReturnPct !== 0 && (
                                  <span className="text-emerald-300 font-mono ml-1">
                                    （+{pnl.profitReturnPct.toFixed(0)}%）
                                  </span>
                                )}
                                <span className="text-slate-400">　Vega P&amp;L </span>
                                <span className="text-emerald-400 font-mono">${pnl.vegaPnL.toFixed(2)}</span>
                                <span className="text-slate-400">　Theta({pnl.breakEvenDays}d 回本) </span>
                                <span className="text-orange-400 font-mono">${pnl.thetaPnL.toFixed(2)}</span>
                                <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-300 border border-emerald-700/30 font-semibold">
                                  胜率 {(pnl.winProbability * 100).toFixed(0)}%
                                </span>
                              </span>
                            ),
                          },
                          {
                            label: '期望值',
                            value: (() => {
                              const ev = pnl.expectedValue ?? (pnl.winProbability * pnl.profitReturnPct - pnl.lossProbability * pnl.maxLossPct);
                              const isPositive = ev >= 0;
                              return (
                                <span>
                                  <span className={`font-semibold font-mono text-sm ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {isPositive ? '+' : ''}{ev.toFixed(1)}%
                                  </span>
                                  <span className="text-slate-400 ml-2 text-xs">
                                    = 胜率{(pnl.winProbability * 100).toFixed(0)}% × 盈利{pnl.profitReturnPct.toFixed(0)}%
                                    {' − '}亏损率{(pnl.lossProbability * 100).toFixed(0)}% × 亏损{pnl.maxLossPct.toFixed(0)}%
                                  </span>
                                  <span className={`ml-2 px-1.5 py-0.5 rounded text-xs font-semibold border
                                    ${isPositive
                                      ? 'bg-emerald-900/30 text-emerald-300 border-emerald-700/30'
                                      : 'bg-red-900/30 text-red-300 border-red-700/30'
                                    }`}>
                                    {isPositive ? '正期望 ✓' : '负期望 ✗'}
                                  </span>
                                </span>
                              );
                            })(),
                          },
                          {
                            label: '亏损暴露',
                            value: (
                              <span>
                                <span className="text-slate-400">最大亏损 </span>
                                <span className="text-red-400 font-semibold font-mono">
                                  -{pnl.maxLossPct.toFixed(0)}%
                                </span>
                                <span className="text-slate-400">　每 1% IV 变动盈亏 </span>
                                <span className="text-red-400 font-semibold font-mono">${Math.abs(c.vega! * 100).toFixed(1)}</span>
                                {c.vanna != null && (
                                  <span className="text-slate-400">　Vanna <span className="font-mono text-slate-300">{c.vanna.toFixed(5)}</span></span>
                                )}
                                {c.volga != null && (
                                  <span className="text-slate-400">　Volga <span className="font-mono text-slate-300">{c.volga.toFixed(5)}</span></span>
                                )}
                                <span className="ml-2 px-1.5 py-0.5 rounded bg-red-900/30 text-red-300 border border-red-700/30 font-semibold">
                                  亏损概率 {(pnl.lossProbability * 100).toFixed(0)}%
                                </span>
                              </span>
                            ),
                          },
                          {
                            label: '离场 / 止损',
                            value: (
                              <span>
                                {stopRule && (
                                  <span className="text-red-300">{stopRule.value}</span>
                                )}
                                {mktBreaker && (
                                  <span className="text-slate-400">　· {mktBreaker.value}</span>
                                )}
                                {!stopRule && !mktBreaker && (
                                  <span className="text-slate-400">最多持仓 {s.maxHoldDays} 天，止损 -{stopPct}%</span>
                                )}
                              </span>
                            ),
                          },
                          {
                            label: '仓位建议',
                            value: <span className="text-slate-300">{s.sizeRecommendation}　· 最大持仓 <span className="text-white font-semibold">{s.maxHoldDays} 天</span></span>,
                          },
                        ] as { label: string; value: React.ReactNode }[]).map((row, i) => (
                          <div
                            key={i}
                            className={`flex gap-3 px-3 py-2 text-xs ${i % 2 === 0 ? 'bg-slate-900/30' : 'bg-transparent'} border-b border-slate-800/50 last:border-0`}
                          >
                            <span className="flex-shrink-0 w-20 text-slate-500 pt-px">{row.label}</span>
                            <span className="flex-1 leading-relaxed">{row.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* ── Greeks Tab ── */}
                {currentTab === 'greeks' && (
                  <div className="pt-3 space-y-3">
                    {/* 基础 Greeks */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[
                        { label: 'Delta', value: sig.contract.delta?.toFixed(4), desc: '∂C/∂S', color: 'text-blue-400' },
                        { label: 'Gamma', value: sig.contract.gamma?.toFixed(5), desc: '∂²C/∂S²', color: 'text-purple-400' },
                        { label: 'Vega', value: sig.contract.vega?.toFixed(4), desc: '∂C/∂σ per 1%', color: 'text-sky-400' },
                        { label: 'Theta', value: sig.contract.theta?.toFixed(4), desc: '∂C/∂t per day', color: 'text-orange-400' },
                      ].map(g => (
                        <div key={g.label} className="bg-slate-900/50 rounded-lg p-2">
                          <div className="text-slate-500 text-xs">{g.label}</div>
                          <div className={`font-mono text-sm font-semibold ${g.color}`}>{g.value ?? '-'}</div>
                          <div className="text-slate-600 text-xs">{g.desc}</div>
                        </div>
                      ))}
                    </div>
                    {/* 高阶 Greeks */}
                    <div>
                      <div className="text-xs text-slate-400 mb-2 font-medium flex items-center gap-1">
                        <Zap size={10} className="text-yellow-400" />高阶 Greeks（Vol Surface 套利专用）
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { label: 'Vanna', value: sig.contract.vanna?.toFixed(5), desc: '∂Delta/∂σ = ∂Vega/∂S\n标的价格变化对Vega的影响', color: 'text-yellow-400' },
                          { label: 'Volga', value: sig.contract.volga?.toFixed(5), desc: '∂²C/∂σ² Vega凸性\nIV大幅变化时盈亏加速', color: 'text-pink-400' },
                          { label: 'Charm', value: sig.contract.charm?.toFixed(5), desc: '∂Delta/∂t per day\n时间流逝对delta的影响', color: 'text-indigo-400' },
                        ].map(g => (
                          <div key={g.label} className="bg-slate-900/50 rounded-lg p-2">
                            <div className="text-slate-500 text-xs">{g.label}</div>
                            <div className={`font-mono text-sm font-semibold ${g.color}`}>{g.value ?? '-'}</div>
                            <div className="text-slate-600 text-xs whitespace-pre-line leading-tight">{g.desc}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    {/* P&L 路径 */}
                    <div>
                      <div className="text-xs text-slate-400 mb-2 font-medium">P&L 路径（Taylor 展开，IV回归至拟合值）</div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        {[
                          { label: 'Vega P&L', value: sig.pnlEstimate.vegaPnL, desc: 'Vega·ΔIV' },
                          { label: 'Volga P&L', value: sig.pnlEstimate.volgaPnL, desc: '½·Volga·ΔIV²' },
                          { label: 'Vanna P&L', value: sig.pnlEstimate.vannaPnL, desc: 'Vanna·ΔS·ΔIV' },
                          { label: 'Theta P&L', value: sig.pnlEstimate.thetaPnL, desc: 'Theta·持仓天数' },
                        ].map(p => (
                          <div key={p.label} className="bg-slate-900/40 rounded-lg p-2">
                            <div className="text-slate-400">{p.label}</div>
                            <div className={`font-semibold font-mono ${p.value >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {p.value >= 0 ? '+' : ''}${p.value.toFixed(2)}
                            </div>
                            <div className="text-slate-600">{p.desc}</div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 bg-slate-900/40 rounded-lg p-2 flex items-center justify-between text-xs">
                        <span className="text-slate-400">预期总收益（delta中性）</span>
                        <span className={`font-bold text-sm font-mono ${sig.pnlEstimate.totalExpected >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {sig.pnlEstimate.totalExpected >= 0 ? '+' : ''}${sig.pnlEstimate.totalExpected.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── 风控 Tab ── */}
                {currentTab === 'risk' && (
                  <div className="pt-3 space-y-2">
                    {/* 无套利检验 */}
                    <div className="bg-slate-900/50 rounded-lg p-3">
                      <div className="text-xs text-slate-400 mb-2 font-medium flex items-center gap-1">
                        <BarChart2 size={10} />无套利三重验证
                      </div>
                      <div className="space-y-1.5 text-xs">
                        <ArbitrageRow label="Put-Call Parity" ok={!sig.arbitrageCheck.pcpViolation}
                          detail={`偏差 $${sig.arbitrageCheck.pcpDiff.toFixed(3)}`} />
                        <ArbitrageRow label="蝶式凸性约束 ∂²C/∂K²≥0" ok={!sig.arbitrageCheck.butterflyViolation}
                          detail={sig.arbitrageCheck.butterflyViolation ? `套利量 $${sig.arbitrageCheck.butterflyAmount.toFixed(3)}` : '满足'} />
                        <ArbitrageRow label="日历价差单调性" ok={!sig.arbitrageCheck.calendarViolation}
                          detail={sig.arbitrageCheck.calendarDetail || '总方差 w(T) 单调递增'} />
                        <div className={`pt-1 font-medium ${sig.arbitrageCheck.confidence === 'high' ? 'text-emerald-400' : sig.arbitrageCheck.confidence === 'medium' ? 'text-yellow-400' : 'text-orange-400'}`}>
                          信号置信度：{sig.arbitrageCheck.confidence === 'high' ? '高（无套利约束均满足）' : sig.arbitrageCheck.confidence === 'medium' ? '中' : '低（存在套利疑问，注意数据质量）'}
                        </div>
                      </div>
                    </div>
                    {/* 风控检查项 */}
                    <div className="space-y-1.5">
                      {sig.strategy.riskControls.map((rc, i) => (
                        <div key={i} className="bg-slate-900/40 rounded-lg p-2.5 text-xs">
                          <div className="flex items-center gap-1.5 mb-1">
                            {RISK_STATUS_ICON[rc.status]}
                            <span className={`font-medium ${RISK_STATUS_COLOR[rc.status]}`}>{rc.label}</span>
                          </div>
                          <div className="text-slate-400 leading-relaxed">{rc.value}</div>
                        </div>
                      ))}
                    </div>
                    {/* 熔断说明 */}
                    <div className="bg-amber-950/30 border border-amber-800/30 rounded-lg p-2.5 text-xs text-amber-300">
                      <div className="font-medium mb-1 flex items-center gap-1"><AlertTriangle size={10} />熔断条件</div>
                      <div className="text-amber-400/80 leading-relaxed">
                        ① 浮亏超过期权费 150% → 立即止损<br />
                        ② 标的24h波动超过{sig.symbol === 'BTC' ? '15%' : '8%'} → 暂停开新仓<br />
                        ③ IV 单日涨幅 &gt; 30% → 全部平仓转现金<br />
                        ④ 组合净 Vega 超过总资产 2% → 停止加仓
                      </div>
                    </div>
                  </div>
                )}

                {/* ── 仓位 Tab ── */}
                {currentTab === 'position' && (
                  <div className="pt-3 space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                      {[
                        { label: '期权方向', value: `${sig.strategy.action} 1手`, color: isBump ? 'text-red-400' : 'text-emerald-400' },
                        { label: '标的对冲量', value: `${sig.position.underlyingUnits.toFixed(4)} 单位`, color: 'text-sky-400' },
                        { label: '净 Delta', value: sig.position.netDelta.toFixed(5), color: Math.abs(sig.position.netDelta) < 0.01 ? 'text-emerald-400' : 'text-yellow-400' },
                        { label: '净 Vega', value: sig.position.netVega.toFixed(4), color: 'text-purple-400' },
                        { label: '净 Gamma', value: sig.position.netGamma.toFixed(5), color: 'text-pink-400' },
                        { label: '净 Theta/天', value: `$${sig.position.netTheta.toFixed(3)}`, color: sig.position.netTheta > 0 ? 'text-emerald-400' : 'text-red-400' },
                      ].map(item => (
                        <div key={item.label} className="bg-slate-900/50 rounded-lg p-2">
                          <div className="text-slate-400">{item.label}</div>
                          <div className={`font-mono font-semibold text-sm ${item.color}`}>{item.value}</div>
                        </div>
                      ))}
                    </div>
                    <div className="bg-blue-950/30 border border-blue-800/30 rounded-lg p-2.5 text-xs text-blue-300">
                      <div className="font-medium mb-1">再平衡触发条件</div>
                      <div>标的价格变动 <span className="text-white font-mono">${sig.position.rebalanceThreshold.toFixed(0)}</span> 时，
                        delta 漂移 0.05，需要重新对冲（Gamma Scalping）</div>
                    </div>
                    <div className={`rounded-lg p-2.5 text-xs border
                      ${isBump ? 'bg-orange-950/30 border-orange-800/30 text-orange-300' : 'bg-slate-900/40 border-slate-700/40 text-slate-300'}`}>
                      <div className="font-medium mb-1">尾部风险对冲</div>
                      <div className="leading-relaxed">{sig.position.tailHedgeSuggestion}</div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── 子组件 ────────────────────────────────────────────────────────────
function MetricCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: string; sub: string; color: string;
}) {
  return (
    <div className="bg-slate-900/50 rounded-lg p-2.5">
      <div className="flex items-center gap-1 text-slate-400 text-xs mb-1">{icon}{label}</div>
      <div className={`font-semibold text-sm ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{sub}</div>
    </div>
  );
}

function ArbitrageRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-start gap-2">
      {ok
        ? <CheckCircle size={11} className="text-emerald-400 mt-0.5 flex-shrink-0" />
        : <AlertTriangle size={11} className="text-orange-400 mt-0.5 flex-shrink-0" />
      }
      <div>
        <span className={ok ? 'text-slate-300' : 'text-orange-300'}>{label}</span>
        <span className="text-slate-500 ml-2">{detail}</span>
      </div>
    </div>
  );
}
