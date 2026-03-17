import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow Clerk avatar images
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "img.clerk.com",
      },
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
    ],
  },
};

export default nextConfig;
