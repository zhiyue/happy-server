/**
 * Machine routes for Cloudflare Workers
 *
 * Migrated from Fastify machines routes.
 * Manages machine registration and retrieval.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as privacyKit from "privacy-kit";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";
import { allocateUserSeq } from "@/worker/utils/seq";
import { randomKey } from "@/worker/utils/randomKey";

// Create machines router
const machines = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Helper Functions ====================

/**
 * Format machine data for API response.
 */
function formatMachine(machine: {
    id: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        id: machine.id,
        seq: machine.seq,
        metadata: machine.metadata,
        metadataVersion: machine.metadataVersion,
        daemonState: machine.daemonState,
        daemonStateVersion: machine.daemonStateVersion,
        dataEncryptionKey: machine.dataEncryptionKey
            ? privacyKit.encodeBase64(machine.dataEncryptionKey)
            : null,
        active: machine.active,
        activeAt: machine.lastActiveAt.getTime(),
        createdAt: machine.createdAt.getTime(),
        updatedAt: machine.updatedAt.getTime(),
    };
}

// ==================== Routes ====================

// POST /machines - Create or return existing machine
const createMachineSchema = z.object({
    id: z.string(),
    metadata: z.string(),
    daemonState: z.string().optional(),
    dataEncryptionKey: z.string().nullish(),
});

machines.post("/", authMiddleware, zValidator("json", createMachineSchema), async (c) => {
    const userId = c.get("userId");
    const { id, metadata, daemonState, dataEncryptionKey } = c.req.valid("json");
    const prisma = getPrisma(c.env.DB);

    // Check if machine exists
    const existingMachine = await prisma.machine.findFirst({
        where: {
            accountId: userId,
            id: id,
        },
    });

    if (existingMachine) {
        // Machine exists - just return it
        return c.json({
            machine: formatMachine(existingMachine),
        });
    }

    // Create new machine
    const newMachine = await prisma.machine.create({
        data: {
            id,
            accountId: userId,
            metadata,
            metadataVersion: 1,
            daemonState: daemonState || null,
            daemonStateVersion: daemonState ? 1 : 0,
            dataEncryptionKey: dataEncryptionKey
                ? privacyKit.decodeBase64(dataEncryptionKey)
                : undefined,
            // Default to offline - in case the user does not start daemon
            active: false,
        },
    });

    // TODO: Emit new-machine and update-machine events via Durable Object WebSocket
    // This will be implemented when real-time migration (task 5.5) is complete
    // When ready, uncomment:
    // const updSeq1 = await allocateUserSeq(prisma, userId);
    // const updSeq2 = await allocateUserSeq(prisma, userId);
    // eventRouter.emitUpdate(buildNewMachineUpdate(newMachine, updSeq1, randomKey(12)));
    // eventRouter.emitUpdate(buildUpdateMachineUpdate(newMachine.id, updSeq2, randomKey(12), ...));

    return c.json({
        machine: formatMachine(newMachine),
    });
});

// GET /machines - List all machines for the user
machines.get("/", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const prisma = getPrisma(c.env.DB);

    const machineList = await prisma.machine.findMany({
        where: { accountId: userId },
        orderBy: { lastActiveAt: "desc" },
    });

    return c.json(machineList.map(formatMachine));
});

// GET /machines/:id - Get single machine by ID
const machineIdParamSchema = z.object({
    id: z.string(),
});

machines.get("/:id", authMiddleware, zValidator("param", machineIdParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const prisma = getPrisma(c.env.DB);

    const machine = await prisma.machine.findFirst({
        where: {
            accountId: userId,
            id: id,
        },
    });

    if (!machine) {
        return c.json({ error: "Machine not found" }, 404);
    }

    return c.json({
        machine: formatMachine(machine),
    });
});

export { machines };
