import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'VolSurface — BTC 期权隐含波动率 3D 曲面',
  description: '实时抓取 Deribit BTC 期权数据，Newton-Raphson 反解 IV，RBF 插值构建 3D 波动率曲面',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body className={`${inter.className} bg-slate-950`}>{children}</body>
    </html>
  );
}
