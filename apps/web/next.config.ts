import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for Dockerfile: ops/entrypoint.sh runs `node .next/standalone/server.js`
  output: "standalone",
  // Point output file tracing to the monorepo root so Next.js finds the correct lockfile.
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;
