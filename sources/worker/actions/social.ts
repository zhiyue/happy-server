/**
 * Worker-compatible social actions.
 *
 * Friend management functions that work with D1 batch operations.
 * These are Worker-compatible versions of the original @/app/social/ functions.
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { inBatch, addStatement, afterBatch, BatchContext } from "@/storage/inBatch";
import { WorkerContext } from "@/worker/types/context";
import { UserProfile, RelationshipStatus, buildUserProfile } from "@/worker/types/social";

/**
 * Get relationship status between two users.
 */
export async function relationshipGet(
    tx: Prisma.TransactionClient | PrismaClient,
    from: string,
    to: string
): Promise<RelationshipStatus> {
    const relationship = await tx.userRelationship.findFirst({
        where: {
            fromUserId: from,
            toUserId: to,
        },
    });
    return (relationship?.status as RelationshipStatus) || RelationshipStatus.none;
}

/**
 * Add a friend or accept a friend request using D1 batch.
 *
 * Pattern: Read-then-batch
 * 1. Read phase: Get users and current relationship status with Prisma
 * 2. Write phase: Update relationships atomically with D1 batch
 * 3. Side effects: Notifications handled after batch (non-atomic)
 *
 * Handles:
 * - Accepting incoming friend requests (both users become friends)
 * - Sending new friend requests
 * - Sending appropriate notifications with 24-hour cooldown
 */
export async function friendAdd(
    ctx: WorkerContext,
    uid: string,
    filesPublicUrl?: string
): Promise<UserProfile | null> {
    const { prisma, db } = ctx;

    // Prevent self-friendship
    if (ctx.uid === uid) {
        return null;
    }

    return await inBatch(db, async (batchCtx) => {
        // Read phase: Get user objects and relationships
        const currentUser = await prisma.account.findUnique({
            where: { id: ctx.uid },
            include: { githubUser: true },
        });
        const targetUser = await prisma.account.findUnique({
            where: { id: uid },
            include: { githubUser: true },
        });

        if (!currentUser || !targetUser) {
            return null;
        }

        // Read relationship status using Prisma
        const currentUserRelationship = await relationshipGet(prisma, currentUser.id, targetUser.id);
        const targetUserRelationship = await relationshipGet(prisma, targetUser.id, currentUser.id);

        // Handle cases

        // Case 1: There's a pending request from the target user - accept it
        if (targetUserRelationship === RelationshipStatus.requested) {
            const now = new Date().toISOString();

            // Accept the friend request - update both to friends (atomic batch)
            queueRelationshipUpsert(batchCtx, db, targetUser.id, currentUser.id, "friend", now);
            queueRelationshipUpsert(batchCtx, db, currentUser.id, targetUser.id, "friend", now);

            // Notifications are side effects - run after successful batch
            afterBatch(batchCtx, async () => {
                // TODO: Migrate notifications to work with Worker context
            });

            return buildUserProfile(
                targetUser as Parameters<typeof buildUserProfile>[0],
                RelationshipStatus.friend,
                filesPublicUrl
            );
        }

        // Case 2: If status is none or rejected, create a new request
        if (
            currentUserRelationship === RelationshipStatus.none ||
            currentUserRelationship === RelationshipStatus.rejected
        ) {
            // Create friend request
            queueRelationshipUpsert(batchCtx, db, currentUser.id, targetUser.id, "requested", null);

            // If other side is in none state, set it to pending
            if (targetUserRelationship === RelationshipStatus.none) {
                queueRelationshipUpsert(batchCtx, db, targetUser.id, currentUser.id, "pending", null);
            }

            // Notifications are side effects - run after successful batch
            afterBatch(batchCtx, async () => {
                // TODO: Migrate notifications to work with Worker context
            });

            return buildUserProfile(
                targetUser as Parameters<typeof buildUserProfile>[0],
                RelationshipStatus.requested,
                filesPublicUrl
            );
        }

        // Do not change anything and return the target user profile
        return buildUserProfile(
            targetUser as Parameters<typeof buildUserProfile>[0],
            currentUserRelationship,
            filesPublicUrl
        );
    });
}

/**
 * Remove a friend or reject a friend request using D1 batch.
 *
 * Pattern: Read-then-batch
 * 1. Read phase: Get users and current relationship status with Prisma
 * 2. Write phase: Update relationships atomically with D1 batch
 *
 * Handles:
 * - Rejecting outgoing friend requests
 * - Unfriending (converts to pending/requested state)
 * - Rejecting incoming friend requests
 */
export async function friendRemove(
    ctx: WorkerContext,
    uid: string,
    filesPublicUrl?: string
): Promise<UserProfile | null> {
    const { prisma, db } = ctx;

    return await inBatch(db, async (batchCtx) => {
        // Read phase: Get user objects and relationships
        const currentUser = await prisma.account.findUnique({
            where: { id: ctx.uid },
            include: { githubUser: true },
        });
        const targetUser = await prisma.account.findUnique({
            where: { id: uid },
            include: { githubUser: true },
        });

        if (!currentUser || !targetUser) {
            return null;
        }

        // Read relationship status using Prisma
        const currentUserRelationship = await relationshipGet(prisma, currentUser.id, targetUser.id);
        const targetUserRelationship = await relationshipGet(prisma, targetUser.id, currentUser.id);

        // If status is requested, set it to rejected
        if (currentUserRelationship === RelationshipStatus.requested) {
            queueRelationshipUpdate(batchCtx, db, currentUser.id, targetUser.id, "rejected");
            return buildUserProfile(
                targetUser as Parameters<typeof buildUserProfile>[0],
                RelationshipStatus.rejected,
                filesPublicUrl
            );
        }

        // If they are friends, change it to pending and requested
        if (currentUserRelationship === RelationshipStatus.friend) {
            queueRelationshipUpdate(batchCtx, db, targetUser.id, currentUser.id, "requested");
            queueRelationshipUpdate(batchCtx, db, currentUser.id, targetUser.id, "pending");
            return buildUserProfile(
                targetUser as Parameters<typeof buildUserProfile>[0],
                RelationshipStatus.requested,
                filesPublicUrl
            );
        }

        // If status is pending, set it to none
        if (currentUserRelationship === RelationshipStatus.pending) {
            queueRelationshipUpdate(batchCtx, db, currentUser.id, targetUser.id, "none");
            if (targetUserRelationship !== RelationshipStatus.rejected) {
                queueRelationshipUpdate(batchCtx, db, targetUser.id, currentUser.id, "none");
            }
            return buildUserProfile(
                targetUser as Parameters<typeof buildUserProfile>[0],
                RelationshipStatus.none,
                filesPublicUrl
            );
        }

        // Return the target user profile with current status (no changes)
        return buildUserProfile(
            targetUser as Parameters<typeof buildUserProfile>[0],
            currentUserRelationship,
            filesPublicUrl
        );
    });
}

/**
 * Queue a relationship upsert statement for D1 batch execution.
 * Uses INSERT OR REPLACE for SQLite upsert behavior.
 */
function queueRelationshipUpsert(
    batchCtx: BatchContext,
    db: D1Database,
    fromUserId: string,
    toUserId: string,
    status: string,
    acceptedAt: string | null
): void {
    addStatement(
        batchCtx,
        db.prepare(`
        INSERT INTO UserRelationship (fromUserId, toUserId, status, acceptedAt, lastNotifiedAt)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT (fromUserId, toUserId)
        DO UPDATE SET
            status = excluded.status,
            acceptedAt = excluded.acceptedAt
    `).bind(fromUserId, toUserId, status, acceptedAt)
    );
}

/**
 * Queue a relationship status update for D1 batch execution.
 * Only updates existing records (does not create new ones).
 */
function queueRelationshipUpdate(
    batchCtx: BatchContext,
    db: D1Database,
    fromUserId: string,
    toUserId: string,
    status: string
): void {
    addStatement(
        batchCtx,
        db.prepare(`
        UPDATE UserRelationship
        SET status = ?, acceptedAt = NULL
        WHERE fromUserId = ? AND toUserId = ?
    `).bind(status, fromUserId, toUserId)
    );
}
