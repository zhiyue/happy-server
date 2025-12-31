/**
 * V2 Session routes for Cloudflare Workers
 *
 * Provides enhanced session endpoints with cursor-based pagination
 * and change tracking capabilities.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as privacyKit from "privacy-kit";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";

// Create v2 sessions router
const v2Sessions = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Helper Functions ====================

/**
 * Format session data for API response.
 */
function formatSession(session: {
    id: string;
    seq: number;
    createdAt: Date;
    updatedAt: Date;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date;
}) {
    return {
        id: session.id,
        seq: session.seq,
        createdAt: session.createdAt.getTime(),
        updatedAt: session.updatedAt.getTime(),
        active: session.active,
        activeAt: session.lastActiveAt.getTime(),
        metadata: session.metadata,
        metadataVersion: session.metadataVersion,
        agentState: session.agentState,
        agentStateVersion: session.agentStateVersion,
        dataEncryptionKey: session.dataEncryptionKey
            ? privacyKit.encodeBase64(session.dataEncryptionKey)
            : null,
    };
}

// ==================== Routes ====================

// GET /active - Active sessions only (with limit)
const activeSessionsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(150),
});

v2Sessions.get("/active", authMiddleware, zValidator("query", activeSessionsQuerySchema), async (c) => {
    const userId = c.get("userId");
    const { limit } = c.req.valid("query");
    const prisma = getPrisma(c.env.DB);

    const sessionList = await prisma.session.findMany({
        where: {
            accountId: userId,
            active: true,
            lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) }, // 15 minutes
        },
        orderBy: { lastActiveAt: "desc" },
        take: limit,
        select: {
            id: true,
            seq: true,
            createdAt: true,
            updatedAt: true,
            metadata: true,
            metadataVersion: true,
            agentState: true,
            agentStateVersion: true,
            dataEncryptionKey: true,
            active: true,
            lastActiveAt: true,
        },
    });

    return c.json({
        sessions: sessionList.map(formatSession),
    });
});

// GET / - Cursor-based pagination with change tracking
const paginatedSessionsQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    changedSince: z.coerce.number().int().positive().optional(),
});

v2Sessions.get("/", authMiddleware, zValidator("query", paginatedSessionsQuerySchema), async (c) => {
    const userId = c.get("userId");
    const { cursor, limit, changedSince } = c.req.valid("query");
    const prisma = getPrisma(c.env.DB);

    // Decode cursor - simple ID-based cursor
    let cursorSessionId: string | undefined;
    if (cursor) {
        if (cursor.startsWith("cursor_v1_")) {
            cursorSessionId = cursor.substring(10);
        } else {
            return c.json({ error: "Invalid cursor format" }, 400);
        }
    }

    // Build where clause
    interface SessionWhere {
        accountId: string;
        updatedAt?: { gt: Date };
        id?: { lt: string };
    }

    const where: SessionWhere = { accountId: userId };

    // Add changedSince filter
    if (changedSince) {
        where.updatedAt = { gt: new Date(changedSince) };
    }

    // Add cursor pagination
    if (cursorSessionId) {
        where.id = { lt: cursorSessionId };
    }

    const sessionList = await prisma.session.findMany({
        where,
        orderBy: { id: "desc" },
        take: limit + 1, // Fetch one extra to determine if there are more
        select: {
            id: true,
            seq: true,
            createdAt: true,
            updatedAt: true,
            metadata: true,
            metadataVersion: true,
            agentState: true,
            agentStateVersion: true,
            dataEncryptionKey: true,
            active: true,
            lastActiveAt: true,
        },
    });

    // Check if there are more results
    const hasNext = sessionList.length > limit;
    const resultSessions = hasNext ? sessionList.slice(0, limit) : sessionList;

    // Generate next cursor
    let nextCursor: string | null = null;
    if (hasNext && resultSessions.length > 0) {
        const lastSession = resultSessions[resultSessions.length - 1];
        nextCursor = `cursor_v1_${lastSession.id}`;
    }

    return c.json({
        sessions: resultSessions.map(formatSession),
        nextCursor,
        hasNext,
    });
});

export { v2Sessions };
