/**
 * Push token routes for Cloudflare Workers
 *
 * Migrated from Fastify push routes.
 * Provides push token registration and management.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";

// Create push router
const push = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Routes ====================

// POST /push-tokens - Register push token
const registerTokenSchema = z.object({
    token: z.string(),
});

push.post("/", authMiddleware, zValidator("json", registerTokenSchema), async (c) => {
    const userId = c.get("userId");
    const { token } = c.req.valid("json");
    const prisma = getPrisma(c.env.DB);

    await prisma.accountPushToken.upsert({
        where: {
            accountId_token: {
                accountId: userId,
                token: token,
            },
        },
        update: {
            updatedAt: new Date(),
        },
        create: {
            accountId: userId,
            token: token,
        },
    });

    return c.json({ success: true });
});

// DELETE /push-tokens/:token - Delete push token
const deleteTokenParamSchema = z.object({
    token: z.string(),
});

push.delete("/:token", authMiddleware, zValidator("param", deleteTokenParamSchema), async (c) => {
    const userId = c.get("userId");
    const { token } = c.req.valid("param");
    const prisma = getPrisma(c.env.DB);

    await prisma.accountPushToken.deleteMany({
        where: {
            accountId: userId,
            token: token,
        },
    });

    return c.json({ success: true });
});

// GET /push-tokens - Get all push tokens
push.get("/", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const prisma = getPrisma(c.env.DB);

    const tokens = await prisma.accountPushToken.findMany({
        where: {
            accountId: userId,
        },
        orderBy: {
            createdAt: "desc",
        },
    });

    return c.json({
        tokens: tokens.map((t) => ({
            id: t.id,
            token: t.token,
            createdAt: t.createdAt.getTime(),
            updatedAt: t.updatedAt.getTime(),
        })),
    });
});

export { push };
