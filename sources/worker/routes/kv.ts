/**
 * KV routes for Cloudflare Workers
 *
 * Migrated from Fastify KV routes.
 * Provides key-value storage operations for users.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as privacyKit from "privacy-kit";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";
import { PrismaClient } from "@prisma/client";
import { WorkerContext } from "@/worker/types/context";
import { inBatch, addStatement, afterBatch } from "@/storage/inBatch";

// Create KV router
const kv = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Types ====================

/**
 * KV store data shape returned from Prisma queries.
 */
interface KVStoreData {
    accountId: string;
    key: string;
    value: Uint8Array | null;
    version: number;
}

// ==================== Helper Functions ====================

/**
 * Get a single key-value pair for the authenticated user.
 * Returns null if the key doesn't exist or if the value is null (deleted).
 */
async function kvGet(
    prisma: PrismaClient,
    uid: string,
    key: string
): Promise<{ key: string; value: string; version: number } | null> {
    const result = await prisma.userKVStore.findUnique({
        where: {
            accountId_key: {
                accountId: uid,
                key,
            },
        },
    });

    // Treat missing records and null values as "not found"
    if (!result || result.value === null) {
        return null;
    }

    return {
        key: result.key,
        value: privacyKit.encodeBase64(result.value),
        version: result.version,
    };
}

/**
 * List all key-value pairs for the authenticated user, optionally filtered by prefix.
 */
async function kvList(
    prisma: PrismaClient,
    uid: string,
    options?: { prefix?: string; limit?: number }
): Promise<{ items: Array<{ key: string; value: string; version: number }> }> {
    interface WhereClause {
        accountId: string;
        value: { not: null };
        key?: { startsWith: string };
    }

    const where: WhereClause = {
        accountId: uid,
        value: { not: null }, // Exclude deleted entries
    };

    // Add prefix filter if specified
    if (options?.prefix) {
        where.key = { startsWith: options.prefix };
    }

    const results = await prisma.userKVStore.findMany({
        where,
        orderBy: { key: "asc" },
        take: options?.limit,
    });

    return {
        items: results
            .filter((r: KVStoreData) => r.value !== null)
            .map((r: KVStoreData) => ({
                key: r.key,
                value: privacyKit.encodeBase64(r.value!),
                version: r.version,
            })),
    };
}

/**
 * Get multiple key-value pairs for the authenticated user.
 */
async function kvBulkGet(
    prisma: PrismaClient,
    uid: string,
    keys: string[]
): Promise<{ values: Array<{ key: string; value: string; version: number }> }> {
    const results = await prisma.userKVStore.findMany({
        where: {
            accountId: uid,
            key: { in: keys },
            value: { not: null },
        },
    });

    return {
        values: results
            .filter((r: KVStoreData) => r.value !== null)
            .map((r: KVStoreData) => ({
                key: r.key,
                value: privacyKit.encodeBase64(r.value!),
                version: r.version,
            })),
    };
}

interface KVMutation {
    key: string;
    value: string | null;
    version: number;
}

interface KVMutateResult {
    success: boolean;
    results?: Array<{ key: string; version: number }>;
    errors?: Array<{
        key: string;
        error: "version-mismatch";
        version: number;
        value: string | null;
    }>;
}

/**
 * Atomically mutate multiple key-value pairs using D1 batch.
 */
async function kvMutateWorker(
    ctx: WorkerContext,
    mutations: KVMutation[]
): Promise<KVMutateResult> {
    const { prisma, db, uid } = ctx;

    return await inBatch(db, async (batchCtx) => {
        const errors: KVMutateResult["errors"] = [];

        // Read phase: Pre-validate all mutations using Prisma
        for (const mutation of mutations) {
            const existing = await prisma.userKVStore.findUnique({
                where: {
                    accountId_key: {
                        accountId: uid,
                        key: mutation.key,
                    },
                },
            });

            const currentVersion = existing?.version ?? -1;

            // Version check is always required
            if (currentVersion !== mutation.version) {
                errors.push({
                    key: mutation.key,
                    error: "version-mismatch",
                    version: currentVersion,
                    value: existing?.value ? privacyKit.encodeBase64(existing.value) : null,
                });
            }
        }

        // If any errors, return all errors and abort (no writes queued)
        if (errors.length > 0) {
            return { success: false, errors };
        }

        // Write phase: Queue all mutations as D1 statements
        const results: Array<{ key: string; version: number }> = [];
        const changes: Array<{ key: string; value: string | null; version: number }> = [];

        for (const mutation of mutations) {
            if (mutation.version === -1) {
                // Create new entry (must not exist)
                const newVersion = 0;
                const valueBytes = mutation.value ? privacyKit.decodeBase64(mutation.value) : null;

                addStatement(
                    batchCtx,
                    db
                        .prepare(
                            "INSERT INTO UserKVStore (accountId, key, value, version) VALUES (?, ?, ?, ?)"
                        )
                        .bind(uid, mutation.key, valueBytes, newVersion)
                );

                results.push({ key: mutation.key, version: newVersion });
                changes.push({ key: mutation.key, value: mutation.value, version: newVersion });
            } else {
                // Update existing entry (including "delete" which sets value to null)
                const newVersion = mutation.version + 1;
                const valueBytes = mutation.value ? privacyKit.decodeBase64(mutation.value) : null;

                addStatement(
                    batchCtx,
                    db
                        .prepare(
                            "UPDATE UserKVStore SET value = ?, version = ? WHERE accountId = ? AND key = ?"
                        )
                        .bind(valueBytes, newVersion, uid, mutation.key)
                );

                results.push({ key: mutation.key, version: newVersion });
                changes.push({ key: mutation.key, value: mutation.value, version: newVersion });
            }
        }

        // Side effects: Send notification after successful batch
        afterBatch(batchCtx, async () => {
            // TODO: Emit kv-batch-update event via Durable Object WebSocket
            // This will be implemented when real-time migration (task 5.5) is complete
            // When ready, uncomment:
            // const updateSeq = await allocateUserSeq(prisma, uid);
            // const updateId = randomKey(12);
            // eventRouter.emitUpdate(buildKVBatchUpdateUpdate(changes, updateSeq, updateId));
        });

        return { success: true, results };
    });
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

// GET /kv/:key - Get single value
const keyParamSchema = z.object({
    key: z.string(),
});

kv.get("/:key", authMiddleware, zValidator("param", keyParamSchema), async (c) => {
    const userId = c.get("userId");
    const { key } = c.req.valid("param");
    const prisma = getPrisma(c.env.DB);

    const result = await kvGet(prisma, userId, key);

    if (!result) {
        return c.json({ error: "Key not found" }, 404);
    }

    return c.json(result);
});

// GET /kv - List key-value pairs with optional prefix filter
const listQuerySchema = z.object({
    prefix: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
});

kv.get("/", authMiddleware, zValidator("query", listQuerySchema), async (c) => {
    const userId = c.get("userId");
    const { prefix, limit } = c.req.valid("query");
    const prisma = getPrisma(c.env.DB);

    const result = await kvList(prisma, userId, { prefix, limit });
    return c.json(result);
});

// POST /kv/bulk - Bulk get values
const bulkGetSchema = z.object({
    keys: z.array(z.string()).min(1).max(100),
});

kv.post("/bulk", authMiddleware, zValidator("json", bulkGetSchema), async (c) => {
    const userId = c.get("userId");
    const { keys } = c.req.valid("json");
    const prisma = getPrisma(c.env.DB);

    const result = await kvBulkGet(prisma, userId, keys);
    return c.json(result);
});

// POST /kv - Atomic batch mutation
const mutateSchema = z.object({
    mutations: z
        .array(
            z.object({
                key: z.string(),
                value: z.string().nullable(),
                version: z.number(),
            })
        )
        .min(1)
        .max(100),
});

kv.post("/", authMiddleware, zValidator("json", mutateSchema), async (c) => {
    const userId = c.get("userId");
    const { mutations } = c.req.valid("json");
    const ctx = createWorkerContext(userId, c.env);

    const result = await kvMutateWorker(ctx, mutations);

    if (!result.success) {
        return c.json(
            {
                success: false as const,
                errors: result.errors!,
            },
            409
        );
    }

    return c.json({
        success: true as const,
        results: result.results!,
    });
});

export { kv };
