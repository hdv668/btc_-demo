'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import {
  Activity, RefreshCw, Wifi, WifiOff, TrendingUp, TrendingDown,
  BarChart2, Zap, Target, Shield, DollarSign, Percent, ChevronRight,
  Sliders, AlertTriangle, FlaskConical, Settings,
} from 'lucide-react';
import type { IVPoint, SurfaceResponse, TradeAnalysis } from '@/app/api/iv-surface/route';
import { ProxySettingsModal, useProxySettings } from '@/components/ProxySettings';

const IVSurface3D = dynamic(() => import('@/components/charts/IVSurface3D'), { ssr: false });

// ─── 检测参数状态 ───
interface DetectionParams {
  sigmaMultiplier: number;   // 0.5 ~ 3.0
  absPctThreshold: number;   // 0 ~ 50 (%)，显示用，传API时/100
  smoothLambda: number;      // 0 ~ 0.5（平滑因子）
}

const DEFAULT_PARAMS: DetectionParams = {
  sigmaMultiplier: 2.0,
  absPctThreshold: 10,
  smoothLambda: 0.05,
};

export default function Dashboard() {
  const [data, setData] = useState<SurfaceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<IVPoint | null>(null);
  const [showProxySettings, setShowProxySettings] = useState(false);
  const { getProxyUrl } = useProxySettings();

  // 检测参数
  const [params, setParams] = useState<DetectionParams>(DEFAULT_PARAMS);

  // 压力测试状态
  const [stressMode, setStressMode] = useState(false);
  const [stressActive, setStressActive] = useState(false); // 上一次请求是否用了压力测试

  // 参数输入缓冲（防止每次 keystroke 都发请求）
  const [absPctInput, setAbsPctInput] = useState(String(DEFAULT_PARAMS.absPctThreshold));
  const [lambdaInput, setLambdaInput] = useState(String(DEFAULT_PARAMS.smoothLambda));

  const fetchSurface = useCallback(async (p: DetectionParams, stress: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/iv-surface', window.location.origin);
      url.searchParams.set('sigma', String(p.sigmaMultiplier));
      url.searchParams.set('absPct', String(p.absPctThreshold / 100));
      url.searchParams.set('smooth', String(p.smoothLambda));
      if (stress) {
        url.searchParams.set('stress', '1');
        url.searchParams.set('stressCount', '5');
      }

      const headers: Record<string, string> = {};

      // 直接从 localStorage 读取，避免状态同步问题
      try {
        const saved = localStorage.getItem('btc-iv-proxy-settings');
        if (saved) {
          const settings = JSON.parse(saved);
          if (settings.enabled) {
            headers['x-proxy-url'] = `http://${settings.host}:${settings.port}`;
          }
        }
      } catch (e) {
        // 静默失败
      }

      const res = await fetch(url.toString(), { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json: SurfaceResponse = await res.json();
      setData(json);
      setStressActive(stress);
      setSelectedPoint(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSurface(params, false); }, [fetchSurface]);

  // σ 滑动条松开后立即刷新
  const handleSigmaChange = (v: number) => {
    const next = { ...params, sigmaMultiplier: v };
    setParams(next);
    fetchSurface(next, stressMode);
  };

  // 绝对百分比输入框失焦时刷新
  const handleAbsPctCommit = () => {
    const v = Math.min(50, Math.max(0, parseFloat(absPctInput) || 0));
    setAbsPctInput(String(v));
    const next = { ...params, absPctThreshold: v };
    setParams(next);
    fetchSurface(next, stressMode);
  };

  // 平滑因子输入框失焦时刷新
  const handleLambdaCommit = () => {
    const v = Math.min(0.5, Math.max(0, parseFloat(lambdaInput) || 0));
    setLambdaInput(String(v));
    const next = { ...params, smoothLambda: v };
    setParams(next);
    fetchSurface(next, stressMode);
  };

  // 压力测试按钮
  const handleStressTest = () => {
    const nextStress = !stressMode;
    setStressMode(nextStress);
    fetchSurface(params, nextStress);
  };

  const fetchedTime = data?.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString('zh-CN') : null;

  const ivMin = data ? Math.min(...data.points.map(p => p.iv)) * 100 : null;
  const ivMax = data ? Math.max(...data.points.map(p => p.iv)) * 100 : null;
  const sigPct = data ? (data.sigmaThreshold * 100).toFixed(1) : null;
  const expiryCount = data ? new Set(data.points.map(p => p.expiry)).size : null;

  const anomalies = data?.points.filter(p => p.anomalyType !== 'normal') ?? [];
  const stressInjected = data?.points.filter(p => p.stressInjected) ?? [];

  const sortedByEV = useMemo(() =>
    [...anomalies]
      .filter(p => p.tradeAnalysis)
      .sort((a, b) => (b.tradeAnalysis!.ev) - (a.tradeAnalysis!.ev)),
    [anomalies]
  );

  const handlePointClick = useCallback((pt: IVPoint) => {
    setSelectedPoint(prev => prev?.instrument === pt.instrument ? null : pt);
  }, []);

  const hasAnalysis = selectedPoint?.tradeAnalysis != null;
  const isOver = selectedPoint?.anomalyType === 'overpriced';

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col">

      {/* ─── Topbar ─── */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-screen-2xl mx-auto px-5 h-14 flex items-center gap-3">
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Activity size={14} className="text-white" />
            </div>
            <span className="font-bold text-sm text-white tracking-tight">VolSurface</span>
            <span className="text-slate-500 text-xs hidden sm:block">BTC 期权 IV 曲面 · 套利决策支持</span>
          </div>
          <div className="flex-1" />

          {data && !loading && (
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400">
              <Wifi size={11} className="text-emerald-400" />
              <span>{data.count} 合约 · {expiryCount} 个到期</span>
              <span className="text-slate-700">·</span>
              <span>{params.sigmaMultiplier}σ={sigPct}%</span>
              <span className="text-slate-700">·</span>
              <span>{fetchedTime}</span>
              {stressActive && (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="text-orange-400 font-medium flex items-center gap-0.5">
                    <FlaskConical size={10} />压力测试
                  </span>
                </>
              )}
            </div>
          )}
          {error && !loading && (
            <div className="flex items-center gap-1.5 text-xs text-red-400">
              <WifiOff size={11} /><span className="hidden sm:block">连接失败</span>
            </div>
          )}

          <button
            onClick={() => setShowProxySettings(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-500 transition-all flex-shrink-0"
          >
            <Settings size={11} />
            <span className="hidden sm:block">代理</span>
          </button>

          <button onClick={() => fetchSurface(params, stressMode)} disabled={loading}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-500 transition-all disabled:opacity-50 flex-shrink-0">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            <span className="hidden sm:block">{loading ? '加载中…' : '刷新'}</span>
          </button>
        </div>
      </header>

      {/* ─── 控制面板（检测参数调节区）─── */}
      <div className="max-w-screen-2xl mx-auto w-full px-5 pt-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2 flex-shrink-0">
            <Sliders size={13} className="text-blue-400" />
            <span className="text-xs font-semibold text-slate-300">检测参数</span>
          </div>

          {/* ─ σ 倍数滑动条 ─ */}
          <div className="flex items-center gap-3 min-w-[220px]">
            <span className="text-xs text-slate-500 whitespace-nowrap w-28">
              灵敏度 σ 倍数
              <span className="ml-1 text-white font-bold">{params.sigmaMultiplier.toFixed(1)}σ</span>
            </span>
            <input
              type="range"
              min="0.5" max="3.0" step="0.1"
              value={params.sigmaMultiplier}
              disabled={loading}
              onChange={e => setParams(p => ({ ...p, sigmaMultiplier: parseFloat(e.target.value) }))}
              onMouseUp={e => handleSigmaChange(parseFloat((e.target as HTMLInputElement).value))}
              onTouchEnd={e => handleSigmaChange(parseFloat((e.target as HTMLInputElement).value))}
              className="w-28 h-1.5 accent-blue-500 cursor-pointer disabled:opacity-40"
            />
            <div className="flex gap-1 text-xs text-slate-600">
              <span>0.5</span><span className="text-slate-700">–</span><span>3.0</span>
            </div>
          </div>

          {/* ─ 绝对百分比阈值 ─ */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 whitespace-nowrap">绝对偏离阈值</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min="0" max="50" step="1"
                value={absPctInput}
                disabled={loading}
                onChange={e => setAbsPctInput(e.target.value)}
                onBlur={handleAbsPctCommit}
                onKeyDown={e => e.key === 'Enter' && handleAbsPctCommit()}
                className="w-14 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white focus:border-blue-500 focus:outline-none disabled:opacity-40 text-right"
              />
              <span className="text-xs text-slate-500">%</span>
            </div>
            <span className="text-xs text-slate-600">（0=关闭）</span>
          </div>

          {/* ─ 平滑因子 ─ */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 whitespace-nowrap">曲面平滑 λ</span>
            <input
              type="number"
              min="0" max="0.5" step="0.01"
              value={lambdaInput}
              disabled={loading}
              onChange={e => setLambdaInput(e.target.value)}
              onBlur={handleLambdaCommit}
              onKeyDown={e => e.key === 'Enter' && handleLambdaCommit()}
              className="w-16 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white focus:border-blue-500 focus:outline-none disabled:opacity-40 text-right"
            />
            <span className="text-xs text-slate-600">（0=精确插值）</span>
          </div>

          <div className="flex-1" />

          {/* ─ 压力测试按钮 ─ */}
          <button
            onClick={handleStressTest}
            disabled={loading}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-all disabled:opacity-40 font-medium
              ${stressMode
                ? 'bg-orange-500/20 border-orange-600/60 text-orange-300 hover:bg-orange-500/30'
                : 'border-slate-700 text-slate-400 hover:border-orange-600/60 hover:text-orange-300'
              }`}
          >
            <FlaskConical size={12} />
            {stressMode ? '✓ 压力测试中' : '压力测试'}
          </button>
        </div>

        {/* 压力测试说明条 */}
        {stressActive && stressInjected.length > 0 && (
          <div className="mt-2 flex items-center gap-2 text-xs text-orange-300/80 bg-orange-950/30 border border-orange-800/30 rounded-lg px-3 py-1.5">
            <AlertTriangle size={12} className="text-orange-400 flex-shrink-0" />
            <span>
              已向 <strong className="text-orange-300">{stressInjected.length}</strong> 个合约注入 ±20% IV 人工扰动：
              {stressInjected.slice(0, 5).map((p, i) => (
                <span key={p.instrument} className="ml-1 font-mono">
                  {p.instrument}
                  <span className={p.stressAmt! > 0 ? 'text-red-400' : 'text-emerald-400'}>
                    ({p.stressAmt! > 0 ? '+' : ''}{(p.stressAmt! * 100).toFixed(0)}%)
                  </span>
                  {i < Math.min(stressInjected.length, 5) - 1 ? '，' : ''}
                </span>
              ))}
              {stressInjected.length > 5 && <span> 等</span>}
            </span>
          </div>
        )}
      </div>

      {/* ─── 统计卡片 ─── */}
      {data && (
        <div className="max-w-screen-2xl mx-auto w-full px-5 pt-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <StatCard label="BTC 现货价"
              value={`$${data.underlyingPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
              sub="Deribit 报价" color="text-white" />
            <StatCard label="IV 区间"
              value={ivMin != null ? `${ivMin.toFixed(0)}%–${ivMax!.toFixed(0)}%` : '—'}
              sub={`${params.sigmaMultiplier}σ 阈值 ±${sigPct}%`} color="text-sky-400" />
            <StatCard label="有效合约"
              value={data.count > 0 ? String(data.count) : '—'}
              sub={`λ=${params.smoothLambda} | abs≥${params.absPctThreshold}%`} color="text-slate-300" />
            <StatCard label="▲ 高估 Overpriced"
              value={String(data.overpricedCount)}
              sub={`bid IV > surf+${params.sigmaMultiplier}σ 或 abs>${params.absPctThreshold}%`} color="text-red-400"
              highlight={data.overpricedCount > 0}
              highlightColor="border-red-800/50 bg-red-950/20" />
            <StatCard label="▼ 低估 Underpriced"
              value={String(data.underpricedCount)}
              sub={`ask IV < surf−${params.sigmaMultiplier}σ 或 abs>${params.absPctThreshold}%`} color="text-emerald-400"
              highlight={data.underpricedCount > 0}
              highlightColor="border-emerald-800/50 bg-emerald-950/20" />
          </div>
        </div>
      )}

      {/* ─── 主内容区：左 70% 图表 + 右 30% 分析面板 ─── */}
      <div className="flex-1 flex max-w-screen-2xl mx-auto w-full px-5 py-4 gap-4 min-h-0">

        {/* ── 左侧 70%：3D 图表 ── */}
        <div className="flex flex-col gap-0 min-w-0" style={{ flex: '0 0 70%', maxWidth: '70%' }}>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 flex-1 min-h-[540px] flex flex-col overflow-hidden relative">
            {loading && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-slate-950/85 rounded-2xl">
                <div className="w-10 h-10 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
                <div className="text-sm text-slate-400">正在获取 Deribit 期权数据并计算 IV 基准曲面…</div>
                <div className="text-xs text-slate-600">
                  Newton-Raphson · 正则化 RBF (λ={params.smoothLambda}) · {params.sigmaMultiplier}σ+{params.absPctThreshold}% 双判定
                </div>
              </div>
            )}
            {error && !loading && (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400">
                <WifiOff size={28} className="text-slate-600" />
                <div className="text-sm text-red-400">{error}</div>
                <button onClick={() => fetchSurface(params, stressMode)}
                  className="text-xs px-4 py-2 rounded-lg border border-slate-700 hover:border-blue-500 hover:text-blue-400 transition-all">
                  重试
                </button>
              </div>
            )}
            {data && !loading && !error && (
              <div className="flex-1 min-h-0 p-2">
                <IVSurface3D
                  points={data.points}
                  sigmaThreshold={data.sigmaThreshold}
                  onPointClick={handlePointClick}
                  selectedInstrument={selectedPoint?.instrument}
                  sviParams={data.sviParams}
                  rndSlices={data.rndSlices}
                />
              </div>
            )}
            {!data && !loading && !error && (
              <div className="flex-1 flex items-center justify-center text-slate-600 text-sm">暂无数据</div>
            )}
          </div>

          {/* 图例 */}
          {data && (
            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-600/60 inline-block" /> 半透明曲面 = 正则化 RBF 基准（λ={params.smoothLambda}）</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-500/40 inline-block" /> 灰色小点 = 正常合约</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" /> 红色菱形 = 高估（点击分析）</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" /> 绿色菱形 = 低估（点击分析）</span>
              {stressActive && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-orange-400 inline-block" /> 橙色边框 = 压力注入点</span>}
            </div>
          )}

          {/* ── 底部：高价值机会清单（按 EV 排序）── */}
          {sortedByEV.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <Zap size={13} className="text-yellow-400" />
                <span className="text-sm font-semibold text-white">高价值机会清单</span>
                <span className="text-xs text-slate-500">按净期望值 EV 排序</span>
                {stressActive && (
                  <span className="text-xs text-orange-400/70 ml-1">
                    · 🔬 压力测试模式（{stressInjected.filter(p => p.anomalyType !== 'normal').length} 个扰动点被捕获）
                  </span>
                )}
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
                <div className="grid grid-cols-7 gap-0 px-3 py-2 text-xs text-slate-600 border-b border-slate-800 font-medium">
                  <span className="col-span-2">合约</span>
                  <span>方向</span>
                  <span>胜率</span>
                  <span>预期盈利</span>
                  <span>预期亏损</span>
                  <span className="text-right">净EV</span>
                </div>
                <div className="divide-y divide-slate-800/60">
                  {sortedByEV.slice(0, 8).map((p) => {
                    const ta = p.tradeAnalysis!;
                    const isO = p.anomalyType === 'overpriced';
                    const isStress = p.stressInjected;
                    return (
                      <button
                        key={p.instrument}
                        onClick={() => setSelectedPoint(prev =>
                          prev?.instrument === p.instrument ? null : p)}
                        className={`w-full grid grid-cols-7 gap-0 px-3 py-2.5 text-xs transition-all hover:bg-slate-800/40 text-left
                          ${selectedPoint?.instrument === p.instrument
                            ? isO ? 'bg-red-950/20' : 'bg-emerald-950/20'
                            : isStress ? 'bg-orange-950/10' : ''}`}
                      >
                        <span className="col-span-2 font-mono text-white truncate flex items-center gap-1">
                          {p.instrument}
                          {isStress && <FlaskConical size={9} className="text-orange-400 flex-shrink-0" />}
                        </span>
                        <span className={`font-medium ${isO ? 'text-red-400' : 'text-emerald-400'}`}>
                          {isO ? 'Short' : 'Long'}
                        </span>
                        <span className="text-slate-300">{(ta.winProb * 100).toFixed(0)}%</span>
                        <span className="text-emerald-400">+${ta.expectedProfit.toFixed(0)}</span>
                        <span className="text-red-400">-${ta.expectedLoss.toFixed(0)}</span>
                        <span className={`text-right font-bold ${ta.ev >= 0 ? 'text-yellow-400' : 'text-slate-500'}`}>
                          ${ta.ev.toFixed(0)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── 右侧 30%：交易分析面板 ── */}
        <div className="flex flex-col gap-3 min-w-0" style={{ flex: '0 0 30%', maxWidth: '30%' }}>

          <div className="flex items-center gap-2">
            <Target size={14} className="text-blue-400" />
            <span className="text-sm font-semibold text-white">交易分析面板</span>
            {selectedPoint && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium
                ${isOver ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                {isOver ? '↑ 高估' : '↓ 低估'}
              </span>
            )}
            {selectedPoint?.stressInjected && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300 font-medium flex items-center gap-1">
                <FlaskConical size={9} />扰动
              </span>
            )}
          </div>

          {!selectedPoint && data && anomalies.length > 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-6 flex flex-col items-center gap-3 text-center">
              <div className="w-10 h-10 rounded-full bg-slate-800/60 flex items-center justify-center">
                <ChevronRight size={18} className="text-slate-500" />
              </div>
              <p className="text-sm text-slate-400">点击 3D 图中的红/绿异常点</p>
              <p className="text-xs text-slate-600">或从下方清单中选择合约</p>
              <p className="text-xs text-slate-600">以查看深度交易分析报告</p>
            </div>
          )}

          {!selectedPoint && data && anomalies.length === 0 && !loading && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-6 flex flex-col items-center gap-3 text-center">
              <BarChart2 size={24} className="text-slate-700" />
              <p className="text-sm text-slate-500">当前市场定价高度一致</p>
              <p className="text-xs text-slate-600">
                未发现偏离 {params.sigmaMultiplier}σ 或绝对偏离 &gt;{params.absPctThreshold}% 的异常点
              </p>
              <p className="text-xs text-slate-700">可降低灵敏度阈值或点击"压力测试"</p>
            </div>
          )}

          {selectedPoint && hasAnalysis && (() => {
            const ta = selectedPoint.tradeAnalysis!;
            const resPct = (selectedPoint.residual * 100).toFixed(2);
            const ivMktPct = (selectedPoint.iv * 100).toFixed(2);
            const ivSurfPct = (selectedPoint.ivSurface * 100).toFixed(2);
            const ivBidPct = (selectedPoint.ivBid * 100).toFixed(2);
            const ivAskPct = (selectedPoint.ivAsk * 100).toFixed(2);
            const deviationPct = ((selectedPoint.residual / selectedPoint.ivSurface) * 100).toFixed(1);
            const tpIVPct = (ta.takeProfitIV * 100).toFixed(2);
            const slIVPct = (ta.stopLossIV * 100).toFixed(2);
            const tenorDays = (selectedPoint.tenor * 365).toFixed(0);

            // 判断该合约触发了哪种规则
            const absDev = Math.abs(selectedPoint.residual / selectedPoint.ivSurface) * 100;
            const sigmaRule = data && Math.abs(selectedPoint.residual) > data.sigmaThreshold;
            const absPctRule = absDev > params.absPctThreshold && params.absPctThreshold > 0;

            return (
              <div className="flex flex-col gap-3 overflow-y-auto max-h-[calc(100vh-10rem)]
                pr-0.5 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-slate-700">

                {/* 压力测试提示 */}
                {selectedPoint.stressInjected && (
                  <div className="rounded-xl border border-orange-700/40 bg-orange-950/30 p-2.5 flex items-center gap-2">
                    <FlaskConical size={12} className="text-orange-400 flex-shrink-0" />
                    <div className="text-xs text-orange-300">
                      <span className="font-semibold">压力注入：</span>
                      该合约 IV 被人工添加了
                      <span className={`font-bold ${selectedPoint.stressAmt! > 0 ? 'text-red-400' : 'text-emerald-400'} mx-1`}>
                        {selectedPoint.stressAmt! > 0 ? '+' : ''}{(selectedPoint.stressAmt! * 100).toFixed(0)}%
                      </span>
                      扰动，系统已正确识别并高亮
                    </div>
                  </div>
                )}

                {/* 触发规则标签 */}
                <div className="flex gap-1.5 flex-wrap">
                  {sigmaRule && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-700/30">
                      {params.sigmaMultiplier}σ 统计规则触发
                    </span>
                  )}
                  {absPctRule && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 border border-purple-700/30">
                      {absDev.toFixed(1)}% 绝对偏离触发
                    </span>
                  )}
                </div>

                {/* 合约概览 */}
                <Section
                  icon={<Activity size={12} />}
                  title="合约概览"
                  color={isOver ? 'text-red-400' : 'text-emerald-400'}
                >
                  <Row label="合约代码" value={selectedPoint.instrument} mono />
                  <Row label="行权价" value={`$${selectedPoint.strike.toLocaleString()}`} mono />
                  <Row label="到期日" value={selectedPoint.expiry} />
                  <Row label="剩余天数" value={`${tenorDays}d`} />
                </Section>

                {/* 定价状态 */}
                <Section
                  icon={<Percent size={12} />}
                  title="定价状态"
                  color={isOver ? 'text-red-400' : 'text-emerald-400'}
                >
                  <Row label="市场 IV" value={`${ivMktPct}%`} mono
                    valueColor={isOver ? 'text-red-300' : 'text-emerald-300'} />
                  <Row label="曲面基准 IV" value={`${ivSurfPct}%`} mono />
                  <Row label="统计偏离 ε" value={`${isOver ? '+' : ''}${resPct}%`} mono
                    valueColor={isOver ? 'text-red-400' : 'text-emerald-400'} />
                  <Row label="相对偏离" value={`${isOver ? '+' : ''}${deviationPct}%`} mono
                    valueColor={isOver ? 'text-red-400' : 'text-emerald-400'} />
                  <Row label="Bid IV" value={`${ivBidPct}%`} mono />
                  <Row label="Ask IV" value={`${ivAskPct}%`} mono />
                  <Row label="价差" value={`${(selectedPoint.spreadPct * 100).toFixed(1)}%`} />
                </Section>

                {/* 操作建议 */}
                <div className={`rounded-xl border p-3
                  ${isOver ? 'border-red-800/60 bg-red-950/25' : 'border-emerald-800/60 bg-emerald-950/25'}`}>
                  <div className={`text-xs font-semibold mb-1.5 flex items-center gap-1.5
                    ${isOver ? 'text-red-300' : 'text-emerald-300'}`}>
                    {isOver ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
                    操作建议
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {isOver
                      ? `该合约 IV 高估约 ${deviationPct}%，建议 Short Vega：以当前市价 $${ta.currentPrice.toFixed(2)} 卖出该 Call 期权，等待 IV 回归至曲面基准 ${ivSurfPct}%。`
                      : `该合约 IV 低估约 ${Math.abs(+deviationPct)}%，建议 Long Vega：以当前市价 $${ta.currentPrice.toFixed(2)} 买入该 Call 期权，等待 IV 回归至曲面基准 ${ivSurfPct}%。`
                    }
                  </p>
                </div>

                {/* 风控参数 */}
                <Section
                  icon={<Shield size={12} />}
                  title="风控参数"
                  color="text-yellow-400"
                >
                  <Row label="止盈位 IV" value={`${tpIVPct}%`} mono
                    valueColor="text-emerald-400"
                    sub="IV 回归至此处平仓" />
                  <Row label="止损位 IV" value={`${slIVPct}%`} mono
                    valueColor="text-red-400"
                    sub="偏离达 3.5σ 强制止损" />
                  <Row label="止盈目标价" value={`$${ta.targetPrice.toFixed(2)}`} mono
                    valueColor="text-emerald-400" />
                  <Row label="止损触发价" value={`$${ta.shockPrice.toFixed(2)}`} mono
                    valueColor="text-red-400" />
                </Section>

                {/* 盈亏预测 */}
                <Section
                  icon={<DollarSign size={12} />}
                  title="盈亏预测"
                  color="text-blue-400"
                >
                  <div className="mb-2">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-slate-500">回归胜率 P</span>
                      <span className="text-white font-bold">{(ta.winProb * 100).toFixed(1)}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-blue-600 to-emerald-500 transition-all"
                        style={{ width: `${ta.winProb * 100}%` }}
                      />
                    </div>
                    <div className="text-xs text-slate-600 mt-1">
                      P = Φ(|z|−1)，z = ε/σ = {Math.abs(selectedPoint.residual / (data?.residualSigma ?? 1)).toFixed(2)}
                    </div>
                  </div>

                  <Row label="当前期权价" value={`$${ta.currentPrice.toFixed(2)}`} mono />
                  <Row
                    label="预期盈利（回归）"
                    value={`+$${ta.expectedProfit.toFixed(2)}`}
                    mono
                    valueColor="text-emerald-400"
                    sub={`概率 ${(ta.winProb * 100).toFixed(0)}%`}
                  />
                  <Row
                    label="预期亏损（背离）"
                    value={`-$${ta.expectedLoss.toFixed(2)}`}
                    mono
                    valueColor="text-red-400"
                    sub={`概率 ${((1 - ta.winProb) * 100).toFixed(0)}%`}
                  />
                </Section>

                {/* 净期望值 EV */}
                <div className={`rounded-xl border p-3 ${ta.ev >= 0
                  ? 'border-yellow-700/50 bg-yellow-950/20'
                  : 'border-slate-700/50 bg-slate-900/30'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-yellow-300">
                      <Zap size={12} />
                      净期望值 EV
                    </div>
                    <span className={`text-lg font-bold ${ta.ev >= 0 ? 'text-yellow-400' : 'text-slate-500'}`}>
                      ${ta.ev.toFixed(2)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    EV = P × 盈利 − (1−P) × 亏损
                    = {(ta.winProb * 100).toFixed(0)}% × ${ta.expectedProfit.toFixed(0)}
                    − {((1 - ta.winProb) * 100).toFixed(0)}% × ${ta.expectedLoss.toFixed(0)}
                    = <span className={ta.ev >= 0 ? 'text-yellow-400 font-bold' : 'text-slate-400'}>
                      ${ta.ev.toFixed(2)}
                    </span>
                  </p>
                  {ta.ev < 0 && (
                    <p className="text-xs text-slate-600 mt-1">⚠️ 负期望值，建议放弃本次机会</p>
                  )}
                </div>
              </div>
            );
          })()}

          {selectedPoint && !hasAnalysis && (
            <div className="rounded-xl border border-slate-800 p-4 text-xs text-slate-500 text-center">
              该合约为正常定价范围，无需操作
            </div>
          )}
        </div>
      </div>

      {/* 代理设置弹窗 */}
      <ProxySettingsModal
        isOpen={showProxySettings}
        onClose={() => setShowProxySettings(false)}
      />
    </div>
  );
}

// ─── 通用区块 ───
function Section({
  icon, title, color, children,
}: {
  icon: React.ReactNode;
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 space-y-1.5">
      <div className={`text-xs font-semibold flex items-center gap-1.5 mb-2 ${color}`}>
        {icon}{title}
      </div>
      {children}
    </div>
  );
}

// ─── 行数据展示 ───
function Row({
  label, value, mono, valueColor, sub,
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueColor?: string;
  sub?: string;
}) {
  return (
    <div className="flex justify-between items-start gap-2">
      <div>
        <span className="text-xs text-slate-500">{label}</span>
        {sub && <div className="text-xs text-slate-700 leading-none mt-0.5">{sub}</div>}
      </div>
      <span className={`text-xs flex-shrink-0 ${mono ? 'font-mono' : ''} ${valueColor ?? 'text-slate-300'}`}>
        {value}
      </span>
    </div>
  );
}

// ─── 统计卡片 ───
function StatCard({
  label, value, sub, color, highlight, highlightColor,
}: {
  label: string; value: string; sub: string; color: string;
  highlight?: boolean; highlightColor?: string;
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 transition-all
      ${highlight && highlightColor ? highlightColor : 'border-slate-800 bg-slate-900/50'}`}>
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-600 mt-0.5">{sub}</div>
    </div>
  );
}
