import { WorkerContext } from "@/context";
import { buildUserProfile, UserProfile } from "./type";
import { inBatch, addStatement, BatchContext } from "@/storage/inBatch";
import { RelationshipStatus } from "@prisma/client";
import { relationshipGet } from "./relationshipGet";

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
export async function friendRemove(ctx: WorkerContext, uid: string): Promise<UserProfile | null> {
    const { prisma, db } = ctx;

    return await inBatch(db, async (batchCtx) => {
        // Read phase: Get user objects and relationships
        const currentUser = await prisma.account.findUnique({
            where: { id: ctx.uid },
            include: { githubUser: true }
        });
        const targetUser = await prisma.account.findUnique({
            where: { id: uid },
            include: { githubUser: true }
        });

        if (!currentUser || !targetUser) {
            return null;
        }

        // Read relationship status using Prisma
        const currentUserRelationship = await relationshipGet(prisma, currentUser.id, targetUser.id);
        const targetUserRelationship = await relationshipGet(prisma, targetUser.id, currentUser.id);

        // If status is requested, set it to rejected
        if (currentUserRelationship === RelationshipStatus.requested) {
            queueRelationshipUpdate(batchCtx, db, currentUser.id, targetUser.id, 'rejected');
            return buildUserProfile(targetUser, RelationshipStatus.rejected);
        }

        // If they are friends, change it to pending and requested
        if (currentUserRelationship === RelationshipStatus.friend) {
            queueRelationshipUpdate(batchCtx, db, targetUser.id, currentUser.id, 'requested');
            queueRelationshipUpdate(batchCtx, db, currentUser.id, targetUser.id, 'pending');
            return buildUserProfile(targetUser, RelationshipStatus.requested);
        }

        // If status is pending, set it to none
        if (currentUserRelationship === RelationshipStatus.pending) {
            queueRelationshipUpdate(batchCtx, db, currentUser.id, targetUser.id, 'none');
            if (targetUserRelationship !== RelationshipStatus.rejected) {
                queueRelationshipUpdate(batchCtx, db, targetUser.id, currentUser.id, 'none');
            }
            return buildUserProfile(targetUser, RelationshipStatus.none);
        }

        // Return the target user profile with current status (no changes)
        return buildUserProfile(targetUser, currentUserRelationship);
    });
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
    // Clear acceptedAt when changing away from 'friend' status
    addStatement(batchCtx, db.prepare(`
        UPDATE UserRelationship
        SET status = ?, acceptedAt = NULL
        WHERE fromUserId = ? AND toUserId = ?
    `).bind(status, fromUserId, toUserId));
}