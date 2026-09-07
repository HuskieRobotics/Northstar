/** @type {import('next').NextConfig} */
const nextConfig = {
  // The vendored NT4 client and the discovery/log/proxy code are Node-only.
  serverExternalPackages: ["@msgpack/msgpack"],
  // Read-only app; no image optimization needed.
  images: { unoptimized: true },
};

export default nextConfig;
