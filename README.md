# BTC 期权 IV 曲面分析系统

一个专业的 BTC 期权隐含波动率（IV）曲面分析与可视化系统。

## 功能特性

- 📊 **3D IV 曲面可视化** - 实时展示 BTC 期权隐含波动率曲面
- 📈 **SVI 参数拟合** - 使用 SVI 模型拟合波动率微笑
- 🔍 **异常检测** - 自动识别被高估或低估的期权合约
- 🎯 **交易信号** - 基于统计偏差的交易机会分析
- 📉 **风险中性密度** - Breeden-Litzenberger 方法计算 RND
- 💾 **Mock 数据回退** - API 不可用时自动使用仿真数据

## 技术栈

- **框架**: Next.js 16 + React 19
- **可视化**: Plotly.js + Recharts
- **量化计算**: Black-Scholes, SVI, RBF 插值
- **数据源**: Deribit API (BTC 期权)

## 快速开始

首先，运行开发服务器：

```bash
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000) 查看应用。

## API 端点

### `/api/iv-surface`
获取 IV 曲面数据和异常检测结果

查询参数:
- `sigma`: σ 倍数阈值 (默认: 2.0)
- `absPct`: 绝对百分比阈值 (默认: 0.10)
- `smooth`: RBF 正则化强度 (默认: 0.05)
- `stress`: 压力测试模式 (默认: 0)

### `/api/rnd-surface`
获取风险中性密度切片

### `/api/options`
获取原始期权数据

## 更新日志

### v0.1.1 (2026-04-18)
- 🔧 **修复**: 修复 `/api/iv-surface` 超时问题
- 🛡️ **增强**: 添加健壮的数据获取层，包含自动 mock 回退
- 📝 **文档**: 添加修复说明文档
- ⚡ **优化**: 改善 API 响应稳定性

### v0.1.0 (2026-04-18)
- 🎉 **初始版本**: BTC 期权 IV 曲面分析系统完整代码
- ✨ 核心功能: 3D 曲面可视化、SVI 拟合、异常检测

## 项目结构

```
├── app/
│   ├── api/
│   │   ├── iv-surface/route.ts    # IV 曲面 API
│   │   ├── rnd-surface/route.ts   # RND 曲面 API
│   │   └── options/route.ts       # 期权数据 API
│   ├── page.tsx                     # 主页面
│   └── layout.tsx                   # 布局
├── components/
│   ├── charts/                      # 图表组件
│   ├── Dashboard.tsx                # 仪表板
│   └── ...
├── lib/
│   ├── data/fetcher.ts              # 数据获取层
│   ├── engine/                      # 量化引擎
│   └── signals/                     # 信号检测
└── types/                           # 类型定义
```

## 开发说明

### 数据获取
系统使用多层数据获取策略：
1. 尝试从 Deribit API 获取真实数据
2. 如失败，自动使用参数化 mock 数据
3. 保证系统在无网络环境下也能演示

### 数学模型
- **Black-Scholes**: 期权定价和 IV 计算
- **SVI**: 波动率微笑参数化拟合
- **RBF**: 正则化径向基函数插值
- **Breeden-Litzenberger**: 风险中性密度计算

## License

MIT

## 了解更多

- [Next.js 文档](https://nextjs.org/docs)
- [Deribit API](https://docs.deribit.com/)
- [Black-Scholes 模型](https://en.wikipedia.org/wiki/Black%E2%80%93Scholes_model)
- [SVI 波动率模型](https://wwwfma.org/Meetings/2004SA/Papers/gatheral2.pdf)
