/**
 * WebSocket routes for real-time updates.
 *
 * Replaces Socket.io with native WebSocket via Durable Objects.
 * Handles the /v1/updates path for client connections.
 */

import { Hono } from "hono";
import type { Env } from "@/worker";
import { verifyToken } from "@/worker/auth";

// Create WebSocket router
const websocket = new Hono<{ Bindings: Env }>();

/**
 * WebSocket upgrade endpoint.
 *
 * Clients connect to this endpoint with authentication token and
 * optional client type information.
 *
 * Query parameters:
 * - token: JWT authentication token (required)
 * - clientType: 'session-scoped' | 'user-scoped' | 'machine-scoped' (optional, default: user-scoped)
 * - sessionId: Session ID for session-scoped clients
 * - machineId: Machine ID for machine-scoped clients
 */
websocket.get("/", async (c) => {
    // Check for WebSocket upgrade
    const upgradeHeader = c.req.header("Upgrade");
    if (upgradeHeader !== "websocket") {
        return c.json({ error: "Expected WebSocket upgrade" }, 426);
    }

    // Get authentication token
    const token = c.req.query("token");
    if (!token) {
        return c.json({ error: "Missing authentication token" }, 401);
    }

    // Verify token
    const verified = await verifyToken(token, c.env.JWT_SECRET);
    if (!verified) {
        return c.json({ error: "Invalid authentication token" }, 401);
    }

    const userId = verified.userId;
    const clientType = c.req.query("clientType") || "user-scoped";
    const sessionId = c.req.query("sessionId");
    const machineId = c.req.query("machineId");

    // Validate client type requirements
    if (clientType === "session-scoped" && !sessionId) {
        return c.json({ error: "Session ID required for session-scoped clients" }, 400);
    }
    if (clientType === "machine-scoped" && !machineId) {
        return c.json({ error: "Machine ID required for machine-scoped clients" }, 400);
    }

    // Get the ConnectionManager DO for this user
    const id = c.env.CONNECTION_MANAGER.idFromName(userId);
    const stub = c.env.CONNECTION_MANAGER.get(id);

    // Build URL with connection metadata
    const url = new URL("http://internal/websocket");
    url.searchParams.set("userId", userId);
    url.searchParams.set("clientType", clientType);
    if (sessionId) url.searchParams.set("sessionId", sessionId);
    if (machineId) url.searchParams.set("machineId", machineId);

    // Forward the WebSocket upgrade to the DO
    return stub.fetch(url.toString(), {
        headers: c.req.raw.headers,
    });
});

export { websocket };
