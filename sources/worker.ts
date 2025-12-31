/**
 * Cloudflare Workers entry point
 *
 * This file serves as the main entry point for the Happy Server running on
 * Cloudflare Workers. It sets up the Hono app with middleware and routes,
 * and exports the Durable Object classes.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { v1 } from "@/worker/routes/v1";
import { v2Sessions } from "@/worker/routes/v2Sessions";

// Environment bindings type
export interface Env {
    // D1 Database
    DB: D1Database;

    // KV Namespace for caching
    CACHE: KVNamespace;

    // R2 Bucket for file storage
    FILES: R2Bucket;

    // Durable Objects
    CONNECTION_MANAGER: DurableObjectNamespace;
    LOCK_MANAGER: DurableObjectNamespace;

    // Secrets (set via wrangler secret put)
    JWT_SECRET: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    GITHUB_REDIRECT_URL?: string;
    GITHUB_WEBHOOK_SECRET?: string;
    HANDY_MASTER_SECRET?: string;

    // Variables
    ENVIRONMENT: string;
    FILES_PUBLIC_URL?: string;
    ELEVENLABS_API_KEY?: string;
}

// Create Hono app with environment bindings
const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use("*", logger());
app.use("*", cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length"],
    maxAge: 86400,
}));

// Health check endpoint
app.get("/health", (c) => {
    return c.json({
        status: "ok",
        environment: c.env.ENVIRONMENT,
        timestamp: new Date().toISOString(),
    });
});

// Root endpoint
app.get("/", (c) => {
    return c.json({
        name: "happy-server",
        version: "2.0.0",
        runtime: "cloudflare-workers",
    });
});

// Mount API v1 routes
app.route("/v1", v1);

// Mount API v2 routes
app.route("/v2/sessions", v2Sessions);

// 404 handler
app.notFound((c) => {
    return c.json({ error: "Not Found" }, 404);
});

// Error handler
app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json({
        error: "Internal Server Error",
        message: c.env.ENVIRONMENT === "development" ? err.message : undefined,
    }, 500);
});

// Export the fetch handler
export default app;

// Export Durable Object classes
export { ConnectionManager } from "@/modules/realtime/ConnectionManager";
export { LockManager } from "@/modules/lock/LockManager";
