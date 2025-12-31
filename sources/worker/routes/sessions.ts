/**
 * Session routes for Cloudflare Workers
 *
 * Migrated from Fastify session routes.
 * Uses Prisma for reads and D1 batch for atomic writes.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as privacyKit from "privacy-kit";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";
import { inBatch, addStatement, afterBatch } from "@/storage/inBatch";
import { WorkerContext } from "@/worker/types/context";

// Create sessions router
const sessions = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Types ====================

/**
 * Session data shape returned from Prisma queries.
 */
interface SessionData {
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
}

/**
 * Session message data shape returned from Prisma queries.
 */
interface MessageData {
    id: string;
    seq: number;
    localId: string | null;
    content: unknown;
    createdAt: Date;
    updatedAt: Date;
}

// ==================== Helper Functions ====================

/**
 * Format session data for API response.
 */
function formatSession(session: SessionData) {
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

/**
 * Create a WorkerContext from Hono context.
 */
function createWorkerContext(userId: string, env: Env): WorkerContext {
    return {
        uid: userId,
        prisma: getPrisma(env.DB),
        db: env.DB,
    };
}

// ==================== Routes ====================

// GET /sessions - List sessions
sessions.get("/", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const prisma = getPrisma(c.env.DB);

    const sessionList = await prisma.session.findMany({
        where: { accountId: userId },
        orderBy: { updatedAt: "desc" },
        take: 150,
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
        sessions: sessionList.map((v: SessionData) => ({
            ...formatSession(v),
            lastMessage: null,
        })),
    });
});

// POST /sessions - Create or load session by tag
const createSessionSchema = z.object({
    tag: z.string(),
    metadata: z.string(),
    agentState: z.string().nullish(),
    dataEncryptionKey: z.string().nullish(),
});

sessions.post("/", authMiddleware, zValidator("json", createSessionSchema), async (c) => {
    const userId = c.get("userId");
    const { tag, metadata, dataEncryptionKey } = c.req.valid("json");
    const prisma = getPrisma(c.env.DB);

    // Check if session with this tag already exists
    const existingSession = await prisma.session.findFirst({
        where: {
            accountId: userId,
            tag: tag,
        },
    });

    if (existingSession) {
        return c.json({
            session: {
                ...formatSession(existingSession),
                lastMessage: null,
            },
        });
    }

    // Create new session
    const session = await prisma.session.create({
        data: {
            accountId: userId,
            tag: tag,
            metadata: metadata,
            dataEncryptionKey: dataEncryptionKey
                ? privacyKit.decodeBase64(dataEncryptionKey)
                : undefined,
        },
    });

    // TODO: Emit new-session event via Durable Object WebSocket
    // This will be implemented when real-time migration (task 5.5) is complete

    return c.json({
        session: {
            ...formatSession(session),
            lastMessage: null,
        },
    });
});

// GET /sessions/:sessionId/messages - Get session messages
const sessionIdParamSchema = z.object({
    sessionId: z.string(),
});

sessions.get("/:sessionId/messages", authMiddleware, zValidator("param", sessionIdParamSchema), async (c) => {
    const userId = c.get("userId");
    const { sessionId } = c.req.valid("param");
    const prisma = getPrisma(c.env.DB);

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

    const messages = await prisma.sessionMessage.findMany({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
        take: 150,
        select: {
            id: true,
            seq: true,
            localId: true,
            content: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    return c.json({
        messages: messages.map((v: MessageData) => ({
            id: v.id,
            seq: v.seq,
            content: v.content,
            localId: v.localId,
            createdAt: v.createdAt.getTime(),
            updatedAt: v.updatedAt.getTime(),
        })),
    });
});

// DELETE /sessions/:sessionId - Delete session
sessions.delete("/:sessionId", authMiddleware, zValidator("param", sessionIdParamSchema), async (c) => {
    const userId = c.get("userId");
    const { sessionId } = c.req.valid("param");
    const ctx = createWorkerContext(userId, c.env);

    const deleted = await sessionDeleteWorker(ctx, sessionId);

    if (!deleted) {
        return c.json({ error: "Session not found or not owned by user" }, 404);
    }

    return c.json({ success: true });
});

/**
 * Delete a session and all its related data using D1 batch.
 *
 * Pattern: Read-then-batch
 * 1. Read phase: Verify session exists and belongs to user
 * 2. Write phase: Use D1 batch for atomic cascade deletes
 * 3. Side effects: Send socket notification after successful batch
 */
async function sessionDeleteWorker(ctx: WorkerContext, sessionId: string): Promise<boolean> {
    const { prisma, db, uid } = ctx;

    return await inBatch(db, async (batchCtx) => {
        // Read phase: Verify session exists and belongs to the user
        const session = await prisma.session.findFirst({
            where: {
                id: sessionId,
                accountId: uid,
            },
        });

        if (!session) {
            return false;
        }

        // Write phase: Queue cascade delete statements
        // Note: Order matters to avoid foreign key constraint violations

        // 1. Delete session messages
        addStatement(batchCtx, db.prepare(
            "DELETE FROM SessionMessage WHERE sessionId = ?"
        ).bind(sessionId));

        // 2. Delete usage reports
        addStatement(batchCtx, db.prepare(
            "DELETE FROM UsageReport WHERE sessionId = ?"
        ).bind(sessionId));

        // 3. Delete access keys
        addStatement(batchCtx, db.prepare(
            "DELETE FROM AccessKey WHERE sessionId = ?"
        ).bind(sessionId));

        // 4. Delete the session itself
        addStatement(batchCtx, db.prepare(
            "DELETE FROM Session WHERE id = ?"
        ).bind(sessionId));

        // Side effects: Send notification after successful batch
        afterBatch(batchCtx, async () => {
            // TODO: Emit delete-session event via Durable Object WebSocket
            // This will be implemented when real-time migration (task 5.5) is complete
            // When ready, uncomment:
            // const updSeq = await allocateUserSeq(prisma, uid);
            // const updateId = randomKey(12);
            // eventRouter.emitUpdate(buildDeleteSessionUpdate(sessionId, updSeq, updateId));
        });

        return true;
    });
}

export { sessions };
