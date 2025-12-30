import { WorkerContext } from "@/context";
import { buildUserProfile, UserProfile } from "./type";
import { inBatch, addStatement, afterBatch, BatchContext } from "@/storage/inBatch";
import { RelationshipStatus } from "@prisma/client";
import { relationshipGet } from "./relationshipGet";

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
export async function friendAdd(ctx: WorkerContext, uid: string): Promise<UserProfile | null> {
    const { prisma, db } = ctx;

    // Prevent self-friendship
    if (ctx.uid === uid) {
        return null;
    }

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

        // Handle cases

        // Case 1: There's a pending request from the target user - accept it
        if (targetUserRelationship === RelationshipStatus.requested) {
            const now = new Date().toISOString();

            // Accept the friend request - update both to friends (atomic batch)
            queueRelationshipUpsert(batchCtx, db, targetUser.id, currentUser.id, 'friend', now);
            queueRelationshipUpsert(batchCtx, db, currentUser.id, targetUser.id, 'friend', now);

            // Notifications are side effects - run after successful batch
            afterBatch(batchCtx, async () => {
                // TODO: Migrate notifications to work with Worker context
                // await sendFriendshipEstablishedNotification(ctx, currentUser.id, targetUser.id);
            });

            return buildUserProfile(targetUser, RelationshipStatus.friend);
        }

        // Case 2: If status is none or rejected, create a new request
        if (currentUserRelationship === RelationshipStatus.none
            || currentUserRelationship === RelationshipStatus.rejected) {

            // Create friend request
            queueRelationshipUpsert(batchCtx, db, currentUser.id, targetUser.id, 'requested', null);

            // If other side is in none state, set it to pending
            if (targetUserRelationship === RelationshipStatus.none) {
                queueRelationshipUpsert(batchCtx, db, targetUser.id, currentUser.id, 'pending', null);
            }

            // Notifications are side effects - run after successful batch
            afterBatch(batchCtx, async () => {
                // TODO: Migrate notifications to work with Worker context
                // await sendFriendRequestNotification(ctx, targetUser.id, currentUser.id);
            });

            return buildUserProfile(targetUser, RelationshipStatus.requested);
        }

        // Do not change anything and return the target user profile
        return buildUserProfile(targetUser, currentUserRelationship);
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
    // SQLite/D1 upsert using INSERT OR REPLACE
    // We need to preserve lastNotifiedAt if the record exists
    // Using INSERT ... ON CONFLICT for more precise control
    addStatement(batchCtx, db.prepare(`
        INSERT INTO UserRelationship (fromUserId, toUserId, status, acceptedAt, lastNotifiedAt)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT (fromUserId, toUserId)
        DO UPDATE SET
            status = excluded.status,
            acceptedAt = excluded.acceptedAt
    `).bind(fromUserId, toUserId, status, acceptedAt));
}