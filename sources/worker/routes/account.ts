/**
 * Account routes for Cloudflare Workers
 *
 * Migrated from Fastify account routes.
 * Provides account profile, settings, and usage query endpoints.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";
// TODO: Uncomment when real-time migration is complete
// import { allocateUserSeq } from "@/worker/utils/seq";
// import { randomKey } from "@/worker/utils/randomKey";

// Create account router
const account = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// Create usage router
const usage = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Types ====================

interface ImageRef {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}

interface GitHubProfile {
    login: string;
    id: number;
    avatar_url: string;
    name: string | null;
    email: string | null;
}

interface UsageReportData {
    tokens: Record<string, number>;
    cost: Record<string, number>;
}

// ==================== Helper Functions ====================

/**
 * Get public URL for a file path.
 * Uses the FILES_PUBLIC_URL environment variable.
 */
function getPublicUrl(env: Env, path: string): string {
    const baseUrl = env.FILES_PUBLIC_URL || "";
    return `${baseUrl}/${path}`;
}

// ==================== Account Routes ====================

// GET /account/profile - Get user profile
account.get("/profile", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const prisma = getPrisma(c.env.DB);

    const user = await prisma.account.findUnique({
        where: { id: userId },
        select: {
            firstName: true,
            lastName: true,
            username: true,
            avatar: true,
            githubUser: true,
        },
    });

    if (!user) {
        return c.json({ error: "User not found" }, 404);
    }

    // Get connected vendors
    const serviceTokens = await prisma.serviceAccountToken.findMany({
        where: { accountId: userId },
        select: { vendor: true },
    });
    const connectedVendors = [...new Set(serviceTokens.map((t: { vendor: string }) => t.vendor))];

    const avatar = user.avatar as ImageRef | null;
    const githubProfile = user.githubUser?.profile as GitHubProfile | null;

    return c.json({
        id: userId,
        timestamp: Date.now(),
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        avatar: avatar
            ? { ...avatar, url: getPublicUrl(c.env, avatar.path) }
            : null,
        github: githubProfile,
        connectedServices: connectedVendors,
    });
});

// GET /account/settings - Get account settings
account.get("/settings", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const prisma = getPrisma(c.env.DB);

    const user = await prisma.account.findUnique({
        where: { id: userId },
        select: { settings: true, settingsVersion: true },
    });

    if (!user) {
        return c.json({ error: "Failed to get account settings" }, 500);
    }

    return c.json({
        settings: user.settings,
        settingsVersion: user.settingsVersion,
    });
});

// POST /account/settings - Update account settings
const updateSettingsSchema = z.object({
    settings: z.string().nullable(),
    expectedVersion: z.number().int().min(0),
});

account.post("/settings", authMiddleware, zValidator("json", updateSettingsSchema), async (c) => {
    const userId = c.get("userId");
    const { settings, expectedVersion } = c.req.valid("json");
    const prisma = getPrisma(c.env.DB);

    // Get current user data for version check
    const currentUser = await prisma.account.findUnique({
        where: { id: userId },
        select: { settings: true, settingsVersion: true },
    });

    if (!currentUser) {
        return c.json({
            success: false,
            error: "Failed to update account settings",
        }, 500);
    }

    // Check current version
    if (currentUser.settingsVersion !== expectedVersion) {
        return c.json({
            success: false,
            error: "version-mismatch" as const,
            currentVersion: currentUser.settingsVersion,
            currentSettings: currentUser.settings,
        });
    }

    // Update settings with version check
    const result = await prisma.account.updateMany({
        where: {
            id: userId,
            settingsVersion: expectedVersion,
        },
        data: {
            settings: settings,
            settingsVersion: expectedVersion + 1,
            updatedAt: new Date(),
        },
    });

    if (result.count === 0) {
        // Re-fetch to get current version
        const account = await prisma.account.findUnique({
            where: { id: userId },
        });
        return c.json({
            success: false,
            error: "version-mismatch" as const,
            currentVersion: account?.settingsVersion || 0,
            currentSettings: account?.settings || null,
        });
    }

    // TODO: Emit account update event via Durable Object WebSocket
    // This will be implemented when real-time migration (task 5.5) is complete
    // When ready:
    // const updSeq = await allocateUserSeq(prisma, userId);
    // const settingsUpdate = { value: settings, version: expectedVersion + 1 };
    // const updatePayload = buildUpdateAccountUpdate(userId, { settings: settingsUpdate }, updSeq, randomKey(12));
    // eventRouter.emitUpdate({ userId, payload: updatePayload, recipientFilter: { type: 'user-scoped-only' } });

    return c.json({
        success: true,
        version: expectedVersion + 1,
    });
});

// ==================== Usage Routes ====================

// POST /usage/query - Query usage reports
const usageQuerySchema = z.object({
    sessionId: z.string().nullish(),
    startTime: z.number().int().positive().nullish(),
    endTime: z.number().int().positive().nullish(),
    groupBy: z.enum(["hour", "day"]).nullish(),
});

usage.post("/query", authMiddleware, zValidator("json", usageQuerySchema), async (c) => {
    const userId = c.get("userId");
    const { sessionId, startTime, endTime, groupBy } = c.req.valid("json");
    const actualGroupBy = groupBy || "day";
    const prisma = getPrisma(c.env.DB);

    // Build query conditions
    interface WhereClause {
        accountId: string;
        sessionId?: string;
        createdAt?: {
            gte?: Date;
            lte?: Date;
        };
    }

    const where: WhereClause = {
        accountId: userId,
    };

    if (sessionId) {
        // Verify session belongs to user
        const session = await prisma.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId,
            },
        });
        if (!session) {
            return c.json({ error: "Session not found" }, 404);
        }
        where.sessionId = sessionId;
    }

    if (startTime || endTime) {
        where.createdAt = {};
        if (startTime) {
            where.createdAt.gte = new Date(startTime * 1000);
        }
        if (endTime) {
            where.createdAt.lte = new Date(endTime * 1000);
        }
    }

    // Fetch usage reports
    const reports = await prisma.usageReport.findMany({
        where,
        orderBy: {
            createdAt: "desc",
        },
    });

    // Aggregate data by time period
    const aggregated = new Map<string, {
        tokens: Record<string, number>;
        cost: Record<string, number>;
        count: number;
        timestamp: number;
    }>();

    for (const report of reports) {
        const data = report.data as UsageReportData;
        const date = new Date(report.createdAt);

        // Calculate timestamp based on groupBy
        let timestamp: number;
        if (actualGroupBy === "hour") {
            // Round down to hour
            const hourDate = new Date(
                date.getFullYear(),
                date.getMonth(),
                date.getDate(),
                date.getHours(),
                0,
                0,
                0
            );
            timestamp = Math.floor(hourDate.getTime() / 1000);
        } else {
            // Round down to day
            const dayDate = new Date(
                date.getFullYear(),
                date.getMonth(),
                date.getDate(),
                0,
                0,
                0,
                0
            );
            timestamp = Math.floor(dayDate.getTime() / 1000);
        }

        const key = timestamp.toString();

        if (!aggregated.has(key)) {
            aggregated.set(key, {
                tokens: {},
                cost: {},
                count: 0,
                timestamp,
            });
        }

        const agg = aggregated.get(key)!;
        agg.count++;

        // Aggregate tokens
        if (data.tokens) {
            for (const [tokenKey, tokenValue] of Object.entries(data.tokens)) {
                if (typeof tokenValue === "number") {
                    agg.tokens[tokenKey] = (agg.tokens[tokenKey] || 0) + tokenValue;
                }
            }
        }

        // Aggregate costs
        if (data.cost) {
            for (const [costKey, costValue] of Object.entries(data.cost)) {
                if (typeof costValue === "number") {
                    agg.cost[costKey] = (agg.cost[costKey] || 0) + costValue;
                }
            }
        }
    }

    // Convert to array and sort by timestamp
    const result = Array.from(aggregated.values())
        .map((data) => ({
            timestamp: data.timestamp,
            tokens: data.tokens,
            cost: data.cost,
            reportCount: data.count,
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

    return c.json({
        usage: result,
        groupBy: actualGroupBy,
        totalReports: reports.length,
    });
});

export { account, usage };
