import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 允许 Deribit / Polygon 跨域
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
      },
    ];
  },
};

export default nextConfig;
