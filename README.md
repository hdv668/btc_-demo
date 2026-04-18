# BTC 期权 IV 曲面分析系统

一个专业的 BTC 期权隐含波动率（IV）曲面分析与可视化系统，支持多交易所数据接入。

## 功能特性

- 📊 **3D IV 曲面可视化** - 实时展示 BTC 期权隐含波动率曲面
- 📈 **SVI 参数拟合** - 使用 SVI 模型拟合波动率微笑
- 🔍 **异常检测** - 自动识别被高估或低估的期权合约
- 🎯 **交易信号** - 基于统计偏差的交易机会分析
- 📉 **风险中性密度** - Breeden-Litzenberger 方法计算 RND
- 🏛️ **多交易所支持** - 支持 Deribit、Bybit、Binance 三大交易所
- 💾 **Mock 数据回退** - API 不可用时自动使用仿真数据

## 技术栈

- **框架**: Next.js 16 + React 19
- **可视化**: Plotly.js + Recharts
- **量化计算**: Black-Scholes, SVI, RBF 插值
- **数据源**: Deribit / Bybit / Binance API (BTC 期权)
- **HTTP 客户端**: Axios (服务器端代理)

## 快速开始

首先，运行开发服务器：

```bash
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000) 查看应用。

### 代理设置（如需）

如果在中国大陆或无法直接访问交易所 API，系统已配置支持代理：

**Binance 代理配置**:
- Binance 已配置使用代理端口 `59527`
- 如需修改端口，请编辑 `lib/data/exchanges/binance.ts` 中的代理配置

**其他交易所**:
- Deribit 和 Bybit 支持浏览器端直接访问（无 CORS 限制）
- 如遇网络问题，它们也会自动通过服务器端获取

**手动配置环境变量**（备选方案）:
```bash
export HTTPS_PROXY=http://127.0.0.1:7890
npm run dev
```

## API 端点

### `/api/iv-surface`

获取 IV 曲面数据和异常检测结果

查询参数:
- `sigma`: σ 倍数阈值 (默认: 2.0)
- `absPct`: 绝对百分比阈值 (默认: 0.10)
- `smooth`: RBF 正则化强度 (默认: 0.05)
- `exchange`: 交易所选择 (deribit / bybit / binance, 默认: deribit)
- `optionType`: 期权类型过滤 (call / put / both, 默认: both)
- `stress`: 压力测试模式 (默认: 0)

## 架构设计

### 多交易所支持

系统采用统一的交易所抽象层：

```
lib/data/exchanges/
├── types.ts          # 交易所接口定义
├── registry.ts       # 交易所注册中心
├── deribit.ts        # Deribit 实现
├── bybit.ts          # Bybit 实现
├── binance.ts        # Binance 实现
└── *-browser.ts      # 浏览器端实现（备用）
```

### 服务器端代理

所有交易所 API 调用通过 Next.js API Routes 代理，避免浏览器 CORS 限制：

- Dashboard → `/api/iv-surface` → 交易所 Fetcher → 交易所 API
- 统一使用服务器端 Axios 客户端
- 自动超时处理和 Mock 数据回退

## 更新日志

### v0.3.0 (2026-04-19)
- 🎉 **重大更新**: Binance 交易所现在可以获取实时数据（非 Mock）
- 🔧 **修复**: 解决 Node.js 模块被错误打包到浏览器端的构建错误
- 🚀 **优化**: 分离 mock-utils.ts，确保浏览器端与服务器端代码清晰分离
- ⚙️ **配置**: 添加 VPN 代理支持（端口 59527），解决中国大陆网络限制
- 📝 **兼容**: 修复 Binance API 响应结构变化（symbols → optionSymbols）
- 🎨 **简化**: 简化 IVSurface3D 组件，移除复杂的 RND 模式以提升性能

### v0.2.0 (2026-04-18)
- 🏛️ **新特性**: 完整支持 Bybit 和 Binance 交易所
- 🔧 **修复**: Bybit 合约解析问题（从 symbol 提取 strike/expiry）
- 🚀 **优化**: 统一使用服务器端 API 代理，解决 CORS 问题
- 📝 **改进**: Dashboard 直接调用服务器 API，移除浏览器端 fetch
- ⚡ **增强**: 增加 API 超时时间至 30 秒

### v0.1.1 (2026-04-18)
- 🔧 **修复**: 修复 `/api/iv-surface` 超时问题
- 🛡️ **增强**: 添加健壮的数据获取层，包含自动 mock 回退
- ⚡ **优化**: 改善 API 响应稳定性

### v0.1.0 (2026-04-18)
- 🎉 **初始版本**: BTC 期权 IV 曲面分析系统完整代码
- ✨ 核心功能: 3D 曲面可视化、SVI 拟合、异常检测

## 项目结构

```
├── app/
│   ├── api/
│   │   └── iv-surface/route.ts    # IV 曲面 API（统一入口）
│   ├── page.tsx                     # 主页面
│   └── layout.tsx                   # 布局
├── components/
│   ├── charts/                      # 图表组件
│   ├── Dashboard.tsx                # 仪表板（含交易所选择）
│   └── ...
├── lib/
│   ├── data/
│   │   ├── fetcher.ts              # 数据获取入口
│   │   └── exchanges/              # 交易所实现
│   ├── engine/                      # 量化引擎
│   └── signals/                     # 信号检测
└── types/                           # 类型定义
```

## 开发说明

### 数据获取流程

1. **用户选择交易所** → Dashboard 触发 `fetchSurface()`
2. **调用服务器 API** → `/api/iv-surface?exchange=xxx`
3. **交易所 Fetcher** → 对应交易所实现类
4. **自动回退** → API 失败时自动使用 Mock 数据

### 添加新交易所

1. 在 `lib/data/exchanges/types.ts` 扩展 `ExchangeId`
2. 创建新的 Fetcher 类实现 `ExchangeFetcher` 接口
3. 在 `registry.ts` 中注册新交易所
4. Done!

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
- [Bybit API](https://bybit-exchange.github.io/docs/)
- [Binance API](https://binance-docs.github.io/apidocs/)
- [Black-Scholes 模型](https://en.wikipedia.org/wiki/Black%E2%80%93Scholes_model)
- [SVI 波动率模型](https://wwwfma.org/Meetings/2004SA/Papers/gatheral2.pdf)
