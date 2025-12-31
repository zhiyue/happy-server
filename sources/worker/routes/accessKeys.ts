/**
 * Access keys routes for Cloudflare Workers
 *
 * Migrated from Fastify access keys routes.
 * Provides CRUD operations for access keys with version control.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";

// Create access keys router
const accessKeys = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Schemas ====================

const accessKeyParamsSchema = z.object({
    sessionId: z.string(),
    machineId: z.string(),
});

const createAccessKeySchema = z.object({
    data: z.string(),
});

const updateAccessKeySchema = z.object({
    data: z.string(),
    expectedVersion: z.number().int().min(0),
});

// ==================== Routes ====================

// GET /access-keys/:sessionId/:machineId - Get access key
accessKeys.get(
    "/:sessionId/:machineId",
    authMiddleware,
    zValidator("param", accessKeyParamsSchema),
    async (c) => {
        const userId = c.get("userId");
        const { sessionId, machineId } = c.req.valid("param");
        const prisma = getPrisma(c.env.DB);

        // Verify session and machine belong to user
        const [session, machine] = await Promise.all([
            prisma.session.findFirst({
                where: { id: sessionId, accountId: userId },
            }),
            prisma.machine.findFirst({
                where: { id: machineId, accountId: userId },
            }),
        ]);

        if (!session || !machine) {
            return c.json({ error: "Session or machine not found" }, 404);
        }

        // Get access key
        const accessKey = await prisma.accessKey.findUnique({
            where: {
                accountId_machineId_sessionId: {
                    accountId: userId,
                    machineId,
                    sessionId,
                },
            },
        });

        if (!accessKey) {
            return c.json({ accessKey: null });
        }

        return c.json({
            accessKey: {
                data: accessKey.data,
                dataVersion: accessKey.dataVersion,
                createdAt: accessKey.createdAt.getTime(),
                updatedAt: accessKey.updatedAt.getTime(),
            },
        });
    }
);

// POST /access-keys/:sessionId/:machineId - Create access key
accessKeys.post(
    "/:sessionId/:machineId",
    authMiddleware,
    zValidator("param", accessKeyParamsSchema),
    zValidator("json", createAccessKeySchema),
    async (c) => {
        const userId = c.get("userId");
        const { sessionId, machineId } = c.req.valid("param");
        const { data } = c.req.valid("json");
        const prisma = getPrisma(c.env.DB);

        // Verify session and machine belong to user
        const [session, machine] = await Promise.all([
            prisma.session.findFirst({
                where: { id: sessionId, accountId: userId },
            }),
            prisma.machine.findFirst({
                where: { id: machineId, accountId: userId },
            }),
        ]);

        if (!session || !machine) {
            return c.json({ error: "Session or machine not found" }, 404);
        }

        // Check if access key already exists
        const existing = await prisma.accessKey.findUnique({
            where: {
                accountId_machineId_sessionId: {
                    accountId: userId,
                    machineId,
                    sessionId,
                },
            },
        });

        if (existing) {
            return c.json({ error: "Access key already exists" }, 409);
        }

        // Create access key
        const accessKey = await prisma.accessKey.create({
            data: {
                accountId: userId,
                machineId,
                sessionId,
                data,
                dataVersion: 1,
            },
        });

        return c.json({
            success: true,
            accessKey: {
                data: accessKey.data,
                dataVersion: accessKey.dataVersion,
                createdAt: accessKey.createdAt.getTime(),
                updatedAt: accessKey.updatedAt.getTime(),
            },
        });
    }
);

// PUT /access-keys/:sessionId/:machineId - Update access key
accessKeys.put(
    "/:sessionId/:machineId",
    authMiddleware,
    zValidator("param", accessKeyParamsSchema),
    zValidator("json", updateAccessKeySchema),
    async (c) => {
        const userId = c.get("userId");
        const { sessionId, machineId } = c.req.valid("param");
        const { data, expectedVersion } = c.req.valid("json");
        const prisma = getPrisma(c.env.DB);

        // Get current access key for version check
        const currentAccessKey = await prisma.accessKey.findUnique({
            where: {
                accountId_machineId_sessionId: {
                    accountId: userId,
                    machineId,
                    sessionId,
                },
            },
        });

        if (!currentAccessKey) {
            return c.json({ error: "Access key not found" }, 404);
        }

        // Check version
        if (currentAccessKey.dataVersion !== expectedVersion) {
            return c.json({
                success: false,
                error: "version-mismatch" as const,
                currentVersion: currentAccessKey.dataVersion,
                currentData: currentAccessKey.data,
            });
        }

        // Update with version check
        const result = await prisma.accessKey.updateMany({
            where: {
                accountId: userId,
                machineId,
                sessionId,
                dataVersion: expectedVersion,
            },
            data: {
                data,
                dataVersion: expectedVersion + 1,
                updatedAt: new Date(),
            },
        });

        if (result.count === 0) {
            // Re-fetch to get current version
            const accessKey = await prisma.accessKey.findUnique({
                where: {
                    accountId_machineId_sessionId: {
                        accountId: userId,
                        machineId,
                        sessionId,
                    },
                },
            });
            return c.json({
                success: false,
                error: "version-mismatch" as const,
                currentVersion: accessKey?.dataVersion || 0,
                currentData: accessKey?.data || "",
            });
        }

        return c.json({
            success: true,
            version: expectedVersion + 1,
        });
    }
);

export { accessKeys };
