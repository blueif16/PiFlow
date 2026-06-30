import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root — multiple lockfiles exist above this dir.
  turbopack: { root: __dirname },
  experimental: {
    // Swaps in React's <ViewTransition> + auto-wraps route navigations in the
    // View Transitions API, so the gallery → node-detail morph is native.
    viewTransition: true,
  },
};

export default nextConfig;
