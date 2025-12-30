import { WorkerContext } from "@/context";
import { inBatch, addStatement, afterBatch } from "@/storage/inBatch";
import { eventRouter, buildDeleteSessionUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";

/**
 * Delete a session and all its related data using D1 batch.
 *
 * Pattern: Read-then-batch
 * 1. Read phase: Verify session exists and belongs to user
 * 2. Write phase: Use D1 batch for atomic cascade deletes
 * 3. Side effects: Send socket notification after successful batch
 *
 * Handles:
 * - Deleting all session messages
 * - Deleting all usage reports for the session
 * - Deleting all access keys for the session
 * - Deleting the session itself
 * - Sending socket notification to all connected clients
 *
 * @param ctx - Worker context with user and database access
 * @param sessionId - ID of the session to delete
 * @returns true if deletion was successful, false if session not found or not owned by user
 */
export async function sessionDelete(ctx: WorkerContext, sessionId: string): Promise<boolean> {
    const { prisma, db, uid } = ctx;

    return await inBatch(db, async (batchCtx) => {
        // Read phase: Verify session exists and belongs to the user
        const session = await prisma.session.findFirst({
            where: {
                id: sessionId,
                accountId: uid
            }
        });

        if (!session) {
            log({
                module: 'session-delete',
                userId: uid,
                sessionId
            }, `Session not found or not owned by user`);
            return false;
        }

        // Write phase: Queue cascade delete statements
        // Note: Order matters to avoid foreign key constraint violations

        // 1. Delete session messages
        addStatement(batchCtx, db.prepare(
            'DELETE FROM SessionMessage WHERE sessionId = ?'
        ).bind(sessionId));

        // 2. Delete usage reports
        addStatement(batchCtx, db.prepare(
            'DELETE FROM UsageReport WHERE sessionId = ?'
        ).bind(sessionId));

        // 3. Delete access keys
        addStatement(batchCtx, db.prepare(
            'DELETE FROM AccessKey WHERE sessionId = ?'
        ).bind(sessionId));

        // 4. Delete the session itself
        addStatement(batchCtx, db.prepare(
            'DELETE FROM Session WHERE id = ?'
        ).bind(sessionId));

        log({
            module: 'session-delete',
            userId: uid,
            sessionId
        }, `Session delete queued for batch execution`);

        // Side effects: Send notification after successful batch
        afterBatch(batchCtx, async () => {
            const updSeq = await allocateUserSeq(uid);
            const updatePayload = buildDeleteSessionUpdate(sessionId, updSeq, randomKeyNaked(12));

            log({
                module: 'session-delete',
                userId: uid,
                sessionId,
                updateType: 'delete-session',
                updatePayload: JSON.stringify(updatePayload)
            }, `Emitting delete-session update to user-scoped connections`);

            eventRouter.emitUpdate({
                userId: uid,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        });

        return true;
    });
}