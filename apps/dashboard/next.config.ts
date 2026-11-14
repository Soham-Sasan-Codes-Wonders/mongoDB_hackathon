import type { NextConfig } from "next";

const config: NextConfig = {
  // The data layer (and the MongoDB driver) run as plain Node modules on the server, never bundled.
  serverExternalPackages: ["mongodb", "@claim-coordinator/db"],
  // Don't write an AGENTS.md into the app directory.
  agentRules: false,
  // No floating dev badge over the chat composer / demo panel.
  devIndicators: false,
  // Damage photos are uploaded through server actions; the 1 MB default rejects most phone photos.
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
};
export default config;
