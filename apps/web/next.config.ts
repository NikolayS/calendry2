import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for Dockerfile: ops/entrypoint.sh runs `node .next/standalone/server.js`
  output: "standalone",
};

export default nextConfig;
