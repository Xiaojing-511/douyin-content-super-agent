import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["postgres", "pg"],
  // 浏览器若用 127.0.0.1 打开，开发态的脚本和热更新也要放行。
  allowedDevOrigins: ["127.0.0.1"],
  agentRules: false,
};

export default nextConfig;
