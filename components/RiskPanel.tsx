'use client';

import type { PortfolioRisk } from '@/types';
import { AlertTriangle, CheckCircle, Shield, TrendingDown, TrendingUp, Activity } from 'lucide-react';

interface Props {
  risk: PortfolioRisk;
}

export default function RiskPanel({ risk }: Props) {
  const vegaPct = Math.round(risk.vegaBudgetUsed * 100);
  const gammaPct = Math.round(risk.gammaBudgetUsed * 100);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 space-y-3">
      {/* 标题 */}
      <div className="flex items-center gap-2">
        <Shield size={13} className="text-blue-400" />
        <span className="text-xs font-semibold text-white">组合风控状态</span>
        {risk.circuitBreakerTriggered
          ? <span className="ml-auto text-xs bg-red-500/20 text-red-400 border border-red-500/40 px-2 py-0.5 rounded flex items-center gap-1">
            <AlertTriangle size={9} />熔断触发
          </span>
          : <span className="ml-auto text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded flex items-center gap-1">
            <CheckCircle size={9} />正常
          </span>
        }
      </div>

      {/* 熔断详情 */}
      {risk.circuitBreakerTriggered && risk.circuitBreakerReason && (
        <div className="bg-red-950/30 border border-red-800/30 rounded-lg p-2 text-xs text-red-300">
          {risk.circuitBreakerReason}
        </div>
      )}

      {/* 预算使用率 */}
      <div className="space-y-2">
        <BudgetBar label="Vega 预算" used={vegaPct} color={vegaPct > 80 ? 'bg-red-500' : vegaPct > 50 ? 'bg-yellow-500' : 'bg-blue-500'} />
        <BudgetBar label="Gamma 预算" used={gammaPct} color={gammaPct > 80 ? 'bg-red-500' : gammaPct > 50 ? 'bg-yellow-500' : 'bg-purple-500'} />
      </div>

      {/* 净 Greeks */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-slate-800/50 rounded-lg p-2">
          <div className="text-slate-400 flex items-center gap-1"><Activity size={9} />净 Vega</div>
          <div className="font-mono font-semibold text-sky-400">${risk.netVega.toFixed(1)}</div>
          <div className="text-slate-500">每1% IV变化</div>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-2">
          <div className="text-slate-400 flex items-center gap-1"><Activity size={9} />净 Gamma</div>
          <div className="font-mono font-semibold text-purple-400">${risk.netGamma.toFixed(2)}</div>
          <div className="text-slate-500">标的涨1%</div>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-2">
          <div className="text-slate-400 flex items-center gap-1">净 Delta</div>
          <div className={`font-mono font-semibold ${Math.abs(risk.netDelta) < 100 ? 'text-emerald-400' : 'text-yellow-400'}`}>
            ${risk.netDelta.toFixed(1)}
          </div>
          <div className="text-slate-500">{Math.abs(risk.netDelta) < 100 ? '≈方向中性' : '需要再对冲'}</div>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-2">
          <div className="text-slate-400 flex items-center gap-1">净 Theta</div>
          <div className={`font-mono font-semibold ${risk.netTheta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            ${risk.netTheta.toFixed(2)}/天
          </div>
          <div className="text-slate-500">{risk.netTheta > 0 ? '每日正收益' : '每日成本'}</div>
        </div>
      </div>

      {/* 尾部对冲建议 */}
      {risk.tailHedgeCost > 0 && (
        <div className="bg-amber-950/20 border border-amber-800/20 rounded-lg p-2 text-xs">
          <div className="text-amber-400 font-medium mb-0.5 flex items-center gap-1">
            <Shield size={9} />尾部风险对冲建议
          </div>
          <div className="text-amber-300/80">
            当前有做空期权头寸，建议配置 OTM put 对冲黑天鹅。
            预估对冲成本约 <span className="text-white font-semibold">{(risk.tailHedgeCost * 100).toFixed(1)}%/月</span>（可保护极端行情下的无限亏损）
          </div>
        </div>
      )}
    </div>
  );
}

function BudgetBar({ label, used, color }: { label: string; used: number; color: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">{label}</span>
        <span className={used > 80 ? 'text-red-400' : used > 50 ? 'text-yellow-400' : 'text-slate-400'}>
          {used}%
        </span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(used, 100)}%` }} />
      </div>
    </div>
  );
}
