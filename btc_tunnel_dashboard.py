"""
BTC 期权波动率隧道（Volatility Tunnel）交互式分析系统
=====================================================
技术栈  : Python + Dash + Plotly + Pandas + Scipy
版本    : 1.0
功能    :
  - 手动 [Sync Market Data] 触发数据抓取与曲面计算
  - 三层 3D 曲面：Bid Surface（绿色隧道下壁）/ Ask Surface（红色隧道上壁）/ Bench Surface（基准共识）
  - 穿透区域高亮：LONG 区（蓝色） / SHORT 区（金黄色）
  - 右侧面板：点击散点展示合约详情 + 隧道深度 + Z-Score 胜率 + 净期望(EV) + 滑点预警

运行:
  pip install dash dash-bootstrap-components pandas scipy aiohttp
  python btc_tunnel_dashboard.py
  浏览器访问 http://127.0.0.1:8050
"""

# ─────────────────────────────────────────────────────────
# 依赖导入
# ─────────────────────────────────────────────────────────
import asyncio
import threading
import warnings
from datetime import datetime
from typing import Optional

import aiohttp
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from scipy.interpolate import Rbf
from scipy.stats import norm

import dash
from dash import dcc, html, Input, Output, State, ctx, no_update
import dash_bootstrap_components as dbc

warnings.filterwarnings("ignore")

# ─────────────────────────────────────────────────────────
# ① Black-Scholes 工具类
# ─────────────────────────────────────────────────────────

class BSModel:
    """
    Black-Scholes 期权定价与 IV 数值反解。
    币圈期权惯例：无风险利率 r=0，无连续股息。
    """

    def __init__(self, r: float = 0.0):
        self.r = r

    def call_price(self, S, K, T, sigma):
        if T <= 0 or sigma <= 0:
            return max(S - K, 0.0)
        d1 = (np.log(S / K) + (self.r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
        d2 = d1 - sigma * np.sqrt(T)
        return S * norm.cdf(d1) - K * np.exp(-self.r * T) * norm.cdf(d2)

    def vega(self, S, K, T, sigma):
        """Vega = S√T·N'(d1)，Newton-Raphson 步长分母。"""
        if T <= 0 or sigma <= 0:
            return 0.0
        d1 = (np.log(S / K) + (self.r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
        return S * np.sqrt(T) * norm.pdf(d1)

    def iv_bisection(self, S, K, T, price, lo=0.001, hi=5.0, tol=1e-6, max_iter=200):
        """二分法退路，保证数值稳定性。"""
        for _ in range(max_iter):
            mid = (lo + hi) / 2.0
            diff = self.call_price(S, K, T, mid) - price
            if abs(diff) < tol:
                return mid
            lo, hi = (mid, hi) if diff < 0 else (lo, mid)
        return (lo + hi) / 2.0

    def iv_newton(self, S, K, T, price, sigma0=0.5, tol=1e-6, max_iter=100):
        """
        Newton-Raphson 主迭代反解 IV。
        【Bid=0 处理】: price ≤ 0 时立即返回 None，调用方需跳过。
        【内在价值保护】: 市价 ≤ 内在价值时无真实 IV，返回 None。
        """
        if price is None or price <= 0:
            return None
        intrinsic = max(S - K, 0.0)
        if price <= intrinsic + 1e-8:
            return None
        sigma = sigma0
        for _ in range(max_iter):
            c    = self.call_price(S, K, T, sigma)
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


# ─────────────────────────────────────────────────────────
# ② 数据层：抓取 + 清洗 + IV 反解
# ─────────────────────────────────────────────────────────

async def _fetch_raw():
    """异步从 Deribit 拉取 BTC 期权全量盘口快照。"""
    url = ("https://deribit.com/api/v2/public/get_book_summary_by_currency"
           "?currency=BTC&kind=option")
    async with aiohttp.ClientSession() as sess:
        async with sess.get(url, timeout=aiohttp.ClientTimeout(total=30)) as r:
            data = await r.json()
            return data.get("result", [])


def _run_async_fetch():
    """在独立线程+独立事件循环中运行异步抓取，避免与 Dash/Jupyter 事件循环冲突。"""
    result = []
    exc_holder = [None]

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result.extend(loop.run_until_complete(_fetch_raw()))
        except Exception as e:
            exc_holder[0] = e
        finally:
            loop.close()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=35)
    if exc_holder[0]:
        raise exc_holder[0]
    if t.is_alive():
        raise RuntimeError("抓取超时（35s），请检查网络是否可以访问 Deribit API。")
    return result


def fetch_and_process(smooth: float = 0.05) -> dict:
    """
    【手动同步的核心函数】
    被 Dash Callback 在独立线程中调用，执行完整的数据生命周期：
      1. 抓取原始数据
      2. 清洗 + 反解 IV_bid / IV_ask / IV_mid
      3. 拟合三条 RBF 曲面（Bench / Ask / Bid）
      4. 隧道穿透判定
    返回一个字典，供渲染层直接使用。

    【状态转换】:
      IDLE  ─→  SYNCING（按钮点击）
      SYNCING ─→  DONE（此函数返回）
      SYNCING ─→  ERROR（抓取/计算失败）
    """
    model = BSModel()
    now   = datetime.utcnow()

    # ── 抓取 ──
    raw = _run_async_fetch()
    if not raw:
        raise RuntimeError("Deribit API 返回空数据，请检查网络连接。")

    # ── 清洗 ──
    rows = []
    for item in raw:
        name   = item.get("instrument_name", "")
        parts  = name.split("-")
        if len(parts) != 4:
            continue
        _, expiry_str, strike_str, opt_type = parts
        if opt_type != "C":             # 只用 Call 建曲面
            continue

        bid_btc    = item.get("bid_price") or 0.0
        ask_btc    = item.get("ask_price")
        underlying = item.get("underlying_price")

        if not ask_btc or ask_btc <= 0 or not underlying:
            continue

        try:
            expiry = datetime.strptime(expiry_str, "%d%b%y").replace(
                hour=8, minute=0, second=0)
        except ValueError:
            continue

        T = (expiry - now).total_seconds() / (365 * 24 * 3600)
        if T <= 1 / 365:                # 剩余期限 < 1 天，短端 IV 极不稳定
            continue

        S = float(underlying)
        K = float(strike_str)
        if K < S * 0.4 or K > S * 2.0: # 过滤深度虚值/实值（插值外推失真）
            continue

        bid_usd = bid_btc * S
        ask_usd = ask_btc * S
        mid_usd = (bid_usd + ask_usd) / 2.0

        rows.append({"instrument": name, "S": S, "K": K, "T": T,
                     "bid_usd": bid_usd, "ask_usd": ask_usd, "mid_usd": mid_usd,
                     "expiry_str": expiry_str})

    if not rows:
        raise RuntimeError("清洗后无有效 Call 期权数据。")

    df = pd.DataFrame(rows)

    # ── 向量化反解 IV ──
    def _iv(row, col):
        return model.iv_newton(row["S"], row["K"], row["T"], row[col])

    df["iv_bid"] = df.apply(lambda r: _iv(r, "bid_usd"), axis=1)
    df["iv_ask"] = df.apply(lambda r: _iv(r, "ask_usd"), axis=1)
    df["iv_mid"] = df.apply(lambda r: _iv(r, "mid_usd"), axis=1)

    # 丢弃 IV_ask / IV_mid 无法反解的行
    df = df.dropna(subset=["iv_ask", "iv_mid"])
    df = df[(df["iv_mid"] > 0.05) & (df["iv_mid"] < 3.0)]
    df = df[(df["iv_ask"] > 0.05) & (df["iv_ask"] < 3.0)]

    # 【关键】剔除非法套利噪声：IV_bid > IV_ask（行情快照时差导致的噪声）
    # 理论上 Bid 价 ≤ Ask 价，反解出的 IV 应同样满足此约束。
    # 违反此约束的数据直接丢弃，防止污染 RBF 插值曲面。
    bad = df["iv_bid"].notna() & (df["iv_bid"] > df["iv_ask"])
    df  = df[~bad].reset_index(drop=True)

    df["iv_bid"] = df["iv_bid"].astype(float)

    # ── 拟合三条 RBF 曲面 ──
    def _fit_rbf(sub: pd.DataFrame, col: str):
        sub = sub.dropna(subset=[col])
        if len(sub) < 4:
            return None
        return Rbf(sub["K"].values, sub["T"].values, sub[col].values,
                   function="multiquadric", smooth=smooth)

    bench_rbf = _fit_rbf(df, "iv_mid")
    ask_rbf   = _fit_rbf(df, "iv_ask")
    bid_rbf   = _fit_rbf(df, "iv_bid") or ask_rbf   # Bid 缺口时 fallback

    if bench_rbf is None or ask_rbf is None:
        raise RuntimeError("IV 样本数量不足，无法拟合 RBF 曲面。")

    # ── 隧道穿透判定 ──
    #
    # 对每个实际合约点，用 RBF 评估基准 IV，再与该点的 IV_bid / IV_ask 比较：
    #   LONG  : IV_bench > IV_ask  → 即使以卖一价买入也低于理论共识，绝对低估
    #   SHORT : IV_bench < IV_bid  → 即使以买一价卖出也高于理论共识，绝对高估
    #   FAIR  : 理论价落在隧道内，不交易
    df["iv_bench"] = bench_rbf(df["K"].values, df["T"].values).clip(0.01)
    df["iv_bench_ask_rbf"] = ask_rbf(df["K"].values, df["T"].values).clip(0.01)
    df["iv_bench_bid_rbf"] = bid_rbf(df["K"].values, df["T"].values).clip(0.01)

    # 用 RBF 评估的 Bid/Ask 作为隧道边界（更平滑，减少离散点噪声）
    cond_long  = df["iv_bench"] > df["iv_bench_ask_rbf"]
    cond_short = df["iv_bench"] < df["iv_bench_bid_rbf"]

    df["signal"] = np.select([cond_long, cond_short], ["LONG", "SHORT"], default="FAIR")

    # 穿透深度（相对于隧道边界的距离）
    df["pen_depth"] = np.where(
        df["signal"] == "LONG",  df["iv_bench"] - df["iv_bench_ask_rbf"],
        np.where(
        df["signal"] == "SHORT", df["iv_bench_bid_rbf"] - df["iv_bench"],
        0.0))

    # 价差宽度（流动性成本 / 隧道厚度）
    df["spread_iv"] = (df["iv_bench_ask_rbf"] - df["iv_bench_bid_rbf"]).clip(0.001)

    # 净边际：穿透深度 - 半价差（执行成本）
    df["net_edge"] = df["pen_depth"] - df["spread_iv"] / 2.0

    # Z-Score：穿透深度 / 价差宽度 × 2（标准化，0.5 = 0.5σ 偏离）
    # 用于估算回归胜率：P = Φ(z_score)，即 z 越大胜率越高
    df["z_score"] = (df["pen_depth"] / (df["spread_iv"] / 2.0 + 1e-8)).clip(0, 10)
    df["win_prob"] = norm.cdf(df["z_score"] / 2.0)  # 保守估计，除以 2

    # EV 估算（以 IV 百分比为单位，代理盈亏）
    # EV = 胜率 × 穿透深度 - (1-胜率) × 半价差
    df["ev"] = df["win_prob"] * df["pen_depth"] - (1 - df["win_prob"]) * df["spread_iv"] / 2.0

    # 滑点预警：当价差 > 2 × 穿透深度时，利润空间被吞噬
    df["slippage_warn"] = df["spread_iv"] > 2 * df["pen_depth"].abs()

    # ── 网格计算（用于 3D 曲面渲染）──
    gp     = 50
    k_min, k_max = df["K"].min(), df["K"].max()
    t_min, t_max = df["T"].min(), df["T"].max()
    k_grid = np.linspace(k_min, k_max, gp)
    t_grid = np.linspace(t_min, t_max, gp)
    K_mesh, T_mesh = np.meshgrid(k_grid, t_grid)

    k_flat = K_mesh.flatten()
    t_flat = T_mesh.flatten()

    IV_bench = bench_rbf(k_flat, t_flat).clip(0.01).reshape(gp, gp)
    IV_ask   = ask_rbf(k_flat, t_flat).clip(0.01).reshape(gp, gp)
    IV_bid   = bid_rbf(k_flat, t_flat).clip(0.01).reshape(gp, gp)
    IV_ask   = np.maximum(IV_ask, IV_bid)   # 强制 Ask ≥ Bid（消除边缘外推噪声）

    return {
        "df":        df,
        "K_mesh":    K_mesh,
        "T_mesh":    T_mesh,
        "IV_bench":  IV_bench,
        "IV_ask":    IV_ask,
        "IV_bid":    IV_bid,
        "synced_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "n_total":   len(df),
        "n_long":    int((df["signal"] == "LONG").sum()),
        "n_short":   int((df["signal"] == "SHORT").sum()),
        "n_fair":    int((df["signal"] == "FAIR").sum()),
        "smooth":    smooth,
    }


# ─────────────────────────────────────────────────────────
# ③ 渲染层：构建 Plotly 三层曲面图
# ─────────────────────────────────────────────────────────

def _default_panel():
    """右侧面板默认占位内容（在 app.layout 构建之前定义）。"""
    # 此函数被 MAIN_CONTENT 的 children 直接调用，需先于 layout 定义
    from dash import html
    _c = {
        "bg":     "#020617",
        "panel":  "#0f172a",
        "border": "#1e293b",
        "accent": "#38bdf8",
        "muted":  "#94a3b8",
    }
    return html.Div([
        html.Div("── 交易分析面板 ──",
                 style={"color": _c["accent"], "fontSize": "13px",
                        "marginBottom": "16px", "letterSpacing": "0.05em"}),
        html.Div(
            "请先点击 [Sync Market Data] 同步市场数据，"
            "然后点击 3D 图中的蓝色/金色散点查看该合约的完整套利分析。",
            style={"color": _c["muted"], "fontSize": "12px",
                   "lineHeight": "1.8"}),
    ])


COLORS = {
    "bg":         "#020617",
    "panel_bg":   "#0f172a",
    "border":     "#1e293b",
    "text":       "#e2e8f0",
    "muted":      "#94a3b8",
    "accent":     "#38bdf8",
    "long":       "#3b82f6",
    "long_edge":  "#93c5fd",
    "short":      "#f59e0b",
    "short_edge": "#fde68a",
    "fair":       "#64748b",
    "warn":       "#ef4444",
    "ok":         "#22c55e",
}


def build_3d_figure(data: dict) -> go.Figure:
    """
    构建三层 3D 曲面 + 穿透高亮 + 异常点散点。

    图层顺序（从下到上）：
      [1] Bid Surface   — 绿色半透明，opacity 0.18（隧道下壁）
      [2] Ask Surface   — 红色半透明，opacity 0.18（隧道上壁）
      [3] Bench Surface — Viridis 色阶，opacity 0.75（基准共识曲面，带等高线）
      [4] 穿透 LONG 区  — 蓝色实体（Bench > Ask 的格点）
      [5] 穿透 SHORT 区 — 金黄色实体（Bench < Bid 的格点）
      [6] LONG 散点     — 蓝色钻石，大小 ∝ 穿透深度
      [7] SHORT 散点    — 金黄色钻石，大小 ∝ 穿透深度
    """
    df       = data["df"]
    K_mesh   = data["K_mesh"]
    T_mesh   = data["T_mesh"]
    IV_bench = data["IV_bench"] * 100   # 转百分比
    IV_ask   = data["IV_ask"]   * 100
    IV_bid   = data["IV_bid"]   * 100
    T_days   = T_mesh * 365

    traces = []

    # ── [1] Bid Surface（绿色，隧道下壁）──
    traces.append(go.Surface(
        name="Bid IV Surface（隧道下壁）",
        x=K_mesh, y=T_days, z=IV_bid,
        colorscale=[[0, "rgba(34,197,94,0.02)"], [1, "rgba(34,197,94,0.35)"]],
        showscale=False, opacity=0.18, showlegend=True,
        hovertemplate="Bid IV<br>K=$%{x:,.0f} T=%{y:.0f}d IV=%{z:.1f}%<extra></extra>",
        lighting=dict(ambient=0.8, diffuse=0.3),
    ))

    # ── [2] Ask Surface（红色，隧道上壁）──
    traces.append(go.Surface(
        name="Ask IV Surface（隧道上壁）",
        x=K_mesh, y=T_days, z=IV_ask,
        colorscale=[[0, "rgba(239,68,68,0.02)"], [1, "rgba(239,68,68,0.35)"]],
        showscale=False, opacity=0.18, showlegend=True,
        hovertemplate="Ask IV<br>K=$%{x:,.0f} T=%{y:.0f}d IV=%{z:.1f}%<extra></extra>",
        lighting=dict(ambient=0.8, diffuse=0.3),
    ))

    # ── [3] Bench Surface（基准共识，主视觉曲面）──
    traces.append(go.Surface(
        name="Bench IV（基准共识曲面）",
        x=K_mesh, y=T_days, z=IV_bench,
        colorscale="Viridis",
        showscale=True,
        colorbar=dict(title="IV_bench %", x=0.0, len=0.6,
                      tickfont=dict(color=COLORS["muted"], size=10),
                      titlefont=dict(color=COLORS["muted"])),
        opacity=0.75, showlegend=True,
        hovertemplate="Bench IV<br>K=$%{x:,.0f} T=%{y:.0f}d IV=%{z:.1f}%<extra></extra>",
        contours=dict(z=dict(show=True, color="rgba(255,255,255,0.3)", width=1)),
        lighting=dict(ambient=0.85, diffuse=0.4, specular=0.05),
    ))

    # ── [4] 穿透 LONG 区（Bench > Ask，蓝色）──
    long_z = np.where(IV_bench > IV_ask, IV_bench, np.nan)
    if not np.all(np.isnan(long_z)):
        traces.append(go.Surface(
            name="穿透区 LONG（Bench>Ask）",
            x=K_mesh, y=T_days, z=long_z,
            colorscale=[[0, "rgba(59,130,246,0.0)"], [1, "rgba(59,130,246,0.9)"]],
            showscale=False, opacity=0.88, showlegend=True, hoverinfo="skip",
        ))

    # ── [5] 穿透 SHORT 区（Bench < Bid，金黄色）──
    short_z = np.where(IV_bench < IV_bid, IV_bench, np.nan)
    if not np.all(np.isnan(short_z)):
        traces.append(go.Surface(
            name="穿透区 SHORT（Bench<Bid）",
            x=K_mesh, y=T_days, z=short_z,
            colorscale=[[0, "rgba(245,158,11,0.0)"], [1, "rgba(245,158,11,0.9)"]],
            showscale=False, opacity=0.88, showlegend=True, hoverinfo="skip",
        ))

    # ── [6][7] 离散异常点散点 ──
    def _scatter(pts: pd.DataFrame, sig: str, color: str, edge: str, emoji: str):
        if pts.empty:
            return None
        # 点大小：穿透深度越大越大（6~14 px）
        sizes = (pts["pen_depth"].abs().clip(0.005, 0.15) / 0.15 * 8 + 6).tolist()

        # 构建 customdata 用于右侧面板（JSON 格式字符串会在 Callback 中解析）
        cd = pts.apply(lambda r: {
            "instrument": r["instrument"],
            "K": r["K"], "T_days": round(r["T"] * 365, 1),
            "expiry": r.get("expiry_str", ""),
            "signal": sig,
            "iv_bench": round(r["iv_bench"] * 100, 2),
            "iv_ask":   round(r["iv_bench_ask_rbf"] * 100, 2),
            "iv_bid":   round(r["iv_bench_bid_rbf"] * 100, 2),
            "iv_mid":   round(r["iv_mid"] * 100, 2),
            "spread":   round(r["spread_iv"] * 100, 2),
            "pen_depth":round(r["pen_depth"] * 100, 3),
            "net_edge": round(r["net_edge"] * 100, 3),
            "z_score":  round(r["z_score"], 2),
            "win_prob": round(r["win_prob"] * 100, 1),
            "ev":       round(r["ev"] * 100, 3),
            "slippage_warn": bool(r["slippage_warn"]),
        }, axis=1).tolist()

        return go.Scatter3d(
            name=f"{emoji} {sig} ({len(pts)})",
            x=pts["K"].values,
            y=(pts["T"].values * 365),
            z=pts["iv_bench"].values * 100,
            mode="markers",
            marker=dict(
                size=sizes,
                color=color,
                symbol="diamond",
                opacity=0.95,
                line=dict(color=edge, width=1.5),
            ),
            customdata=cd,
            hovertemplate=(
                f"<b>{emoji} {sig} 隧道破位</b><br>"
                "%{customdata.instrument}<br>"
                "K=$%{x:,.0f} | T=%{y:.0f}d<br>"
                "IV_bench=%{z:.1f}%<br>"
                "<i>点击查看完整分析</i><extra></extra>"
            ),
            showlegend=True,
        )

    long_pts  = df[df["signal"] == "LONG"]
    short_pts = df[df["signal"] == "SHORT"]
    t_long  = _scatter(long_pts,  "LONG",  COLORS["long"],  COLORS["long_edge"],  "🔵")
    t_short = _scatter(short_pts, "SHORT", COLORS["short"], COLORS["short_edge"], "🟡")
    if t_long:  traces.append(t_long)
    if t_short: traces.append(t_short)

    # ── 布局 ──
    fig = go.Figure(data=traces)
    fig.update_layout(
        paper_bgcolor=COLORS["bg"],
        plot_bgcolor=COLORS["bg"],
        font=dict(color=COLORS["text"], family="monospace"),
        margin=dict(l=0, r=0, t=30, b=0),
        scene=dict(
            bgcolor="rgba(2,6,23,1)",
            xaxis=dict(title="Strike K (USD)", color=COLORS["muted"],
                       gridcolor=COLORS["border"], showbackground=False),
            yaxis=dict(title="Tenor (Days)",   color=COLORS["muted"],
                       gridcolor=COLORS["border"], showbackground=False),
            zaxis=dict(title="IV (%)",          color=COLORS["muted"],
                       gridcolor=COLORS["border"], showbackground=False),
            camera=dict(eye=dict(x=1.6, y=-1.6, z=1.2)),
            aspectmode="manual",
            aspectratio=dict(x=1.5, y=1.0, z=0.8),
        ),
        legend=dict(
            x=0.01, y=0.99,
            bgcolor="rgba(15,23,42,0.75)",
            bordercolor=COLORS["border"],
            font=dict(size=11),
        ),
        uirevision="tunnel",   # 防止用户旋转视角后因数据更新而重置
    )
    return fig


# ─────────────────────────────────────────────────────────
# ④ Dash 应用初始化
# ─────────────────────────────────────────────────────────

app = dash.Dash(
    __name__,
    external_stylesheets=[dbc.themes.SLATE],
    title="BTC Volatility Tunnel",
    suppress_callback_exceptions=True,
)

# ─────────────────────────────────────────────────────────
# ⑤ 布局：顶部导航栏 + 左侧 3D 图（70%）+ 右侧面板（30%）
# ─────────────────────────────────────────────────────────

def make_stat_card(label: str, value: str, color: str = COLORS["text"]):
    return html.Div([
        html.Div(label, style={"color": COLORS["muted"], "fontSize": "11px",
                               "fontFamily": "monospace", "marginBottom": "2px"}),
        html.Div(value, style={"color": color, "fontSize": "18px",
                               "fontWeight": "bold", "fontFamily": "monospace"}),
    ], style={"textAlign": "center", "padding": "8px 12px",
              "background": COLORS["panel_bg"],
              "borderRadius": "6px", "border": f"1px solid {COLORS['border']}",
              "minWidth": "80px"})


TOPBAR = dbc.Navbar(
    dbc.Container([
        # 品牌名
        dbc.NavbarBrand(
            html.Span([
                html.Span("⬡ ", style={"color": COLORS["accent"]}),
                "BTC Vol Tunnel",
            ], style={"fontFamily": "monospace", "fontSize": "18px",
                      "fontWeight": "bold", "color": COLORS["text"]}),
            style={"marginRight": "24px"},
        ),

        # 统计卡
        html.Div(id="stat-bar", style={"display": "flex", "gap": "10px",
                                        "flexWrap": "wrap", "flex": "1"}),

        # 同步控制区
        html.Div([
            html.Div(id="sync-status",
                     style={"color": COLORS["muted"], "fontSize": "12px",
                             "fontFamily": "monospace", "whiteSpace": "nowrap",
                             "marginRight": "12px"}),
            dbc.Button(
                [html.Span("⟳ ", id="sync-icon"), "Sync Market Data"],
                id="sync-btn",
                color="primary",
                size="sm",
                n_clicks=0,
                style={"fontFamily": "monospace", "fontWeight": "bold",
                       "letterSpacing": "0.05em", "whiteSpace": "nowrap"},
            ),
        ], style={"display": "flex", "alignItems": "center"}),

    ], fluid=True, style={"display": "flex", "alignItems": "center",
                           "gap": "12px", "padding": "6px 20px"}),
    color=COLORS["panel_bg"],
    dark=True,
    style={"borderBottom": f"1px solid {COLORS['border']}",
           "boxShadow": "0 2px 12px rgba(0,0,0,0.5)"},
)

MAIN_CONTENT = dbc.Row([
    # ── 左侧：3D 图（70%）──
    dbc.Col([
        dcc.Loading(
            id="loading-3d",
            type="circle",
            color=COLORS["accent"],
            children=dcc.Graph(
                id="tunnel-3d",
                figure=go.Figure(layout=dict(
                    paper_bgcolor=COLORS["bg"],
                    plot_bgcolor=COLORS["bg"],
                    scene=dict(bgcolor="rgba(2,6,23,1)"),
                    annotations=[dict(
                        text=(
                            "<b>点击 [Sync Market Data] 加载实时数据</b><br><br>"
                            "系统启动时不自动抓取，<br>请手动触发同步。"
                        ),
                        xref="paper", yref="paper", x=0.5, y=0.5,
                        xanchor="center", yanchor="middle",
                        font=dict(color=COLORS["muted"], size=14, family="monospace"),
                        showarrow=False,
                    )],
                )),
                style={"height": "calc(100vh - 70px)"},
                config={"scrollZoom": True, "displaylogo": False,
                        "modeBarButtonsToAdd": ["resetCameraLastSave3d"]},
            ),
        ),
    ], width=8, style={"padding": "0"}),

    # ── 右侧：分析面板（30%）──
    dbc.Col([
        html.Div(
            id="analysis-panel",
            children=_default_panel(),
            style={
                "height": "calc(100vh - 70px)",
                "overflowY": "auto",
                "padding": "16px 12px",
                "background": COLORS["panel_bg"],
                "borderLeft": f"1px solid {COLORS['border']}",
                "fontFamily": "monospace",
            },
        ),
    ], width=4, style={"padding": "0"}),
], style={"margin": "0", "flex": "1"}, className="g-0")

app.layout = html.Div([
    TOPBAR,
    MAIN_CONTENT,
    # 隐藏 Store：存储最新同步结果（序列化的 JSON）
    dcc.Store(id="market-data-store", storage_type="memory"),
    # 同步状态 Store：IDLE / SYNCING / DONE / ERROR
    dcc.Store(id="sync-state", data={"status": "IDLE", "msg": ""}),
    # 当前选中合约（点击列表行后写入）
    dcc.Store(id="selected-instrument", data=None),
], style={"background": COLORS["bg"], "minHeight": "100vh",
          "display": "flex", "flexDirection": "column"})


# ─────────────────────────────────────────────────────────
# ⑥ Callbacks
# ─────────────────────────────────────────────────────────

@app.callback(
    Output("market-data-store", "data"),
    Output("sync-state",        "data"),
    Input("sync-btn", "n_clicks"),
    State("sync-state", "data"),
    prevent_initial_call=True,
)
def trigger_sync(n_clicks, sync_state):
    """
    【手动同步状态机】

    IDLE/DONE/ERROR  ──[按钮点击]──→  SYNCING → DONE/ERROR

    注：使用独立线程运行异步抓取，避免与 Dash 事件循环冲突。
    """
    if n_clicks == 0:
        return no_update, no_update

    try:
        result = fetch_and_process(smooth=0.05)

        # 将 DataFrame 序列化为 JSON（只保留渲染所需列）
        df = result["df"]
        cols = ["instrument", "K", "T", "expiry_str",
                "iv_bid", "iv_ask", "iv_mid", "iv_bench",
                "iv_bench_ask_rbf", "iv_bench_bid_rbf",
                "signal", "pen_depth", "spread_iv", "net_edge",
                "z_score", "win_prob", "ev", "slippage_warn"]
        df_json = df[cols].to_json(orient="records")

        store = {
            "df_json":    df_json,
            "K_mesh":     result["K_mesh"].tolist(),
            "T_mesh":     result["T_mesh"].tolist(),
            "IV_bench":   result["IV_bench"].tolist(),
            "IV_ask":     result["IV_ask"].tolist(),
            "IV_bid":     result["IV_bid"].tolist(),
            "synced_at":  result["synced_at"],
            "n_total":    result["n_total"],
            "n_long":     result["n_long"],
            "n_short":    result["n_short"],
            "n_fair":     result["n_fair"],
        }
        new_state = {"status": "DONE", "msg": f"同步成功，{result['n_total']} 条合约"}
        return store, new_state

    except Exception as e:
        new_state = {"status": "ERROR", "msg": str(e)[:120]}
        return no_update, new_state


def _build_anomaly_list(df: pd.DataFrame) -> html.Div:
    """
    同步完成后，在右侧面板渲染所有异常点的摘要列表。
    每行包含：信号类型徽章、合约代码、行权价、穿透深度、净期望 EV。
    点击某行会触发 selected-instrument Store 更新，从而展开详情。
    """
    anomalies = df[df["signal"].isin(["LONG", "SHORT"])].copy()
    anomalies = anomalies.sort_values("pen_depth", ascending=False)

    if anomalies.empty:
        return html.Div([
            html.Div("── 异常点列表 ──", style={
                "color": COLORS["accent"], "fontSize": "13px",
                "marginBottom": "12px", "letterSpacing": "0.05em",
            }),
            html.Div("暂无穿透隧道的异常合约。",
                     style={"color": COLORS["muted"], "fontSize": "12px"}),
        ])

    rows = []
    for _, r in anomalies.iterrows():
        is_long   = r["signal"] == "LONG"
        sig_color = COLORS["long"] if is_long else COLORS["short"]
        sig_text  = "LONG" if is_long else "SHORT"
        ev_color  = COLORS["ok"] if r["ev"] > 0 else COLORS["warn"]
        inst      = r["instrument"]

        badge = html.Span(sig_text, style={
            "background": sig_color, "color": "#000",
            "fontSize": "10px", "fontWeight": "bold",
            "padding": "2px 6px", "borderRadius": "4px",
            "marginRight": "8px", "verticalAlign": "middle",
        })

        row_el = html.Div(
            id={"type": "anomaly-row", "index": inst},
            children=[
                # 左侧：徽章 + 合约名
                html.Div([
                    badge,
                    html.Span(inst, style={
                        "color": COLORS["text"], "fontSize": "12px",
                        "fontWeight": "bold",
                    }),
                    html.Br(),
                    html.Span(f"K=${r['K']:,.0f}  |  {r['expiry_str']}",
                              style={"color": COLORS["muted"], "fontSize": "11px",
                                     "marginLeft": "44px"}),
                ], style={"flex": "1"}),
                # 右侧：穿透深度 + EV
                html.Div([
                    html.Div(f"+{r['pen_depth']:.2f}%",
                             style={"color": sig_color, "fontSize": "12px",
                                    "fontWeight": "bold", "textAlign": "right"}),
                    html.Div(f"EV {r['ev']:+.2f}%",
                             style={"color": ev_color, "fontSize": "11px",
                                    "textAlign": "right"}),
                ]),
            ],
            style={
                "display": "flex", "alignItems": "center",
                "justifyContent": "space-between",
                "padding": "8px 10px",
                "marginBottom": "4px",
                "borderRadius": "6px",
                "border": f"1px solid {COLORS['border']}",
                "background": COLORS["panel_bg"],
                "cursor": "pointer",
                "transition": "border-color 0.15s",
            },
            n_clicks=0,
        )
        rows.append(row_el)

    header = html.Div([
        html.Span("异常点列表", style={
            "color": COLORS["accent"], "fontSize": "13px",
            "fontWeight": "bold", "letterSpacing": "0.05em",
        }),
        html.Span(f"  {len(anomalies)} 个合约穿透隧道",
                  style={"color": COLORS["muted"], "fontSize": "11px"}),
    ], style={"marginBottom": "10px", "paddingBottom": "8px",
              "borderBottom": f"1px solid {COLORS['border']}"})

    hint = html.Div("点击任意行查看详细分析 ↓",
                    style={"color": COLORS["muted"], "fontSize": "11px",
                           "marginBottom": "10px"})

    return html.Div([header, hint] + rows)


@app.callback(
    Output("tunnel-3d",      "figure"),
    Output("stat-bar",       "children"),
    Output("sync-status",    "children"),
    Output("sync-btn",       "disabled"),
    Output("analysis-panel", "children"),
    Input("market-data-store", "data"),
    Input("sync-state",        "data"),
    State("selected-instrument", "data"),
)
def update_ui(store, sync_state, selected_inst):
    """
    根据 Store 数据和同步状态更新 UI：
      - tunnel-3d      : 3D 曲面图
      - stat-bar       : 顶部统计卡（LONG / SHORT / FAIR 数量）
      - sync-status    : 状态文字（上次同步时间 / 错误信息）
      - sync-btn       : 按钮是否可点击
      - analysis-panel : 同步完成后自动渲染异常点列表
    """
    status = sync_state.get("status", "IDLE") if sync_state else "IDLE"

    # ── 按钮状态 ──
    btn_disabled = (status == "SYNCING")

    # ── 同步状态文字 ──
    if status == "IDLE":
        status_text = "未同步"
    elif status == "SYNCING":
        status_text = "⟳ 同步中..."
    elif status == "DONE" and store:
        status_text = f"上次同步：{store.get('synced_at', '')}"
    elif status == "ERROR":
        status_text = f"⚠ 错误：{sync_state.get('msg', '')}"
    else:
        status_text = ""

    # ── 无数据时返回占位图 ──
    if not store or status in ("IDLE", "SYNCING", "ERROR"):
        placeholder = go.Figure(layout=dict(
            paper_bgcolor=COLORS["bg"],
            scene=dict(bgcolor="rgba(2,6,23,1)"),
            annotations=[dict(
                text=(
                    "⟳ 同步中，请稍候..." if status == "SYNCING"
                    else f"⚠ {sync_state.get('msg','')}" if status == "ERROR"
                    else "<b>请点击 [Sync Market Data] 加载数据</b>"
                ),
                xref="paper", yref="paper", x=0.5, y=0.5,
                font=dict(color=COLORS["muted"], size=14, family="monospace"),
                showarrow=False,
            )],
        ))
        return placeholder, [], status_text, btn_disabled, _default_panel()

    # ── 还原 Store 数据 ──
    df = pd.read_json(store["df_json"], orient="records")
    data = {
        "df":       df,
        "K_mesh":   np.array(store["K_mesh"]),
        "T_mesh":   np.array(store["T_mesh"]),
        "IV_bench": np.array(store["IV_bench"]),
        "IV_ask":   np.array(store["IV_ask"]),
        "IV_bid":   np.array(store["IV_bid"]),
    }

    # ── 构建 3D 图 ──
    fig = build_3d_figure(data)

    # ── 统计卡 ──
    n_total = store.get("n_total", 0)
    n_long  = store.get("n_long",  0)
    n_short = store.get("n_short", 0)
    n_fair  = store.get("n_fair",  0)
    stat_cards = [
        make_stat_card("合约总数",  str(n_total),  COLORS["text"]),
        make_stat_card("🔵 LONG",   str(n_long),   COLORS["long"]),
        make_stat_card("🟡 SHORT",  str(n_short),  COLORS["short"]),
        make_stat_card("⬜ FAIR",   str(n_fair),   COLORS["fair"]),
    ]

    # ── 右侧面板：同步后自动显示异常点列表 ──
    # 若已有选中合约，保持详情展示；否则渲染列表
    if selected_inst:
        row_data = df[df["instrument"] == selected_inst]
        if not row_data.empty:
            panel = _build_detail_panel(row_data.iloc[0])
        else:
            panel = _build_anomaly_list(df)
    else:
        panel = _build_anomaly_list(df)

    return fig, stat_cards, status_text, btn_disabled, panel


def _build_detail_panel(r) -> html.Div:
    """
    根据 DataFrame 中一行数据构建合约详情面板。
    r 可以是 pd.Series（来自 df.iloc[0]）或含相同字段的对象。
    """
    inst      = r["instrument"]
    K         = r["K"]
    T_days    = r["T"] * 365
    expiry    = r["expiry_str"]
    signal    = r["signal"]
    iv_bench  = r["iv_bench"]   * 100
    iv_ask    = r["iv_ask"]     * 100 if r["iv_ask"]  else 0.0
    iv_bid    = r["iv_bid"]     * 100 if r["iv_bid"]  else 0.0
    iv_mid    = r["iv_mid"]     * 100 if r["iv_mid"]  else 0.0
    pen_depth = r["pen_depth"]  * 100
    net_edge  = r["net_edge"]   * 100
    _idx      = r.index if hasattr(r, "index") else []
    spread    = r["spread_iv"]  * 100 if "spread_iv" in _idx else abs(iv_ask - iv_bid)
    z_score   = r["z_score"]
    win_prob  = r["win_prob"]   * 100
    ev        = r["ev"]         * 100
    slipwarn  = bool(r["slippage_warn"])

    sig_color = COLORS["long"] if signal == "LONG" else COLORS["short"]
    sig_label = "🔵 LONG（做多 Vega）" if signal == "LONG" else "🟡 SHORT（做空 Vega）"
    ev_color  = COLORS["ok"] if ev > 0 else COLORS["warn"]

    def row(label, val, color=COLORS["text"], small=False):
        return html.Div([
            html.Span(label, style={"color": COLORS["muted"],
                                    "fontSize": "11px" if small else "12px",
                                    "minWidth": "120px", "display": "inline-block"}),
            html.Span(val,   style={"color": color,
                                    "fontSize": "12px" if small else "13px",
                                    "fontWeight": "bold"}),
        ], style={"padding": "4px 0", "borderBottom": f"1px solid {COLORS['border']}"})

    def section(title):
        return html.Div(title, style={
            "color": COLORS["accent"], "fontSize": "11px",
            "letterSpacing": "0.08em", "marginTop": "14px",
            "marginBottom": "6px", "textTransform": "uppercase",
        })

    warn_banner = html.Div([
        html.Span("⚠ 滑点预警", style={"color": COLORS["warn"], "fontWeight": "bold"}),
        html.Br(),
        html.Span("价差宽度 > 2 × 穿透深度，执行成本可能吞噬全部套利利润。"
                  "建议等待更优报价或降低仓位。",
                  style={"fontSize": "11px", "color": COLORS["muted"], "lineHeight": "1.6"}),
    ], style={"background": "rgba(239,68,68,0.12)",
              "border": f"1px solid {COLORS['warn']}",
              "borderRadius": "6px", "padding": "10px",
              "marginBottom": "12px"}) if slipwarn else html.Div()

    ok_banner = html.Div([
        html.Span("✅ 可执行信号", style={"color": COLORS["ok"], "fontWeight": "bold"}),
        html.Br(),
        html.Span("净期望收益为正，价差已被穿透深度覆盖。建议结合持仓限额和 Delta 对冲执行。",
                  style={"fontSize": "11px", "color": COLORS["muted"], "lineHeight": "1.6"}),
    ], style={"background": "rgba(34,197,94,0.10)",
              "border": f"1px solid {COLORS['ok']}",
              "borderRadius": "6px", "padding": "10px",
              "marginBottom": "12px"}) if (ev > 0 and not slipwarn) else html.Div()

    if signal == "LONG":
        exec_text = (f"基准共识 IV（{iv_bench:.1f}%）完全高于卖一价 IV（{iv_ask:.1f}%），"
                     f"以卖一价买入后，预期 IV 向基准回归可获得 +{pen_depth:.2f}% 的 IV 收益。")
    else:
        exec_text = (f"基准共识 IV（{iv_bench:.1f}%）完全低于买一价 IV（{iv_bid:.1f}%），"
                     f"以买一价卖出后，预期 IV 向基准回归可获得 +{pen_depth:.2f}% 的 IV 收益。")

    # 返回列表按钮（回到列表）
    back_btn = html.Div(
        "← 返回列表",
        id="back-to-list",
        n_clicks=0,
        style={
            "color": COLORS["accent"], "fontSize": "12px", "cursor": "pointer",
            "marginBottom": "14px", "display": "inline-block",
            "borderBottom": f"1px solid {COLORS['accent']}",
        },
    )

    return html.Div([
        back_btn,
        html.Div([
            html.Div(sig_label, style={"color": sig_color, "fontSize": "15px",
                                       "fontWeight": "bold"}),
            html.Div(inst, style={"color": COLORS["text"], "fontSize": "20px",
                                  "fontWeight": "bold", "marginTop": "4px"}),
        ], style={"marginBottom": "12px"}),

        warn_banner,
        ok_banner,

        section("① 合约信息"),
        row("代码",     inst),
        row("行权价",   f"${K:,.0f}"),
        row("到期日",   expiry),
        row("剩余天数", f"{T_days:.0f} 天"),

        section("② 波动率隧道定位"),
        row("IV_bench（基准共识）",   f"{iv_bench:.2f}%", COLORS["accent"]),
        row("IV_ask（隧道上壁）",     f"{iv_ask:.2f}%",   "#ef4444"),
        row("IV_bid（隧道下壁）",     f"{iv_bid:.2f}%",   "#22c55e"),
        row("IV_mid（市场中间价）",   f"{iv_mid:.2f}%"),
        row("价差宽度（流动性成本）", f"{spread:.2f}%",
            COLORS["warn"] if slipwarn else COLORS["muted"]),

        section("③ 隧道穿透深度"),
        row("穿透深度", f"+{pen_depth:.3f}%", sig_color),
        row("净边际",   f"{net_edge:+.3f}%",
            COLORS["ok"] if net_edge > 0 else COLORS["warn"]),

        section("④ 量化预测（基于 Z-Score）"),
        row("Z-Score（标准化偏离）", f"{z_score:.2f}σ"),
        row("回归胜率（Φ(z/2)）",   f"{win_prob:.1f}%",
            COLORS["ok"] if win_prob > 60 else COLORS["muted"]),
        row("净期望 EV",             f"{ev:+.3f}%", ev_color),

        section("⑤ 执行逻辑"),
        html.Div(exec_text, style={
            "color": COLORS["muted"], "fontSize": "11px",
            "lineHeight": "1.7", "padding": "8px", "marginTop": "4px",
            "background": "rgba(30,41,59,0.6)", "borderRadius": "6px",
        }),

        html.Div(
            "注：Z-Score 胜率基于历史 IV 回归分布估算，不构成投资建议。"
            "实际执行需考虑 Delta / Gamma / Vega 对冲成本。",
            style={"color": "#475569", "fontSize": "10px",
                   "marginTop": "20px", "lineHeight": "1.6"},
        ),
    ])


@app.callback(
    Output("analysis-panel",       "children", allow_duplicate=True),
    Output("selected-instrument",  "data"),
    Input({"type": "anomaly-row", "index": dash.ALL}, "n_clicks"),
    State("market-data-store", "data"),
    prevent_initial_call=True,
)
def on_list_row_click(n_clicks_list, store):
    """
    用户点击右侧异常点列表中的某一行时触发。
    - 写入 selected-instrument Store（记住当前选中合约）
    - 渲染该合约的完整套利分析详情面板
    """
    if not store or not any(n_clicks_list):
        return no_update, no_update

    # 找出被点击的那一行（n_clicks 最大的那个，即刚刚点击的）
    triggered = ctx.triggered_id
    if not triggered or not isinstance(triggered, dict):
        return no_update, no_update

    inst = triggered.get("index")
    if not inst:
        return no_update, no_update

    df = pd.read_json(store["df_json"], orient="records")
    row_data = df[df["instrument"] == inst]
    if row_data.empty:
        return no_update, no_update

    return _build_detail_panel(row_data.iloc[0]), inst


@app.callback(
    Output("analysis-panel",      "children", allow_duplicate=True),
    Output("selected-instrument", "data",     allow_duplicate=True),
    Input("back-to-list", "n_clicks"),
    State("market-data-store", "data"),
    prevent_initial_call=True,
)
def on_back_to_list(n_clicks, store):
    """
    用户点击"← 返回列表"时，清除选中状态，重新渲染异常点列表。
    """
    if not n_clicks or not store:
        return no_update, no_update
    df = pd.read_json(store["df_json"], orient="records")
    return _build_anomaly_list(df), None


# ─────────────────────────────────────────────────────────
# ⑦ 入口
# ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="BTC 波动率隧道交互式看板")
    parser.add_argument("--port",  type=int, default=8050, help="监听端口")
    parser.add_argument("--debug", action="store_true",   help="开启 Dash debug 模式")
    args = parser.parse_args()

    print("═" * 55)
    print("  BTC Volatility Tunnel Dashboard  v1.0")
    print(f"  访问：http://127.0.0.1:{args.port}")
    print("  点击 [Sync Market Data] 开始分析")
    print("═" * 55)

    app.run(debug=args.debug, port=args.port, host="0.0.0.0")
