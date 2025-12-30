import { WorkerContext } from "@/context";
import { inBatch, addStatement, afterBatch } from "@/storage/inBatch";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { eventRouter, buildKVBatchUpdateUpdate } from "@/app/events/eventRouter";
import * as privacyKit from "privacy-kit";

export interface KVMutation {
    key: string;
    value: string | null; // null = delete (sets value to null but keeps record)
    version: number; // Always required, use -1 for new keys
}

export interface KVMutateResult {
    success: boolean;
    results?: Array<{
        key: string;
        version: number;
    }>;
    errors?: Array<{
        key: string;
        error: 'version-mismatch';
        version: number;
        value: string | null;  // Current value (null if deleted)
    }>;
}

/**
 * Atomically mutate multiple key-value pairs using D1 batch.
 *
 * Pattern: Read-then-batch
 * 1. Read phase: Use Prisma to validate versions and check for conflicts
 * 2. Write phase: Use D1 batch for atomic insert/update operations
 * 3. Side effects: Send notifications after successful batch
 *
 * All mutations succeed or all fail.
 * Version is always required for all operations (use -1 for new keys).
 * Delete operations set value to null but keep the record with incremented version.
 * Sends a single bundled update notification for all changes.
 */
export async function kvMutate(
    ctx: WorkerContext,
    mutations: KVMutation[]
): Promise<KVMutateResult> {
    const { prisma, db, uid } = ctx;

    return await inBatch(db, async (batchCtx) => {
        const errors: KVMutateResult['errors'] = [];

        // Read phase: Pre-validate all mutations using Prisma
        for (const mutation of mutations) {
            const existing = await prisma.userKVStore.findUnique({
                where: {
                    accountId_key: {
                        accountId: uid,
                        key: mutation.key
                    }
                }
            });

            const currentVersion = existing?.version ?? -1;

            // Version check is always required
            if (currentVersion !== mutation.version) {
                errors.push({
                    key: mutation.key,
                    error: 'version-mismatch',
                    version: currentVersion,
                    value: existing?.value ? privacyKit.encodeBase64(existing.value) : null
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

                addStatement(batchCtx, db.prepare(
                    'INSERT INTO UserKVStore (accountId, key, value, version) VALUES (?, ?, ?, ?)'
                ).bind(uid, mutation.key, valueBytes, newVersion));

                results.push({
                    key: mutation.key,
                    version: newVersion
                });

                changes.push({
                    key: mutation.key,
                    value: mutation.value,
                    version: newVersion
                });
            } else {
                // Update existing entry (including "delete" which sets value to null)
                const newVersion = mutation.version + 1;
                const valueBytes = mutation.value ? privacyKit.decodeBase64(mutation.value) : null;

                addStatement(batchCtx, db.prepare(
                    'UPDATE UserKVStore SET value = ?, version = ? WHERE accountId = ? AND key = ?'
                ).bind(valueBytes, newVersion, uid, mutation.key));

                results.push({
                    key: mutation.key,
                    version: newVersion
                });

                changes.push({
                    key: mutation.key,
                    value: mutation.value,
                    version: newVersion
                });
            }
        }

        // Side effects: Send notification after successful batch
        afterBatch(batchCtx, async () => {
            const updateSeq = await allocateUserSeq(uid);
            eventRouter.emitUpdate({
                userId: uid,
                payload: buildKVBatchUpdateUpdate(changes, updateSeq, randomKeyNaked(12)),
                recipientFilter: { type: 'user-scoped-only' }
            });
        });

        return { success: true, results };
    });
}