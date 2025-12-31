/**
 * Voice routes for Cloudflare Workers
 *
 * Migrated from Fastify voice routes.
 * Provides voice token generation for 11Labs integration.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";

// Create voice router
const voice = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Routes ====================

// POST /voice/token - Get voice conversation token
const voiceTokenSchema = z.object({
    agentId: z.string(),
    revenueCatPublicKey: z.string().optional(),
});

voice.post("/token", authMiddleware, zValidator("json", voiceTokenSchema), async (c) => {
    const userId = c.get("userId");
    const { agentId, revenueCatPublicKey } = c.req.valid("json");

    const isDevelopment = c.env.ENVIRONMENT === "development";

    // Production requires RevenueCat key
    if (!isDevelopment && !revenueCatPublicKey) {
        return c.json({
            allowed: false,
            error: "RevenueCat public key required",
        }, 400);
    }

    // Check subscription in production
    if (!isDevelopment && revenueCatPublicKey) {
        const response = await fetch(
            `https://api.revenuecat.com/v1/subscribers/${userId}`,
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${revenueCatPublicKey}`,
                    "Content-Type": "application/json",
                },
            }
        );

        if (!response.ok) {
            return c.json({
                allowed: false,
                agentId,
            });
        }

        const data = (await response.json()) as {
            subscriber?: {
                entitlements?: {
                    active?: {
                        pro?: unknown;
                    };
                };
            };
        };
        const proEntitlement = data.subscriber?.entitlements?.active?.pro;

        if (!proEntitlement) {
            return c.json({
                allowed: false,
                agentId,
            });
        }
    }

    // Check if 11Labs API key is configured
    const elevenLabsApiKey = c.env.ELEVENLABS_API_KEY;
    if (!elevenLabsApiKey) {
        return c.json({
            allowed: false,
            error: "Missing 11Labs API key on the server",
        }, 400);
    }

    // Get 11Labs conversation token
    const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`,
        {
            method: "GET",
            headers: {
                "xi-api-key": elevenLabsApiKey,
                Accept: "application/json",
            },
        }
    );

    if (!response.ok) {
        return c.json({
            allowed: false,
            error: `Failed to get 11Labs token for user ${userId}`,
        }, 400);
    }

    const data = (await response.json()) as { token: string };
    const token = data.token;

    return c.json({
        allowed: true,
        token,
        agentId,
    });
});

export { voice };
