import type { NextConfig } from "next";

const config: NextConfig = {
  // The data layer (and the MongoDB driver) run as plain Node modules on the server, never bundled.
  serverExternalPackages: ["mongodb", "@claim-coordinator/db"],
  // Don't write an AGENTS.md into the app directory.
  agentRules: false,
};
export default config;
