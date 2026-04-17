# 多交易所支持系统设计文档

**日期:** 2026-04-18  
**版本:** 1.0  
**作者:** hdv668

## 概述

为 BTC 期权 IV 曲面分析系统添加 Bybit 和 Binance 交易所支持，并提供交易所和期权类型的实时选择功能。

## 功能需求

1. **交易所支持**
   - Deribit（现有）
   - Bybit（新增）
   - Binance（新增）

2. **UI 选择器**
   - 交易所下拉选择框（顶部导航栏右侧）
   - 期权类型切换按钮（Call / Put / Both）

3. **数据来源指示器**
   - 显示数据是 Real-time（真实 API）还是 Mock（仿真数据）

4. **保持兼容性**
   - 所有现有逻辑保持不变
   - IV 曲面计算、异常检测等功能独立于交易所

## 架构设计

### 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     前端 Dashboard                         │
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │ 交易所选择器  │  │   期权类型切换 (Call/Put/Both)   │ │
│  └──────┬───────┘  └─────────────────┬────────────────┘ │
└─────────┼────────────────────────────┼──────────────────┘
          │                            │
          ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│              /api/iv-surface (新增 exchange 参数)          │
│                      optionType 参数                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │  ExchangeRegistry (注册表)    │
        │  - deribit                    │
        │  - bybit                      │
        │  - binance                    │
        └──────────────┬───────────────┘
                       │
        ┌──────────────▼───────────────┐
        │  ExchangeFetcher 接口        │
        ├─────────────────────────────┤
        │ + fetchOptions()             │
        │ + getExchangeId()            │
        │ + getExchangeName()          │
        └──────────────┬───────────────┘
           ┌───────────┼───────────┐
           │           │           │
    ┌──────▼───┐  ┌───▼─────┐ ┌──▼──────┐
    │ Deribit  │  │ Bybit   │ │ Binance │
    │ Fetcher  │  │ Fetcher │ │ Fetcher │
    └──────────┘  └─────────┘ └─────────┘
```

## 核心接口定义

### ExchangeFetcher 接口

```typescript
// lib/data/exchanges/types.ts
import type { MarketSnapshot } from '@/types';

export type ExchangeId = 'deribit' | 'bybit' | 'binance';
export type OptionTypeFilter = 'call' | 'put' | 'both';

export interface ExchangeFetcher {
  /** 交易所唯一标识 */
  readonly id: ExchangeId;
  
  /** 交易所显示名称 */
  readonly name: string;
  
  /**
   * 获取期权市场数据
   * @returns MarketSnapshot 对象，包含 isMock 字段标识数据来源
   */
  fetchOptions(): Promise<MarketSnapshot>;
}

export interface ExchangeRegistry {
  /**
   * 根据交易所 ID 获取 fetcher 实例
   */
  get(exchangeId: ExchangeId): ExchangeFetcher;
  
  /**
   * 获取所有可用的交易所列表
   */
  list(): ExchangeFetcher[];
}
```

### 类型扩展

```typescript
// types/index.ts
export interface MarketSnapshot {
  symbol: string;
  source: string;
  underlyingPrice: number;
  fetchedAt: number;
  contracts: OptionContract[];
  isMock: boolean;  // 新增：是否为 mock 数据
  exchangeId?: ExchangeId;  // 新增：交易所 ID
}

export interface SurfaceResponse {
  // ... 现有字段
  isMock: boolean;  // 新增：数据来源标识
  exchange: ExchangeId;  // 新增：当前交易所
}
```

## 文件结构

### 新增文件

```
lib/data/exchanges/
├── types.ts          # 交易所接口和类型定义
├── registry.ts       # 交易所注册表实现
├── deribit.ts        # Deribit 交易所实现（从 fetcher.ts 迁移）
├── bybit.ts          # Bybit 交易所实现（新增）
└── binance.ts        # Binance 交易所实现（新增）
```

### 修改文件

1. `lib/data/fetcher.ts`
   - 简化为导出统一入口
   - 保留 `generateMockSnapshot` 供各交易所使用

2. `app/api/iv-surface/route.ts`
   - 添加 `exchange` 查询参数（默认: 'deribit'）
   - 添加 `optionType` 查询参数（默认: 'both'）
   - 从 ExchangeRegistry 获取对应 fetcher
   - 在响应中包含 `isMock` 和 `exchange` 字段
   - **移除之前错误添加的 `.filter(c => c.optionType === 'call')`**

3. `components/Dashboard.tsx`
   - 添加交易所选择下拉框（顶部导航栏右侧）
   - 添加期权类型切换按钮组（Call / Put / Both）
   - 添加数据来源指示器（Real-time / Mock）
   - 交易所切换时重新获取数据
   - 期权类型切换时在前端过滤数据

4. `types/index.ts`
   - 添加 `ExchangeId` 和 `OptionTypeFilter` 类型
   - 扩展 `MarketSnapshot` 和 `SurfaceResponse` 接口

## API 设计

### /api/iv-surface

**新增查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `exchange` | string | `deribit` | 交易所 ID: deribit \| bybit \| binance |
| `optionType` | string | `both` | 期权类型: call \| put \| both |

**响应新增字段：**

```json
{
  "isMock": false,
  "exchange": "deribit",
  "...": "其他现有字段"
}
```

## 交易所 API 实现

### Bybit API

**基础 URL:** `https://api.bybit.com`

**端点：**
1. 获取期权合约: `/v5/market/instruments-info?category=option&baseCoin=BTC`
2. 获取 ticker 数据: `/v5/market/tickers?category=option&baseCoin=BTC`

**实现要点：**
- 解析 instrument 数据获取 strike、expiration、optionType
- 解析 ticker 数据获取 bid/ask 价格
- 统一转换为 `OptionContract` 格式
- 添加 mock 回退机制

### Binance API

**基础 URL:** `https://eapi.binance.com`

**端点：**
1. 获取期权合约: `/eapi/v1/exchangeInfo`
2. 获取 ticker 数据: `/eapi/v1/ticker`

**实现要点：**
- 解析 exchangeInfo 获取合约列表
- 解析 ticker 获取价格数据
- 统一转换为 `OptionContract` 格式
- 添加 mock 回退机制

## UI 设计

### 顶部导航栏变更

```
┌─────────────────────────────────────────────────────────────────┐
│  [Logo]  VolSurface  BTC 期权 IV 曲面 · 套利决策支持    │
│                                                         │
│  [交易所▼] [Call] [Put] [Both]  [刷新]            │
│                                                         │
│  [800 合约 · 6 个到期 · 2.0σ=15% · 12:34:56 · 🟢 Real-time @ Deribit] │
└─────────────────────────────────────────────────────────────────┘
```

### 组件说明

1. **交易所选择下拉框**
   - 位置: 顶部导航栏右侧，刷新按钮左侧
   - 选项: Deribit / Bybit / Binance
   - 行为: 选择后自动重新获取数据

2. **期权类型切换**
   - 位置: 交易所选择器旁边
   - 样式: 三个按钮组成的按钮组
   - 行为: 切换时在前端过滤数据，不重新请求 API

3. **数据来源指示器**
   - 位置: 状态栏信息行末尾
   - 样式: 
     - Real-time: 🟢 绿色文字 + 图标
     - Mock: 🟡 黄色文字 + 图标
   - Tooltip: 鼠标悬停显示详细说明

## 实现顺序

1. **Phase 1: 类型定义和接口**
   - 创建 `lib/data/exchanges/types.ts`
   - 扩展 `types/index.ts`

2. **Phase 2: 交易所实现**
   - 创建 `ExchangeRegistry`
   - 迁移 Deribit 实现到独立文件
   - 实现 Bybit fetcher
   - 实现 Binance fetcher

3. **Phase 3: API 层更新**
   - 更新 `app/api/iv-surface/route.ts`
   - 添加交易所和期权类型参数支持

4. **Phase 4: 前端 UI**
   - 更新 `components/Dashboard.tsx`
   - 添加选择器组件
   - 添加数据来源指示器

5. **Phase 5: 测试和验证**
   - 测试各交易所切换
   - 测试期权类型切换
   - 验证 mock 回退机制
   - 验证数据来源显示

## 错误处理和回退

1. **交易所 API 失败**
   - 自动回退到 mock 数据
   - 设置 `isMock: true`
   - UI 显示 "Mock" 指示器

2. **交易所参数无效**
   - 默认回退到 'deribit'
   - 记录警告日志

3. **期权类型参数无效**
   - 默认回退到 'both'
   - 记录警告日志

## 保持兼容

- 现有 API 端点默认行为不变（exchange=deribit, optionType=both）
- 现有 IV 计算、异常检测等逻辑完全不变
- 数据格式保持一致，仅新增字段
- Mock 数据生成逻辑可复用以模拟不同交易所特点

## 后续扩展

- 支持更多交易所（OKX、Bitget 等）
- 添加交易所数据对比视图
- 支持跨交易所套利机会检测
- 添加交易所优先级配置
