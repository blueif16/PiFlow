import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root — multiple lockfiles exist above this dir.
  turbopack: { root: __dirname },
};

export default nextConfig;
