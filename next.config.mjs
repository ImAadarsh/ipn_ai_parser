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
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
