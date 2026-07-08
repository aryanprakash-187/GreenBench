/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // pdf-parse ships four pdf.js builds (~29MB) and loads one at runtime via
    // a dynamic require. Webpack can't statically resolve which, so without
    // this it bundles all four into the server build and dev compilation
    // balloons to 100+ seconds. Marking it external means Node `require()`s
    // pdf-parse from node_modules at runtime; the other three pdf.js builds
    // are never touched.
    serverComponentsExternalPackages: ['pdf-parse'],
  },
};

module.exports = nextConfig;
