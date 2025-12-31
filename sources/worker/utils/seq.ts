/**
 * Worker-compatible sequence allocation
 *
 * Allocates monotonically increasing sequence numbers for accounts and sessions.
 * Uses the Prisma client passed as parameter (per-request in Workers).
 */

import { PrismaClient } from "@prisma/client";

/**
 * Allocate the next sequence number for a user.
 *
 * @param prisma - Prisma client
 * @param accountId - Account ID
 * @returns The new sequence number
 */
export async function allocateUserSeq(prisma: PrismaClient, accountId: string): Promise<number> {
    const user = await prisma.account.update({
        where: { id: accountId },
        select: { seq: true },
        data: { seq: { increment: 1 } },
    });
    return user.seq;
}

/**
 * Allocate the next sequence number for a session.
 *
 * @param prisma - Prisma client
 * @param sessionId - Session ID
 * @returns The new sequence number
 */
export async function allocateSessionSeq(prisma: PrismaClient, sessionId: string): Promise<number> {
    const session = await prisma.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: { seq: { increment: 1 } },
    });
    return session.seq;
}
