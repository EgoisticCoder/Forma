import type { NextConfig } from "next";
import path from "node:path";
const config: NextConfig = { output: "standalone", outputFileTracingRoot: path.resolve(__dirname, "..") };
export default config;
