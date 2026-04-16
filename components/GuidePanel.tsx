'use client';

import { useState } from 'react';
import { X, BookOpen, ChevronRight } from 'lucide-react';

type Section = 'terms' | 'logic' | 'howto';

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'terms',  label: '名词解释', icon: '📖' },
  { id: 'logic',  label: '分析逻辑', icon: '🧮' },
  { id: 'howto',  label: '操作指南', icon: '🎯' },
];

// ── 名词解释 ──────────────────────────────────────────────────────────
const TERMS = [
  {
    term: 'IV（隐含波动率）',
    short: '市场对未来波动的"定价"',
    detail:
      '把期权市场价代入 Black-Scholes 公式反推出来的年化波动率。IV 越高，说明期权越贵；IV 越低，说明期权越便宜。它是期权定价的核心参数——你买卖的本质是波动率，而不是方向。',
    example: 'NVDA IV=300%，意味着市场认为 NVDA 未来一年年化波动 300%，折算到 7 天约 ±7.7%。',
  },
  {
    term: 'SVI 拟合曲面',
    short: '期权"公允价值"基准面',
    detail:
      'SVI（Stochastic Volatility Inspired）是一种参数化 IV 曲线模型，对每个到期日拟合一条光滑 IV-行权价曲线。所有到期日合并后形成 3D 曲面，代表市场整体隐含波动率的"理论合理水平"。',
    example: '就像股票有估值基准（PE均值），曲面是每张期权 IV 的基准——偏离曲面越多，定价越异常。',
  },
  {
    term: '凸起点（Bump）',
    short: '某张期权比曲面贵',
    detail:
      '某合约实际 IV 明显高于 SVI 拟合值（z-score > 阈值），在曲面上形成局部凸起。这张期权被市场"定价偏贵"，理论上可以卖出收取超额波动率溢价。',
    example: 'K=890 Call 的 IV=318%，拟合值 254%，偏差 +64pp。这张 Call 被高估，做空波动率机会。',
  },
  {
    term: '凹陷点（Dip）',
    short: '某张期权比曲面便宜',
    detail:
      '某合约实际 IV 明显低于 SVI 拟合值，在曲面上形成局部凹陷。这张期权被市场"定价偏便宜"，可以买入等待 IV 回归至理论水平获利。',
    example: '某 Put 的 IV=180%，拟合值 240%，偏差 -60pp。这张 Put 被低估，做多波动率机会。',
  },
  {
    term: 'z-score',
    short: '偏差的统计显著性',
    detail:
      '用该到期日所有合约残差的均值和标准差，计算当前合约偏差有多少个"标准差"。z=2 意味着只有约 5% 的合约会随机出现这么大的偏差，z=3 则是 0.3%——越大越值得关注。',
    example: 'z=3.14 说明此偏差在统计上极为显著，不太可能是随机噪音，更可能是真实的定价错误。',
  },
  {
    term: 'Theta（时间价值衰减）',
    short: '每天自动赚/亏的时间费',
    detail:
      '期权每过一天，时间价值自然减少的金额。卖出期权时 Theta > 0（每天收钱）；买入期权时 Theta < 0（每天付钱）。越靠近到期日，Theta 衰减越快。',
    example: 'Theta = $10.74/天，意味着你卖出这张期权后，即使标的不动，每天也能赚 $10.74。',
  },
  {
    term: 'Vega（波动率敏感度）',
    short: 'IV 每变动 1% 的盈亏',
    detail:
      '期权对 IV 变化的敏感度。做空波动率时 Vega < 0：如果 IV 上涨，亏损；IV 下降，盈利。每 1% IV 变动对应的盈亏就是 Vega × 100。',
    example: '亏损暴露 $47/1%IV 变动，意味着 IV 意外上涨 20%，仓位亏损约 $940。',
  },
  {
    term: '盈利百分比 / 最大亏损%',
    short: '相对入场成本的收益/亏损比例',
    detail:
      '盈利百分比 = (入场价 - BS目标价) / 入场价，即 IV 回归至 SVI 拟合值时，期权费收缩的比例。最大亏损百分比 = |BS止损价 - 入场价| / 入场价，即 IV 达到止损线（做空vol时 IV×1.5，做多vol时 IV×0.6）时损失的比例。两端均用 Black-Scholes 精确定价，确保计算对称。',
    example: '入场价 $100，IV回归后期权价值降到 $70，盈利 +30%。IV意外拉升50%时期权升至 $152，亏损 -52%。',
  },
  {
    term: '胜率 / 亏损概率',
    short: '基于 z-score 的统计盈亏概率',
    detail:
      '胜率（盈利概率）= Φ(|z| - 1.5)，其中 Φ 是标准正态分布 CDF。z=1.5 时约 50%，z=2.5 时约 69%，z=3.5 时约 84%。同时根据流动性（bid-ask 宽度）做惩罚、根据期权 delta 是否接近平值做小幅修正。亏损概率 = 1 - 胜率。注意：这是统计模型估算，不是保证结果。',
    example: '胜率 72%，亏损概率 28%。意味着在过去统计上类似 z-score 的信号中，约 72% 的情况下 IV 最终回归，交易盈利。',
  },
  {
    term: 'Delta 中性',
    short: '对冲方向性风险',
    detail:
      '通过同时买卖对应数量的标的，使组合净 Delta ≈ 0，消除标的价格涨跌对盈亏的影响，只暴露于波动率（Vega）风险。这样做的纯目的是"套利定价错误"，而非押注方向。',
    example: 'Delta=0.593，需做空 0.593 单位 NVDA 标的，使组合不受 NVDA 涨跌影响。',
  },
  {
    term: 'pp（百分点）',
    short: 'IV 偏差的绝对量单位',
    detail:
      '百分点（percentage point），是 IV 绝对差值的计量单位，与"%"不同。IV 从 50% 涨到 60% 是"上涨 10pp"，而不是"上涨 20%"。用 pp 更直观地反映期权费变化。',
    example: '偏差 +64.3pp 意味着这张期权的 IV 比理论值高出 64.3 个百分点——对应实际期权费高出约 32%。',
  },
  {
    term: 'A/B/C 级信号',
    short: '信号置信度分级',
    detail:
      'A 级：z-score 最高，偏差最大，统计最显著，优先关注。B 级：中等偏差，值得跟踪。C 级：偏差较小，噪音可能性较高，谨慎参考。实际交易建议优先执行 A 级信号，B 级可小仓位试探。',
    example: 'A 级信号通常 z > 2.5，偏差 > 20pp，有较强的回归预期。',
  },
];

// ── 分析逻辑 ──────────────────────────────────────────────────────────
const LOGIC_STEPS = [
  {
    step: '01',
    title: '采集期权链数据',
    desc: '从 Deribit（BTC，无需鉴权，实时数据）或 Polygon.io（美股，需配置 POLYGON_API_KEY，延迟约15分钟）获取所有活跃合约的市价、行权价、到期日，计算每张期权的隐含波动率（IV）。',
    insight: '数据质量是一切分析的前提。IV 计算用 Black-Scholes 反推，需要准确的 bid-ask 中间价。BTC 为真实实时数据；美股为 Polygon.io 数据，日内有约15分钟延迟，适合日内波段策略，不适合高频刷信号。',
  },
  {
    step: '02',
    title: '按到期日分组，拟合 SVI 曲线',
    desc: '将所有合约按到期日分组，每组用 SVI 模型拟合一条 IV-行权价曲线（Volatility Smile）。SVI 保证曲线无统计套利（蝶式凸性、日历价差不倒挂）。',
    insight: '就像给散点图画趋势线——拟合后的曲线代表"这个到期日的合理 IV 分布"，是判断单张期权是否异常的基准。',
  },
  {
    step: '03',
    title: '计算残差，识别异常点',
    desc: '每张合约的实际 IV 减去 SVI 拟合值得到残差。对每个到期日的残差做 z-score 标准化：偏差超过阈值的即为"凸起"（IV 偏高）或"凹陷"（IV 偏低）。',
    insight: '不是所有偏离都值得交易——z-score 过滤掉了流动性差（散点本来就不精确）和偶然噪音，留下统计上显著的错误定价。',
  },
  {
    step: '04',
    title: '无套利验证，评定信号等级',
    desc: '对每个异常点做三重检验：① Put-Call 平价 ② 蝶式凸性（避免 butterfly 套利）③ 日历价差（较近期权总方差不超过远期）。通过检验的信号评为高置信，评定 A/B/C 级。',
    insight: '如果一张期权同时违反 Put-Call 平价，说明它的定价错误更为确定，而不仅仅是波动率拟合残差。多重验证降低误报率。',
  },
  {
    step: '05',
    title: '构建 Delta 中性策略',
    desc: '对每个信号自动计算：入场价、止盈/止损价位（基于 BS 精确定价，止损线=IV×1.5 或 IV×0.6）、Delta 对冲比例、Theta/Vega P&L 路径、最大持仓天数（到期剩余天数×系数：做空vol×0.35，做多vol×0.45）、仓位建议。目标是剥离方向性风险，纯粹套利 IV 定价偏差。',
    insight: 'Delta 中性让你"不猜涨跌"，只赌 IV 回归。这是 vol arb 的精髓：不需要正确预测市场方向，只需要定价回归。',
  },
  {
    step: '06',
    title: '组合风控监控',
    desc: '实时汇总所有开放信号的净 Vega、Gamma、Theta 暴露，监测是否触发熔断条件（标的 24h 涨跌 > 8%，IV 单日涨幅 > 30%）。',
    insight: '单笔信号胜率再高，也要防止"黑天鹅"一次清零。组合层面的 Vega 预算约束是风险管理的最后防线。',
  },
];

// ── 操作指南 ──────────────────────────────────────────────────────────
const HOWTO_STEPS = [
  {
    phase: '选标的',
    color: 'border-blue-500/60 text-blue-400',
    bg: 'bg-blue-950/20',
    steps: [
      '点击左侧边栏选择标的。BTC 为真实实时数据；美股（AAPL/MSFT/NVDA/AMZN/GOOGL/META/TSLA/BRK-B/JPM/V）使用 Polygon.io 数据，延迟约15分钟。优先选流动性好的标的（NVDA/AAPL），期权市场深度更好，bid-ask 更窄。',
      '看"信号总数"卡片——信号越多，当天期权市场定价越不均衡，机会越多；信号为 0 说明曲面平整，没有明显套利空间。',
    ],
    tip: '初学建议从 AAPL 或 MSFT 开始，波动率结构最稳定，信号质量较高。BTC 信号数量最多但波动率极高，适合有经验的交易者。',
  },
  {
    phase: '读信号',
    color: 'border-yellow-500/60 text-yellow-400',
    bg: 'bg-yellow-950/20',
    steps: [
      '信号列表默认按 z-score 排序，优先看 A 级。点击展开信号，先看"拟合偏差"行——偏差 pp 越大、z 越高，机会越确定。',
      '注意"偏差类型"：凸起=期权定价偏贵，适合做空波动率（卖出期权）；凹陷=期权定价偏便宜，适合做多波动率（买入期权）。',
      '"盈利预测"行显示：预期收益金额、相对入场期权费的盈利百分比（+XX%）、以及绿色"胜率 XX%"标签。"亏损暴露"行显示：最大亏损百分比（-XX%，止损线触发时损失比例）和红色"亏损概率 XX%"标签。两行结合看性价比。',
      '理想信号组合：胜率 > 65% + 盈利百分比 > 20% + 最大亏损% < 60%。若胜率 < 50%，建议跳过或等待更高 z-score 确认。注意：盈利%和亏损%都是相对入场期权费，不是总资金。',
      '如果标注了"数据疑问"，说明该合约触发了无套利检验（PCP/蝶式/日历价差之一）。注意：有套利疑问的信号置信度反而标为"低"——因为这可能是数据质量问题而非真实定价错误，需要结合其他维度判断。',
    ],
    tip: '不要只看"盈利预测"的绝对金额，要综合看胜率、盈利%、亏损%三个维度——高胜率但盈利%极低的信号，实际期望值并不高。',
  },
  {
    phase: '看曲面（3D Tab）',
    color: 'border-purple-500/60 text-purple-400',
    bg: 'bg-purple-950/20',
    steps: [
      '切换到"3D 曲面"视图，旋转曲面找到你选中信号对应的红/绿散点。散点与曲面的垂直距离（白色竖线）就是 IV 偏差的直观高度。',
      '如果一片区域的散点整体都浮在曲面上方（整排 bump），说明某个到期日的整体 IV 被系统性高估，可能有更大的套利空间。',
    ],
    tip: '曲面颜色从深蓝（低 IV）到黄色（高 IV），颜色急变的区域往往是 vol smile 最陡的地方，也是期权定价最不稳定的区域。',
  },
  {
    phase: '执行入场',
    color: 'border-emerald-500/60 text-emerald-400',
    bg: 'bg-emerald-950/20',
    steps: [
      '按照"行权价/期权费"行的入场价执行。实盘中尽量用限价单，以 bid-ask 中间价附近挂单，避免被市场商吃价差。',
      '做空波动率（SELL）：卖出对应合约，同时按 Delta 值做多/空对应数量的标的，实现 Delta 中性。',
      '做多波动率（BUY）：买入对应合约，同时按 Delta 值做空/多对应数量的标的，实现 Delta 中性。',
      '仓位大小严格遵守"仓位建议"行（通常 2-3% 总资金），不要因为信号强就重仓——单笔 Vega 暴露有上限。',
    ],
    tip: '入场前检查流动性风控状态：如果显示"breach"（红色），说明 bid-ask 价差已超过 IV 偏差带来的理论收益，这笔交易实际上是亏的，跳过。',
  },
  {
    phase: '持仓管理',
    color: 'border-orange-500/60 text-orange-400',
    bg: 'bg-orange-950/20',
    steps: [
      '每天盯盘：当实际 IV 向拟合值方向回归时，浮盈增加。Theta 每天自动累积（做空 vol 时为正收入）。',
      '最大持仓天数是动态的，由"到期剩余天数 × 系数"决定（做空vol ×0.35，做多vol ×0.45）。近期期权（7天到期）持仓上限约2~3天；远期期权（90天到期）持仓上限约30~40天。系统会在"仓位建议"行显示具体天数。',
      '定期 Delta 再平衡：标的价格移动后，Delta 会偏移，需要按"再平衡阈值"调整对冲量（再平衡阈值 = Gamma × 价格偏移容忍度）。',
      '注意"每日 Theta"卡片——如果总组合 Theta 变为负数，说明你的持仓结构有问题，需要检查。',
    ],
    tip: '持仓期间如果标的出现大幅跳涨跳跌（> 8%），先不要追加仓位，等市场情绪稳定后再评估。远期期权（>90天）持仓周期更长，需要更宽的 IV 波动容忍度。',
  },
  {
    phase: '离场/止损',
    color: 'border-red-500/60 text-red-400',
    bg: 'bg-red-950/20',
    steps: [
      '主动止盈：IV 回归到曲面拟合值附近（偏差收窄至 < 10pp）时，平仓锁定收益，不要贪心等到 0。',
      '被动止损（按"离场/止损"行执行）：① IV 触及止损线（通常拟合值 +50%）立即平仓；② 标的 24h 涨跌 > 8% 暂停开仓；③ IV 单日涨幅 > 30% 全部平仓。',
      '到期前 2 天（最大持仓天数）无论盈亏全部平仓——Gamma 风险在临近到期时急剧放大，不可控。',
    ],
    tip: '止损不是失败，是资金管理。做空 vol 的最大风险是 IV 因黑天鹅事件无限上涨（如突发财报、并购消息），止损线是你的安全边际。',
  },
];

// ── 子组件 ────────────────────────────────────────────────────────────
function TermCard({ term, short, detail, example }: typeof TERMS[0]) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rounded-xl border transition-all cursor-pointer select-none
        ${open ? 'border-blue-500/40 bg-blue-950/10' : 'border-slate-700/50 bg-slate-800/30 hover:border-slate-600'}`}
      onClick={() => setOpen(o => !o)}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1">
          <div className="text-sm font-semibold text-white">{term}</div>
          <div className="text-xs text-slate-400 mt-0.5">{short}</div>
        </div>
        <ChevronRight size={14} className={`text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} />
      </div>
      {open && (
        <div className="px-4 pb-4 space-y-2 border-t border-slate-700/40 pt-3">
          <p className="text-xs text-slate-300 leading-relaxed">{detail}</p>
          <div className="bg-slate-900/60 rounded-lg px-3 py-2 text-xs text-slate-400 border border-slate-700/30">
            <span className="text-yellow-400 font-medium">举例：</span>{example}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  onClose: () => void;
}

export default function GuidePanel({ onClose }: Props) {
  const [section, setSection] = useState<Section>('terms');

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-sm flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-800 flex-shrink-0">
        <BookOpen size={18} className="text-blue-400" />
        <span className="font-bold text-white text-base">操作指南</span>
        <span className="text-slate-500 text-xs">VolArb 期权波动率套利系统</span>
        <div className="flex-1" />
        <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-800">
          <X size={18} />
        </button>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1 px-6 pt-4 pb-2 flex-shrink-0">
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all
              ${section === s.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}>
            <span>{s.icon}</span>{s.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto px-6 pb-8">

        {/* ── 名词解释 ── */}
        {section === 'terms' && (
          <div className="max-w-2xl mx-auto space-y-2 pt-4">
            <p className="text-xs text-slate-500 pb-2">点击每个词条展开详细解释和举例。建议从上到下依次阅读，它们构成理解本系统的完整知识链。</p>
            {TERMS.map(t => <TermCard key={t.term} {...t} />)}
          </div>
        )}

        {/* ── 分析逻辑 ── */}
        {section === 'logic' && (
          <div className="max-w-2xl mx-auto pt-4 space-y-4">
            <p className="text-xs text-slate-500 pb-2">本系统的信号生成遵循以下六个步骤，每一步都有明确的统计依据。理解这个链条，你才能判断一个信号是否真的值得交易。</p>
            {LOGIC_STEPS.map(step => (
              <div key={step.step} className="rounded-xl border border-slate-700/50 bg-slate-800/30 overflow-hidden">
                <div className="flex items-start gap-4 px-4 py-4">
                  <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-slate-700/60 flex items-center justify-center text-sm font-bold text-blue-400 font-mono">
                    {step.step}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-white mb-1">{step.title}</div>
                    <div className="text-xs text-slate-300 leading-relaxed mb-3">{step.desc}</div>
                    <div className="bg-slate-900/60 rounded-lg px-3 py-2 text-xs text-slate-400 border border-slate-700/30 leading-relaxed">
                      <span className="text-sky-400 font-medium">深层逻辑：</span>{step.insight}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── 操作指南 ── */}
        {section === 'howto' && (
          <div className="max-w-2xl mx-auto pt-4 space-y-4">
            <p className="text-xs text-slate-500 pb-2">按照以下六个阶段操作，每个阶段结尾有关键提示（Tip）。如果你是第一次使用，建议先用纸面模拟交易跑 2-3 周再实盘。</p>
            {HOWTO_STEPS.map((phase, idx) => (
              <div key={idx} className={`rounded-xl border ${phase.color} ${phase.bg} overflow-hidden`}>
                <div className="px-4 py-3 border-b border-slate-700/30">
                  <div className={`text-sm font-bold ${phase.color.split(' ')[1]}`}>
                    {String(idx + 1).padStart(2, '0')}  {phase.phase}
                  </div>
                </div>
                <div className="px-4 py-3 space-y-2">
                  {phase.steps.map((s, i) => (
                    <div key={i} className="flex gap-2 text-xs text-slate-300 leading-relaxed">
                      <span className="flex-shrink-0 text-slate-600 font-mono mt-px">{i + 1}.</span>
                      <span>{s}</span>
                    </div>
                  ))}
                  <div className="mt-3 bg-slate-900/50 rounded-lg px-3 py-2 text-xs text-slate-400 border border-slate-700/20 leading-relaxed">
                    <span className="text-yellow-400 font-medium">Tip：</span>{phase.tip}
                  </div>
                </div>
              </div>
            ))}
            {/* 免责声明 */}
            <div className="rounded-xl border border-slate-700/30 bg-slate-900/30 px-4 py-3 text-xs text-slate-500 leading-relaxed">
              <span className="text-slate-400 font-medium">风险提示：</span>本系统仅供量化分析参考，所有信号均基于历史数据和统计模型，不构成投资建议。期权交易存在较大风险，做空波动率在极端行情下可能面临无限亏损。请严格控制仓位，在充分了解风险后谨慎操作。
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
