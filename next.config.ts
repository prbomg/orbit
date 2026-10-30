import type { NextConfig } from "next";
const config: NextConfig = {
  trailingSlash: true,
  serverExternalPackages: ["fingerprint-generator"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
    ] }];
  },
};
export default config;
