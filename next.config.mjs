/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "pdfjs-dist",
      "@napi-rs/canvas",
      "sharp",
      "mysql2",
    ],
    serverActions: {
      bodySizeLimit: "200mb",
    },
  },
};

export default nextConfig;
