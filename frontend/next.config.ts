import type { NextConfig } from "next";
import path from "path";

const BACKEND_URL =
    process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const securityHeaders = (cameraPolicy: "()" | "(self)") => [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
        key: "Permissions-Policy",
        value: `camera=${cameraPolicy}, microphone=(), geolocation=(), payment=(), usb=()`,
    },
];

const nextConfig: NextConfig = {
    reactCompiler: true,
    // The app is built against trailing-slash URLs throughout — leaving this off
    // makes every internal link redirect once, and breaks the /api rewrite match.
    trailingSlash: true,
    allowedDevOrigins: ["localhost", "127.0.0.1"],
    turbopack: { root: path.join(__dirname) },
    experimental: {
        // How long the rewrite proxy below waits for the backend before it
        // gives up. The default is 30 seconds, and a request that outlives it
        // dies as `ECONNRESET — socket hang up` on this side while the backend
        // runs happily to completion — no error, no log, nothing to point at.
        // The HYFIT roster pull is the one request that reaches that mark: it
        // writes 2500 entries in a single transaction.
        proxyTimeout: 300_000,
    } as any,
    // Proxies browser-side /api/* calls through this Next.js server instead
    // of hitting the backend's own host directly. Without this, whenever the
    // frontend and backend are on different hosts (e.g. localhost vs a LAN
    // IP in local dev), the backend's session cookie is scoped to its own
    // host and the browser silently drops it on cross-site requests — login
    // appears to succeed but the session never actually sticks, with no
    // visible error anywhere. Routing through one origin fixes that at the
    // root instead of special-casing cookie flags per environment.
    async rewrites() {
        return [
            {
                source: "/api/:path*",
                destination: `${BACKEND_URL}/api/:path*`,
            },
        ];
    },
    // In Novarace the root of the site is the main race portal and HYFIT hangs
    // off /hyfitgames. Here HYFIT is the whole app, but the routes keep their
    // /hyfitgames prefix so every internal link, cookie path and API path stays
    // byte-identical to production — only the bare root needs somewhere to go.
    async redirects() {
        return [
            {
                source: "/",
                destination: "/hyfitgames/",
                permanent: false,
            },
        ];
    },
    async headers() {
        return [
            {
                // Camera access stays disabled by default.
                source: "/:path*",
                headers: securityHeaders("()"),
            },
            {
                // Next applies later matching header entries last. The two
                // HYFIT field apps are the only part of the frontend allowed
                // to request a camera.
                source: "/hyfitgames/judge/:path*",
                headers: securityHeaders("(self)"),
            },
            {
                // Check-in is the heavier camera user of the two: every athlete
                // is a BIB scan, an asset scan, and often a photo.
                source: "/hyfitgames/checkin/:path*",
                headers: securityHeaders("(self)"),
            },
        ];
    },
    images: {
        unoptimized: true,
        formats: ["image/webp", "image/avif"],
        minimumCacheTTL: 86400,
        deviceSizes: [640, 750, 828, 1080, 1200],
        imageSizes: [64, 96, 128, 200, 256, 384],
        remotePatterns: [
            { protocol: "https", hostname: "**.amazonaws.com" },
            { protocol: "https", hostname: "photos.9pic.ai" },
            { protocol: "https", hostname: "**.cloudfront.net" },
        ],
    },
};

export default nextConfig;
