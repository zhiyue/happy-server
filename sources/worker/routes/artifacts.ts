/**
 * Artifacts routes for Cloudflare Workers
 *
 * Migrated from Fastify artifacts routes.
 * Provides CRUD operations for encrypted artifacts with version control.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as privacyKit from "privacy-kit";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";
// TODO: Uncomment when real-time migration is complete
// import { allocateUserSeq } from "@/worker/utils/seq";
// import { randomKey } from "@/worker/utils/randomKey";

// Create artifacts router
const artifacts = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Types ====================

interface ArtifactData {
    id: string;
    accountId: string;
    header: Uint8Array;
    headerVersion: number;
    body: Uint8Array;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array;
    seq: number;
    createdAt: Date;
    updatedAt: Date;
}

// ==================== Routes ====================

// GET /artifacts - List all artifacts for the account
artifacts.get("/", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const prisma = getPrisma(c.env.DB);

    const artifactList = await prisma.artifact.findMany({
        where: { accountId: userId },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true,
            header: true,
            headerVersion: true,
            dataEncryptionKey: true,
            seq: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    return c.json(
        artifactList.map((a: {
            id: string;
            header: Uint8Array;
            headerVersion: number;
            dataEncryptionKey: Uint8Array;
            seq: number;
            createdAt: Date;
            updatedAt: Date;
        }) => ({
            id: a.id,
            header: privacyKit.encodeBase64(a.header),
            headerVersion: a.headerVersion,
            dataEncryptionKey: privacyKit.encodeBase64(a.dataEncryptionKey),
            seq: a.seq,
            createdAt: a.createdAt.getTime(),
            updatedAt: a.updatedAt.getTime(),
        }))
    );
});

// GET /artifacts/:id - Get single artifact with full body
const artifactIdParamSchema = z.object({
    id: z.string(),
});

artifacts.get("/:id", authMiddleware, zValidator("param", artifactIdParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const prisma = getPrisma(c.env.DB);

    const artifact = await prisma.artifact.findFirst({
        where: {
            id,
            accountId: userId,
        },
    });

    if (!artifact) {
        return c.json({ error: "Artifact not found" }, 404);
    }

    return c.json({
        id: artifact.id,
        header: privacyKit.encodeBase64(artifact.header),
        headerVersion: artifact.headerVersion,
        body: privacyKit.encodeBase64(artifact.body),
        bodyVersion: artifact.bodyVersion,
        dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
        seq: artifact.seq,
        createdAt: artifact.createdAt.getTime(),
        updatedAt: artifact.updatedAt.getTime(),
    });
});

// POST /artifacts - Create new artifact
const createArtifactSchema = z.object({
    id: z.string().uuid(),
    header: z.string(),
    body: z.string(),
    dataEncryptionKey: z.string(),
});

artifacts.post("/", authMiddleware, zValidator("json", createArtifactSchema), async (c) => {
    const userId = c.get("userId");
    const { id, header, body, dataEncryptionKey } = c.req.valid("json");
    const prisma = getPrisma(c.env.DB);

    // Check if artifact exists
    const existingArtifact = await prisma.artifact.findUnique({
        where: { id },
    });

    if (existingArtifact) {
        // If exists for another account, return conflict
        if (existingArtifact.accountId !== userId) {
            return c.json({
                error: "Artifact with this ID already exists for another account",
            }, 409);
        }

        // If exists for same account, return existing (idempotent)
        return c.json({
            id: existingArtifact.id,
            header: privacyKit.encodeBase64(existingArtifact.header),
            headerVersion: existingArtifact.headerVersion,
            body: privacyKit.encodeBase64(existingArtifact.body),
            bodyVersion: existingArtifact.bodyVersion,
            dataEncryptionKey: privacyKit.encodeBase64(existingArtifact.dataEncryptionKey),
            seq: existingArtifact.seq,
            createdAt: existingArtifact.createdAt.getTime(),
            updatedAt: existingArtifact.updatedAt.getTime(),
        });
    }

    // Create new artifact
    const artifact = await prisma.artifact.create({
        data: {
            id,
            accountId: userId,
            header: privacyKit.decodeBase64(header),
            headerVersion: 1,
            body: privacyKit.decodeBase64(body),
            bodyVersion: 1,
            dataEncryptionKey: privacyKit.decodeBase64(dataEncryptionKey),
            seq: 0,
        },
    });

    // TODO: Emit new-artifact event via Durable Object WebSocket
    // This will be implemented when real-time migration (task 5.5) is complete
    // When ready:
    // const updSeq = await allocateUserSeq(prisma, userId);
    // const newArtifactPayload = buildNewArtifactUpdate(artifact, updSeq, randomKey(12));
    // eventRouter.emitUpdate({ userId, payload: newArtifactPayload, recipientFilter: { type: 'user-scoped-only' } });

    return c.json({
        id: artifact.id,
        header: privacyKit.encodeBase64(artifact.header),
        headerVersion: artifact.headerVersion,
        body: privacyKit.encodeBase64(artifact.body),
        bodyVersion: artifact.bodyVersion,
        dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
        seq: artifact.seq,
        createdAt: artifact.createdAt.getTime(),
        updatedAt: artifact.updatedAt.getTime(),
    });
});

// POST /artifacts/:id - Update artifact with version control
const updateArtifactSchema = z.object({
    header: z.string().optional(),
    expectedHeaderVersion: z.number().int().min(0).optional(),
    body: z.string().optional(),
    expectedBodyVersion: z.number().int().min(0).optional(),
});

artifacts.post("/:id", authMiddleware, zValidator("param", artifactIdParamSchema), zValidator("json", updateArtifactSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const { header, expectedHeaderVersion, body, expectedBodyVersion } = c.req.valid("json");
    const prisma = getPrisma(c.env.DB);

    // Get current artifact for version check
    const currentArtifact = await prisma.artifact.findFirst({
        where: {
            id,
            accountId: userId,
        },
    });

    if (!currentArtifact) {
        return c.json({ error: "Artifact not found" }, 404);
    }

    // Check version mismatches
    const headerMismatch =
        header !== undefined &&
        expectedHeaderVersion !== undefined &&
        currentArtifact.headerVersion !== expectedHeaderVersion;
    const bodyMismatch =
        body !== undefined &&
        expectedBodyVersion !== undefined &&
        currentArtifact.bodyVersion !== expectedBodyVersion;

    if (headerMismatch || bodyMismatch) {
        return c.json({
            success: false,
            error: "version-mismatch" as const,
            ...(headerMismatch && {
                currentHeaderVersion: currentArtifact.headerVersion,
                currentHeader: privacyKit.encodeBase64(currentArtifact.header),
            }),
            ...(bodyMismatch && {
                currentBodyVersion: currentArtifact.bodyVersion,
                currentBody: privacyKit.encodeBase64(currentArtifact.body),
            }),
        });
    }

    // Build update data
    interface UpdateData {
        updatedAt: Date;
        header?: Uint8Array;
        headerVersion?: number;
        body?: Uint8Array;
        bodyVersion?: number;
        seq: number;
    }

    const updateData: UpdateData = {
        updatedAt: new Date(),
        seq: currentArtifact.seq + 1,
    };

    let headerUpdate: { value: string; version: number } | undefined;
    let bodyUpdate: { value: string; version: number } | undefined;

    if (header !== undefined && expectedHeaderVersion !== undefined) {
        updateData.header = privacyKit.decodeBase64(header);
        updateData.headerVersion = expectedHeaderVersion + 1;
        headerUpdate = {
            value: header,
            version: expectedHeaderVersion + 1,
        };
    }

    if (body !== undefined && expectedBodyVersion !== undefined) {
        updateData.body = privacyKit.decodeBase64(body);
        updateData.bodyVersion = expectedBodyVersion + 1;
        bodyUpdate = {
            value: body,
            version: expectedBodyVersion + 1,
        };
    }

    // Update artifact
    await prisma.artifact.update({
        where: { id },
        data: updateData,
    });

    // TODO: Emit update-artifact event via Durable Object WebSocket
    // This will be implemented when real-time migration (task 5.5) is complete
    // When ready:
    // const updSeq = await allocateUserSeq(prisma, userId);
    // const updatePayload = buildUpdateArtifactUpdate(id, updSeq, randomKey(12), headerUpdate, bodyUpdate);
    // eventRouter.emitUpdate({ userId, payload: updatePayload, recipientFilter: { type: 'user-scoped-only' } });

    return c.json({
        success: true,
        ...(headerUpdate && { headerVersion: headerUpdate.version }),
        ...(bodyUpdate && { bodyVersion: bodyUpdate.version }),
    });
});

// DELETE /artifacts/:id - Delete artifact
artifacts.delete("/:id", authMiddleware, zValidator("param", artifactIdParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const prisma = getPrisma(c.env.DB);

    // Check if artifact exists and belongs to user
    const artifact = await prisma.artifact.findFirst({
        where: {
            id,
            accountId: userId,
        },
    });

    if (!artifact) {
        return c.json({ error: "Artifact not found" }, 404);
    }

    // Delete artifact
    await prisma.artifact.delete({
        where: { id },
    });

    // TODO: Emit delete-artifact event via Durable Object WebSocket
    // This will be implemented when real-time migration (task 5.5) is complete
    // When ready:
    // const updSeq = await allocateUserSeq(prisma, userId);
    // const deletePayload = buildDeleteArtifactUpdate(id, updSeq, randomKey(12));
    // eventRouter.emitUpdate({ userId, payload: deletePayload, recipientFilter: { type: 'user-scoped-only' } });

    return c.json({ success: true });
});

export { artifacts };
