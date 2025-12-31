/**
 * Feed routes for Cloudflare Workers
 *
 * Migrated from Fastify feed routes.
 * Provides feed retrieval with pagination.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";
import { Prisma, PrismaClient } from "@prisma/client";
import { FeedBodySchema } from "@/app/feed/types";

// Create feed router
const feed = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Types ====================

interface FeedOptions {
    cursor?: {
        before?: string;
        after?: string;
    };
    limit?: number;
}

interface FeedItem {
    id: string;
    body: unknown;
    repeatKey: string | null;
    cursor: string;
    createdAt: number;
}

interface FeedResult {
    items: FeedItem[];
    hasMore: boolean;
}

// ==================== Helper Functions ====================

/**
 * Fetch user's feed with pagination (Worker-compatible version).
 * Returns items in reverse chronological order (newest first).
 * Supports cursor-based pagination using the counter field.
 */
async function feedGetWorker(
    prisma: PrismaClient,
    uid: string,
    options?: FeedOptions
): Promise<FeedResult> {
    const limit = options?.limit ?? 100;
    const cursor = options?.cursor;

    // Build where clause for cursor pagination
    const where: Prisma.UserFeedItemWhereInput = { userId: uid };

    if (cursor?.before !== undefined) {
        if (cursor.before.startsWith("0-")) {
            where.counter = { lt: parseInt(cursor.before.substring(2), 10) };
        } else {
            throw new Error("Invalid cursor format");
        }
    } else if (cursor?.after !== undefined) {
        if (cursor.after.startsWith("0-")) {
            where.counter = { gt: parseInt(cursor.after.substring(2), 10) };
        } else {
            throw new Error("Invalid cursor format");
        }
    }

    // Fetch items + 1 to determine hasMore
    const items = await prisma.userFeedItem.findMany({
        where,
        orderBy: { counter: "desc" },
        take: limit + 1,
    });

    // Check if there are more items
    const hasMore = items.length > limit;

    // Return only requested limit
    return {
        items: items.slice(0, limit).map((item) => ({
            id: item.id,
            body: item.body,
            repeatKey: item.repeatKey,
            cursor: "0-" + item.counter.toString(10),
            createdAt: item.createdAt.getTime(),
        })),
        hasMore,
    };
}

// ==================== Routes ====================

// GET /feed - Get user's feed
const feedQuerySchema = z.object({
    before: z.string().optional(),
    after: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
}).optional();

feed.get("/", authMiddleware, zValidator("query", feedQuerySchema), async (c) => {
    const userId = c.get("userId");
    const query = c.req.valid("query") || {};
    const prisma = getPrisma(c.env.DB);

    const result = await feedGetWorker(prisma, userId, {
        cursor: {
            before: query.before,
            after: query.after,
        },
        limit: query.limit,
    });

    return c.json({
        items: result.items,
        hasMore: result.hasMore,
    });
});

export { feed };
