"""
BTC 期权"无套利隧道"双曲面建模与可视化
========================================
Author  : Quantitative Architect
Version : 2.0 — Dual-Surface Tunnel Model

核心逻辑：
  - 分别对 Bid 和 Ask 价格反解 IV，构建 Bid Surface / Ask Surface（即"定价隧道"）
  - 用全量 Mid IV + 正则化 RBF 拟合"基准理论曲面"（IV_bench）
  - 当 IV_bench 穿出隧道时（> IV_ask 或 < IV_bid），触发"隧道破位"套利信号

穿透判定（The Tunnel Logic）
  ① Long Opportunity  : IV_bench > IV_ask  → 买入合约，IV 偏低于理论共识
  ② Short Opportunity : IV_bench < IV_bid  → 卖出合约，IV 偏高于理论共识
  ③ Fair              : IV_bid ≤ IV_bench ≤ IV_ask → 定价有效，不交易

非法数据处理（IV_bid > IV_ask）
  通常由刷新延迟或极低流动性造成，属于噪声，直接剔除，防止插值污染曲面。
"""

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from scipy.stats import norm
from scipy.interpolate import Rbf
from datetime import datetime
import asyncio
import aiohttp
import warnings
warnings.filterwarnings("ignore")


# ─────────────────────────────────────────────
# Section 1: Black-Scholes 工具函数
# ─────────────────────────────────────────────

class BSModel:
    """
    Black-Scholes 期权定价与 IV 反解工具（假设无风险利率 r=0，
    符合加密货币期权市场惯例）。
    """

    def __init__(self, r: float = 0.0):
        self.r = r

    def call_price(self, S: float, K: float, T: float, sigma: float) -> float:
        """BS 看涨期权定价，T=0 时直接返回内在价值。"""
        if T <= 0 or sigma <= 0:
            return max(S - K, 0.0)
        d1 = (np.log(S / K) + (self.r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
        d2 = d1 - sigma * np.sqrt(T)
        return S * norm.cdf(d1) - K * np.exp(-self.r * T) * norm.cdf(d2)

    def vega(self, S: float, K: float, T: float, sigma: float) -> float:
        """Vega = ∂C/∂σ = S√T·N'(d1)，用于 Newton-Raphson 步长计算。"""
        if T <= 0 or sigma <= 0:
            return 0.0
        d1 = (np.log(S / K) + (self.r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
        return S * np.sqrt(T) * norm.pdf(d1)

    def iv_bisection(self, S: float, K: float, T: float, price: float,
                     lo: float = 0.001, hi: float = 5.0,
                     tol: float = 1e-6, max_iter: int = 200) -> float:
        """二分法反解 IV，作为 Newton-Raphson 失败时的退路。"""
        for _ in range(max_iter):
            mid = (lo + hi) / 2.0
            diff = self.call_price(S, K, T, mid) - price
            if abs(diff) < tol:
                return mid
            if diff < 0:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2.0

    def iv_newton(self, S: float, K: float, T: float, price: float,
                  sigma0: float = 0.5, tol: float = 1e-6, max_iter: int = 100) -> float:
        """
        Newton-Raphson 主迭代反解 IV。
        σ_{n+1} = σ_n - (C_BS(σ_n) - C_market) / ν(σ_n)

        关键边界处理：
        - price ≤ 0 时立即返回 None（表示无效，由调用方处理 Bid=0 情况）
        - Vega < 1e-8 时切换二分法，防止步长爆炸
        - σ 越界时切换二分法
        """
        # ★ 处理 Bid=0 极端情况：Bid 为 0 通常意味着无买盘，IV 无法定义
        if price <= 0:
            return None

        # 内在价值下界检测：市价低于内在价值则无法反解真实 IV
        intrinsic = max(S - K, 0.0)
        if price <= intrinsic + 1e-8:
            return None

        sigma = sigma0
        for _ in range(max_iter):
            c = self.call_price(S, K, T, sigma)
            diff = c - price
            if abs(diff) < tol:
                return sigma
            v = self.vega(S, K, T, sigma)
            if v < 1e-8:
                return self.iv_bisection(S, K, T, price)
            sigma -= diff / v
            if sigma <= 0 or sigma > 5.0:
                return self.iv_bisection(S, K, T, price)

        return self.iv_bisection(S, K, T, price)


# ─────────────────────────────────────────────
# Section 2: 数据获取与清洗
# ─────────────────────────────────────────────

async def fetch_deribit_options() -> list:
    """异步从 Deribit 获取 BTC 期权全量盘口数据（含 Bid / Ask）。"""
    url = ("https://deribit.com/api/v2/public/get_book_summary_by_currency"
           "?currency=BTC&kind=option")
    async with aiohttp.ClientSession() as session:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            data = await resp.json()
            return data.get("result", [])


def process_data(raw: list, model: BSModel) -> pd.DataFrame:
    """
    清洗盘口数据，分别反解 IV_bid / IV_ask / IV_mid，
    构建用于曲面拟合的 DataFrame。

    【非法套利数据处理】：
    当 IV_bid > IV_ask 时（即 Bid 价格 > Ask 价格），属于数据噪声
    （可能由行情快照时差、报价延迟造成），直接 dropna 或 mask 过滤，
    防止其污染 RBF 插值曲面，产生伪套利信号。
    """
    now = datetime.utcnow()
    rows = []

    for item in raw:
        name = item.get("instrument_name", "")
        parts = name.split("-")
        if len(parts) != 4:
            continue
        _, expiry_str, strike_str, opt_type = parts
        if opt_type != "C":         # 仅使用 Call 期权建立曲面
            continue

        bid_btc = item.get("bid_price") or 0.0   # bid 可能为 null
        ask_btc = item.get("ask_price")
        underlying = item.get("underlying_price")

        # ask=0 或标的价缺失 → 无效报价
        if not ask_btc or not underlying or ask_btc <= 0:
            continue

        try:
            expiry = datetime.strptime(expiry_str, "%d%b%y").replace(
                hour=8, minute=0, second=0)
        except ValueError:
            continue

        T = (expiry - now).total_seconds() / (365 * 24 * 3600)
        if T <= 1 / 365:            # 剩余期限 < 1 天，短端 IV 极度不稳定
            continue

        S = float(underlying)
        K = float(strike_str)
        # 过滤远离现货的深度虚值 / 深度实值（插值外推易失真）
        if K < S * 0.4 or K > S * 2.0:
            continue

        # USD 换算（Deribit 报价单位为 BTC）
        bid_usd = bid_btc * S          # bid_btc 可能为 0
        ask_usd = ask_btc * S
        mid_usd = (bid_usd + ask_usd) / 2.0

        rows.append({
            "instrument": name,
            "S": S, "K": K, "T": T,
            "bid_usd": bid_usd,
            "ask_usd": ask_usd,
            "mid_usd": mid_usd,
        })

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)

    # ── 向量化反解 IV（逐行调用牛顿法）──
    def solve_iv(row, price_col):
        return model.iv_newton(row["S"], row["K"], row["T"], row[price_col])

    print("  反解 IV_bid ...")
    df["iv_bid"] = df.apply(lambda r: solve_iv(r, "bid_usd"), axis=1)
    print("  反解 IV_ask ...")
    df["iv_ask"] = df.apply(lambda r: solve_iv(r, "ask_usd"), axis=1)
    print("  反解 IV_mid ...")
    df["iv_mid"] = df.apply(lambda r: solve_iv(r, "mid_usd"), axis=1)

    # ── 清洗 ──
    # 1. 丢弃 IV_mid / IV_ask 无效行（NaN 或越界）
    df = df.dropna(subset=["iv_mid", "iv_ask"])
    df = df[(df["iv_mid"] > 0.05) & (df["iv_mid"] < 3.0)]
    df = df[(df["iv_ask"] > 0.05) & (df["iv_ask"] < 3.0)]

    # 2. 【关键】剔除非法套利噪声：IV_bid > IV_ask
    #    理论上 Bid 价 ≤ Ask 价，故 IV_bid 必须 ≤ IV_ask
    #    违反此约束时，说明该行情快照存在时差错误，直接丢弃
    if "iv_bid" in df.columns:
        bad_mask = df["iv_bid"].notna() & (df["iv_bid"] > df["iv_ask"])
        n_bad = bad_mask.sum()
        if n_bad > 0:
            print(f"  ⚠ 检测到 {n_bad} 条非法套利数据（IV_bid > IV_ask），已剔除")
        df = df[~bad_mask]

    # 3. IV_bid 为 None（Bid=0）时填 NaN，但保留该行（Bid Surface 可能有缺口）
    df["iv_bid"] = df["iv_bid"].astype(float)

    return df.reset_index(drop=True)


# ─────────────────────────────────────────────
# Section 3: 正则化 RBF 曲面拟合
# ─────────────────────────────────────────────

def build_rbf_surface(strikes: np.ndarray, tenors: np.ndarray, ivs: np.ndarray,
                      grid_points: int = 50, smooth: float = 0.05):
    """
    使用 Tikhonov 正则化 RBF 插值拟合平滑曲面。

    标准 RBF（smooth=0）：曲面严格穿过每个点，异常点会使曲面"隆起"，
                          难以区分真正的定价偏差。
    正则化 RBF（smooth>0）：相当于在对角线加 λI，惩罚曲面曲率，
                           使其保持整体平滑趋势。此时真正的离群点
                           会显著"脱离"曲面，易于检测。

    参数：
        smooth  : 正则化强度（0 = 严格插值，0.05 = 弱平滑，0.2+ = 强平滑）
    """
    rbf = Rbf(strikes, tenors, ivs, function="multiquadric", smooth=smooth)
    k_grid = np.linspace(strikes.min(), strikes.max(), grid_points)
    t_grid = np.linspace(tenors.min(), tenors.max(), grid_points)
    K_mesh, T_mesh = np.meshgrid(k_grid, t_grid)
    IV_mesh = rbf(K_mesh, T_mesh)
    # 裁剪负值（正则化有时会在稀疏区域产生轻微负数）
    IV_mesh = np.clip(IV_mesh, 0.01, None)
    return K_mesh, T_mesh, IV_mesh, rbf


# ─────────────────────────────────────────────
# Section 4: 隧道穿透判定
# ─────────────────────────────────────────────

def classify_tunnel_breakout(df: pd.DataFrame, bench_rbf) -> pd.DataFrame:
    """
    核心判定逻辑 —— 将每个合约的 IV_bench 与其 IV_bid/IV_ask 比较：

    Long Opportunity  : IV_bench > IV_ask
        即使以最贵的"卖一价"买入，价格仍低于理论共识 → 绝对低估 → 做多 Vega

    Short Opportunity : IV_bench < IV_bid
        即使以最便宜的"买一价"卖出，价格仍高于理论共识 → 绝对高估 → 做空 Vega

    Fair              : IV_bid ≤ IV_bench ≤ IV_ask
        理论价格落在买卖价差内，市场定价有效 → 不交易

    穿透深度（penetration_depth）：
        IV_bench 距离最近隧道边界的绝对距离，越大意味着套利空间越厚。
    """
    # 用 RBF 对每个实际合约点计算基准 IV
    df = df.copy()
    df["iv_bench"] = bench_rbf(df["K"].values, df["T"].values)
    df["iv_bench"] = df["iv_bench"].clip(0.01, None)

    # 价差宽度（衡量流动性成本 / 隧道厚度）
    df["spread_iv"] = df["iv_ask"] - df["iv_bid"].fillna(0)

    # 穿透方向
    conditions = [
        df["iv_bench"] > df["iv_ask"],                                  # Long
        df["iv_bench"] < df["iv_bid"].fillna(df["iv_ask"] * 1e6),       # Short（iv_bid=NaN 则不触发）
    ]
    choices = ["LONG", "SHORT"]
    df["signal"] = np.select(conditions, choices, default="FAIR")

    # 穿透深度（相对曲面 IV 的百分比）
    depth_long  = df["iv_bench"] - df["iv_ask"]   # >0 时为 LONG 穿透
    depth_short = df["iv_bid"].fillna(np.nan) - df["iv_bench"]  # >0 时为 SHORT 穿透
    df["pen_depth"] = np.where(df["signal"] == "LONG", depth_long,
                      np.where(df["signal"] == "SHORT", depth_short, 0.0))

    # 预期回归收益：穿透深度 - 价差宽度 / 2（扣除一半买卖价差作为执行成本）
    df["net_edge"] = df["pen_depth"] - df["spread_iv"] / 2.0

    # 滑点预警：如果价差 > 2 × 穿透深度，利润空间被吃掉
    df["slippage_warning"] = df["spread_iv"] > 2 * df["pen_depth"].abs()

    return df


# ─────────────────────────────────────────────
# Section 5: Plotly 三层曲面 + 异常点可视化
# ─────────────────────────────────────────────

def build_tunnel_surface(K_mesh, T_mesh, iv_bench_mesh,
                         bid_rbf, ask_rbf) -> tuple:
    """
    在同一网格上分别用 Bid/Ask RBF 计算上下曲面的 IV 网格。
    返回 (IV_ask_mesh, IV_bid_mesh)。
    """
    shape = K_mesh.shape
    k_flat = K_mesh.flatten()
    t_flat = T_mesh.flatten()

    iv_ask_flat = ask_rbf(k_flat, t_flat).clip(0.01, None)
    iv_bid_flat = bid_rbf(k_flat, t_flat).clip(0.01, None)

    # ★ 强制 IV_ask ≥ IV_bid（网格层面修正，消除边缘外推噪声）
    iv_ask_flat = np.maximum(iv_ask_flat, iv_bid_flat)

    return iv_ask_flat.reshape(shape), iv_bid_flat.reshape(shape)


def make_highlight_mask(iv_bench_mesh, iv_ask_mesh, iv_bid_mesh):
    """
    生成穿透高亮遮罩：
    - IV_bench > IV_ask → 值为 1（LONG 区，蓝色）
    - IV_bench < IV_bid → 值为 -1（SHORT 区，紫色）
    - 否则 → 值为 0（FAIR，不高亮）
    """
    mask = np.zeros_like(iv_bench_mesh)
    mask[iv_bench_mesh > iv_ask_mesh] = 1.0
    mask[iv_bench_mesh < iv_bid_mesh] = -1.0
    return mask


def render_dual_surface(df: pd.DataFrame,
                        K_mesh, T_mesh,
                        iv_bench_mesh, iv_ask_mesh, iv_bid_mesh,
                        smooth_lambda: float = 0.05):
    """
    渲染三层 Plotly 3D 曲面 + 离散异常点 + 交互式分析悬停卡片。

    图层顺序（从下到上）：
    ① Bid Surface   — 绿色半透明，opacity 0.20（隧道下沿）
    ② Ask Surface   — 红色半透明，opacity 0.20（隧道上沿）
    ③ Bench Surface — 白色实线网格（基准理论曲面），高对比度
    ④ 穿透高亮层   — IV_bench 溢出隧道的区域单独渲染：
                       蓝色 = LONG 区（bench > ask），紫色 = SHORT 区（bench < bid）
    ⑤ LONG 异常点  — 蓝色钻石，标记隧道破位 Long 信号
    ⑥ SHORT 异常点 — 紫色钻石，标记隧道破位 Short 信号
    """
    T_days_mesh = T_mesh * 365  # 转换为天数，方便阅读

    traces = []

    # ── ① Bid Surface（绿色，隧道下沿）──
    traces.append(go.Surface(
        name="Bid IV Surface（隧道下沿）",
        x=K_mesh, y=T_days_mesh, z=iv_bid_mesh * 100,
        colorscale=[[0, "rgba(34,197,94,0.0)"], [1, "rgba(34,197,94,0.4)"]],
        showscale=False,
        opacity=0.20,
        showlegend=True,
        hovertemplate=(
            "Bid IV Surface<br>"
            "Strike: $%{x:,.0f}<br>Tenor: %{y:.0f}d<br>IV_bid: %{z:.1f}%<extra></extra>"
        ),
        contours=dict(z=dict(show=False)),
        lighting=dict(ambient=0.7, diffuse=0.3),
    ))

    # ── ② Ask Surface（红色，隧道上沿）──
    traces.append(go.Surface(
        name="Ask IV Surface（隧道上沿）",
        x=K_mesh, y=T_days_mesh, z=iv_ask_mesh * 100,
        colorscale=[[0, "rgba(239,68,68,0.0)"], [1, "rgba(239,68,68,0.4)"]],
        showscale=False,
        opacity=0.20,
        showlegend=True,
        hovertemplate=(
            "Ask IV Surface<br>"
            "Strike: $%{x:,.0f}<br>Tenor: %{y:.0f}d<br>IV_ask: %{z:.1f}%<extra></extra>"
        ),
        contours=dict(z=dict(show=False)),
        lighting=dict(ambient=0.7, diffuse=0.3),
    ))

    # ── ③ Bench Surface（白色主曲面，高对比度）──
    traces.append(go.Surface(
        name="Bench IV（基准理论曲面）",
        x=K_mesh, y=T_days_mesh, z=iv_bench_mesh * 100,
        colorscale="Viridis",
        showscale=True,
        colorbar=dict(title="IV_bench %", x=1.02, len=0.7),
        opacity=0.80,
        showlegend=True,
        hovertemplate=(
            "Bench IV（理论共识）<br>"
            "Strike: $%{x:,.0f}<br>Tenor: %{y:.0f}d<br>IV_bench: %{z:.1f}%<extra></extra>"
        ),
        contours=dict(
            z=dict(show=True, color="white", width=1, highlightwidth=1),
        ),
        lighting=dict(ambient=0.8, diffuse=0.4, specular=0.1),
    ))

    # ── ④ 穿透高亮层（仅渲染溢出区域，其余透明）──
    mask = make_highlight_mask(iv_bench_mesh, iv_ask_mesh, iv_bid_mesh)
    # LONG 穿透区（bench > ask）：蓝色
    long_z = np.where(mask == 1.0, iv_bench_mesh * 100, np.nan)
    short_z = np.where(mask == -1.0, iv_bench_mesh * 100, np.nan)

    if not np.all(np.isnan(long_z)):
        traces.append(go.Surface(
            name="穿透 LONG 区（Bench > Ask）",
            x=K_mesh, y=T_days_mesh, z=long_z,
            colorscale=[[0, "rgba(59,130,246,0.0)"], [1, "rgba(59,130,246,0.85)"]],
            showscale=False, opacity=0.85,
            showlegend=True,
            hoverinfo="skip",
        ))

    if not np.all(np.isnan(short_z)):
        traces.append(go.Surface(
            name="穿透 SHORT 区（Bench < Bid）",
            x=K_mesh, y=T_days_mesh, z=short_z,
            colorscale=[[0, "rgba(168,85,247,0.0)"], [1, "rgba(168,85,247,0.85)"]],
            showscale=False, opacity=0.85,
            showlegend=True,
            hoverinfo="skip",
        ))

    # ── ⑤⑥ 离散异常点（隧道破位合约）──
    long_pts  = df[df["signal"] == "LONG"]
    short_pts = df[df["signal"] == "SHORT"]

    def _make_scatter(pts: pd.DataFrame, color: str, edge_color: str,
                      label: str, emoji: str, direction: str) -> go.Scatter3d:
        """构建异常点 Scatter3D trace，含完整分析 Tooltip。"""
        if pts.empty:
            return None

        # 悬停提示内容
        custom = []
        for _, r in pts.iterrows():
            spread_pct = r["spread_iv"] * 100
            pen_pct    = r["pen_depth"] * 100
            net_pct    = r["net_edge"] * 100
            warn       = "⚠ 价差过宽，慎执行" if r["slippage_warning"] else "✅ 价差可覆盖"
            action = "买入合约（Long Vega）" if direction == "LONG" else "卖出合约（Short Vega）"

            bench_pct = r["iv_bench"] * 100
            ask_pct   = r["iv_ask"] * 100
            bid_pct   = r["iv_bid"] * 100 if pd.notna(r["iv_bid"]) else float("nan")
            mid_pct   = r["iv_mid"] * 100 if "iv_mid" in r else float("nan")

            tip = (
                f"【{emoji} 隧道破位 {direction}】{r['instrument']}<br>"
                f"Strike: ${r['K']:,.0f} | Tenor: {r['T']*365:.0f}d<br>"
                f"─────────────────────────<br>"
                f"IV_bench: {bench_pct:.1f}%<br>"
                f"IV_ask:   {ask_pct:.1f}%<br>"
                f"IV_bid:   {bid_pct:.1f}%<br>"
                f"─────────────────────────<br>"
                f"价差宽度（隧道厚度）: {spread_pct:.1f}%<br>"
                f"穿透深度:            +{pen_pct:.1f}%<br>"
                f"扣除半价差后净边际:  {net_pct:.1f}%<br>"
                f"─────────────────────────<br>"
                f"执行逻辑: {action}<br>"
                f"回归收益估算: IV_bench {bench_pct:.1f}% → {'买入成本' if direction=='LONG' else '卖出所得'} {ask_pct if direction=='LONG' else bid_pct:.1f}%<br>"
                f"滑点评估: {warn}"
            )
            custom.append(tip)

        return go.Scatter3d(
            name=f"{emoji} {label} ({len(pts)})",
            x=pts["K"].values,
            y=(pts["T"].values * 365),
            z=pts["iv_bench"].values * 100,
            mode="markers+text",
            marker=dict(
                size=pts["pen_depth"].abs().clip(0.005, 0.15) / 0.15 * 8 + 6,
                color=color,
                symbol="diamond",
                opacity=0.95,
                line=dict(color=edge_color, width=2),
            ),
            text=[emoji] * len(pts),
            textposition="top center",
            textfont=dict(color=edge_color, size=9),
            customdata=custom,
            hovertemplate="%{customdata}<extra></extra>",
            showlegend=True,
        )

    long_trace  = _make_scatter(long_pts,  "#3b82f6", "#93c5fd",
                                "隧道破位 LONG（做多 Vega）", "🔵", "LONG")
    short_trace = _make_scatter(short_pts, "#a855f7", "#d8b4fe",
                                "隧道破位 SHORT（做空 Vega）", "🟣", "SHORT")

    if long_trace:
        traces.append(long_trace)
    if short_trace:
        traces.append(short_trace)

    return traces


# ─────────────────────────────────────────────
# Section 6: 统计摘要 HTML 面板
# ─────────────────────────────────────────────

def build_stats_annotation(df: pd.DataFrame, smooth: float) -> str:
    """生成右侧统计摘要 HTML（嵌入 Plotly Annotation）。"""
    long_pts  = df[df["signal"] == "LONG"]
    short_pts = df[df["signal"] == "SHORT"]
    fair_pts  = df[df["signal"] == "FAIR"]
    n_warn    = df[(df["signal"] != "FAIR") & df["slippage_warning"]].shape[0]

    top_long  = long_pts.nlargest(3, "pen_depth") if not long_pts.empty else pd.DataFrame()
    top_short = short_pts.nlargest(3, "pen_depth") if not short_pts.empty else pd.DataFrame()

    def fmt_row(r):
        bid_str = f"{r['iv_bid']*100:.1f}%" if pd.notna(r.get("iv_bid")) else "N/A"
        warn = " ⚠" if r["slippage_warning"] else ""
        return (f"{r['instrument']}<br>"
                f"  Bench={r['iv_bench']*100:.1f}% | Ask={r['iv_ask']*100:.1f}% | "
                f"Bid={bid_str}<br>"
                f"  穿透={r['pen_depth']*100:.2f}% | 净边际={r['net_edge']*100:.2f}%{warn}")

    long_rows  = "<br>".join(top_long.apply(fmt_row,  axis=1).tolist()) or "无"
    short_rows = "<br>".join(top_short.apply(fmt_row, axis=1).tolist()) or "无"

    return (
        f"<b>═══ 无套利隧道分析摘要 ═══</b><br><br>"
        f"<b>有效合约数：</b>{len(df)}<br>"
        f"<b>曲面平滑 λ：</b>{smooth}<br><br>"
        f"<b>🔵 LONG 机会（Bench > Ask）：</b>{len(long_pts)}<br>"
        f"<b>🟣 SHORT 机会（Bench < Bid）：</b>{len(short_pts)}<br>"
        f"<b>⬜ FAIR（定价有效）：</b>{len(fair_pts)}<br>"
        f"<b>⚠ 滑点预警（价差吃掉套利）：</b>{n_warn}<br><br>"
        f"<b>Top LONG 机会（按穿透深度）：</b><br>{long_rows}<br><br>"
        f"<b>Top SHORT 机会（按穿透深度）：</b><br>{short_rows}"
    )


# ─────────────────────────────────────────────
# Section 7: 主流程
# ─────────────────────────────────────────────

def main(smooth: float = 0.05, grid_points: int = 50):
    """
    完整流程：
    1. 抓取 Deribit 实时数据
    2. 清洗并反解 IV_bid / IV_ask / IV_mid（含 Bid=0 边界处理）
    3. 分别用 IV_mid / IV_bid / IV_ask 拟合三条 RBF 曲面
    4. 隧道穿透判定（LONG / SHORT / FAIR）
    5. 渲染三层 Plotly 3D 双曲面 + 穿透区域高亮 + 离散异常点
    6. 输出交互式 HTML 文件
    """
    print("═" * 55)
    print("  BTC 期权无套利隧道建模  v2.0")
    print("═" * 55)

    # Step 1: 数据抓取
    print("\n[1/5] 异步抓取 Deribit 实时盘口数据...")
    raw = asyncio.run(fetch_deribit_options())
    print(f"  原始数据条数：{len(raw)}")

    # Step 2: 清洗 + 双重 IV 反解
    model = BSModel(r=0.0)
    print("\n[2/5] 清洗数据，反解 IV_bid / IV_ask / IV_mid...")
    df = process_data(raw, model)
    if df.empty:
        print("⛔ 无有效数据，请检查网络或 Deribit 接口。")
        return
    print(f"  清洗后有效合约：{len(df)} 条")

    # Step 3: 拟合三条 RBF 曲面
    print(f"\n[3/5] 正则化 RBF 拟合曲面（smooth λ={smooth}）...")

    # Bench 曲面（用 Mid IV，最完整的样本）
    mid_valid = df.dropna(subset=["iv_mid"])
    K_bench, T_bench, IV_bench_mesh, bench_rbf = build_rbf_surface(
        mid_valid["K"].values, mid_valid["T"].values, mid_valid["iv_mid"].values,
        grid_points=grid_points, smooth=smooth)

    # Ask 曲面
    ask_valid = df.dropna(subset=["iv_ask"])
    _, _, _, ask_rbf = build_rbf_surface(
        ask_valid["K"].values, ask_valid["T"].values, ask_valid["iv_ask"].values,
        grid_points=grid_points, smooth=smooth)

    # Bid 曲面（iv_bid 可能有缺口，仅用有效行）
    bid_valid = df.dropna(subset=["iv_bid"])
    bid_rbf = None
    if len(bid_valid) >= 4:
        _, _, _, bid_rbf = build_rbf_surface(
            bid_valid["K"].values, bid_valid["T"].values, bid_valid["iv_bid"].values,
            grid_points=grid_points, smooth=smooth)
    else:
        print("  ⚠ IV_bid 有效样本不足（< 4），Bid Surface 将使用 Ask Surface 替代")
        bid_rbf = ask_rbf

    # Step 4: 在相同网格上计算 Ask / Bid 曲面
    IV_ask_mesh, IV_bid_mesh = build_tunnel_surface(
        K_bench, T_bench, IV_bench_mesh, bid_rbf, ask_rbf)

    # Step 5: 隧道穿透判定
    print("\n[4/5] 执行隧道穿透判定（LONG / SHORT / FAIR）...")
    df = classify_tunnel_breakout(df, bench_rbf)
    long_cnt  = (df["signal"] == "LONG").sum()
    short_cnt = (df["signal"] == "SHORT").sum()
    fair_cnt  = (df["signal"] == "FAIR").sum()
    warn_cnt  = df[(df["signal"] != "FAIR") & df["slippage_warning"]].shape[0]
    print(f"  LONG 信号：{long_cnt} | SHORT 信号：{short_cnt} | FAIR：{fair_cnt}")
    print(f"  滑点预警（价差吞没套利）：{warn_cnt} 条")

    # Step 6: 渲染
    print("\n[5/5] 渲染 Plotly 三层双曲面图...")
    traces = render_dual_surface(
        df, K_bench, T_bench,
        IV_bench_mesh, IV_ask_mesh, IV_bid_mesh,
        smooth_lambda=smooth)

    fig = go.Figure(data=traces)

    # 摘要 Annotation
    stats_html = build_stats_annotation(df, smooth)
    fig.add_annotation(
        text=stats_html,
        xref="paper", yref="paper",
        x=1.18, y=0.98,
        xanchor="left", yanchor="top",
        align="left",
        font=dict(family="monospace", size=10, color="#e2e8f0"),
        bgcolor="rgba(15,23,42,0.88)",
        bordercolor="#334155",
        borderwidth=1,
        showarrow=False,
    )

    # 图例 + 场景设置
    fig.update_layout(
        title=dict(
            text=(
                f"BTC 期权 · 无套利隧道双曲面  "
                f"<span style='font-size:14px;color:#94a3b8'>"
                f"实时数据 | λ={smooth} | "
                f"🔵 LONG×{long_cnt}  🟣 SHORT×{short_cnt}  ⬜ FAIR×{fair_cnt}</span>"
            ),
            font=dict(size=18, color="#f1f5f9"),
        ),
        scene=dict(
            xaxis=dict(title="Strike (K, USD)", color="#94a3b8",
                       gridcolor="#1e293b", backgroundcolor="rgba(0,0,0,0)"),
            yaxis=dict(title="Tenor (Days)", color="#94a3b8",
                       gridcolor="#1e293b", backgroundcolor="rgba(0,0,0,0)"),
            zaxis=dict(title="Implied Volatility (%)", color="#94a3b8",
                       gridcolor="#1e293b", backgroundcolor="rgba(0,0,0,0)"),
            camera=dict(eye=dict(x=1.6, y=-1.6, z=1.2)),
            bgcolor="rgba(2,6,23,1)",
        ),
        legend=dict(
            x=0.01, y=0.99,
            bgcolor="rgba(15,23,42,0.75)",
            bordercolor="#334155",
            borderwidth=1,
            font=dict(color="#e2e8f0", size=11),
        ),
        paper_bgcolor="#020617",
        plot_bgcolor="#020617",
        font=dict(color="#e2e8f0"),
        autosize=False,
        width=1400,
        height=900,
        margin=dict(l=20, r=340, b=20, t=70),
    )

    output = "btc_iv_tunnel.html"
    fig.write_html(output)
    print(f"\n✅ 渲染完成！输出文件：{output}")
    print("   在浏览器中打开即可自由旋转/缩放三层曲面并点击异常点查看详情。")
    print("═" * 55)

    # 同时打印 Top 机会摘要
    print("\n  ┌─ Top 3 LONG 机会（IV_bench > IV_ask）─")
    if not df[df["signal"]=="LONG"].empty:
        for _, r in df[df["signal"]=="LONG"].nlargest(3,"pen_depth").iterrows():
            bid_str = f"{r['iv_bid']*100:.1f}%" if pd.notna(r["iv_bid"]) else "N/A"
            warn = " ⚠滑点" if r["slippage_warning"] else ""
            print(f"  │ {r['instrument']:30s} "
                  f"bench={r['iv_bench']*100:.1f}% ask={r['iv_ask']*100:.1f}% "
                  f"穿透={r['pen_depth']*100:.2f}%{warn}")
    print("  └────────────────────────────────────")

    print("\n  ┌─ Top 3 SHORT 机会（IV_bench < IV_bid）─")
    if not df[df["signal"]=="SHORT"].empty:
        for _, r in df[df["signal"]=="SHORT"].nlargest(3,"pen_depth").iterrows():
            bid_str = f"{r['iv_bid']*100:.1f}%" if pd.notna(r["iv_bid"]) else "N/A"
            warn = " ⚠滑点" if r["slippage_warning"] else ""
            print(f"  │ {r['instrument']:30s} "
                  f"bench={r['iv_bench']*100:.1f}% bid={bid_str} "
                  f"穿透={r['pen_depth']*100:.2f}%{warn}")
    print("  └────────────────────────────────────\n")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(
        description="BTC 期权无套利隧道双曲面建模")
    parser.add_argument("--smooth", type=float, default=0.05,
                        help="RBF 正则化平滑因子（0=严格插值，0.05=弱平滑，0.2+=强平滑）")
    parser.add_argument("--grid",   type=int,   default=50,
                        help="曲面网格密度（默认 50×50）")
    args = parser.parse_args()
    main(smooth=args.smooth, grid_points=args.grid)
