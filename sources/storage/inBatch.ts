/**
 * inBatch - Atomic batch operations for D1
 *
 * D1 does not support traditional SQL transactions via Prisma.
 * This utility provides atomic batch operations using D1's .batch() method,
 * which ensures all statements succeed or all roll back.
 *
 * Usage pattern:
 * 1. Read phase: Use Prisma for type-safe reads (outside batch)
 * 2. Write phase: Collect D1 prepared statements
 * 3. Execute: Run all statements atomically via batch
 * 4. Side effects: Run callbacks after successful batch
 */

type BatchCallback = () => void | Promise<void>;

/**
 * Context object passed to batch functions.
 * Collects statements and callbacks during the execution phase.
 */
export interface BatchContext {
    /** D1 database binding */
    db: D1Database;
    /** Prepared statements to execute atomically */
    statements: D1PreparedStatement[];
    /** Callbacks to run after successful batch execution */
    afterCallbacks: BatchCallback[];
}

/**
 * Execute a batch of D1 operations atomically.
 *
 * The callback function should:
 * 1. Perform any reads needed (using Prisma)
 * 2. Call addStatement() to queue write operations
 * 3. Call afterBatch() for side effects after success
 *
 * @param db - D1 database binding
 * @param fn - Batch function that queues statements
 * @returns The result of the batch function
 *
 * @example
 * ```typescript
 * const result = await inBatch(env.DB, async (ctx) => {
 *     // Read with Prisma (outside batch)
 *     const user = await prisma.user.findUnique({ where: { id } });
 *     if (!user) return null;
 *
 *     // Queue writes
 *     addStatement(ctx, ctx.db.prepare(
 *         'UPDATE relationship SET status = ? WHERE fromId = ? AND toId = ?'
 *     ).bind('friend', user.id, targetId));
 *
 *     // Side effect after success
 *     afterBatch(ctx, () => sendNotification());
 *
 *     return { success: true };
 * });
 * ```
 */
export async function inBatch<T>(
    db: D1Database,
    fn: (ctx: BatchContext) => Promise<T>
): Promise<T> {
    const ctx: BatchContext = {
        db,
        statements: [],
        afterCallbacks: [],
    };

    // Execute the batch function to collect statements
    const result = await fn(ctx);

    // Execute all statements atomically
    if (ctx.statements.length > 0) {
        await db.batch(ctx.statements);
    }

    // Run after-callbacks on success
    for (const callback of ctx.afterCallbacks) {
        try {
            await callback();
        } catch (e) {
            console.error("After-batch callback error:", e);
        }
    }

    return result;
}

/**
 * Add a prepared statement to the batch context.
 *
 * @param ctx - Batch context
 * @param stmt - D1 prepared statement
 */
export function addStatement(ctx: BatchContext, stmt: D1PreparedStatement): void {
    ctx.statements.push(stmt);
}

/**
 * Register a callback to run after successful batch execution.
 * Similar to afterTx but for D1 batch operations.
 *
 * @param ctx - Batch context
 * @param callback - Callback to run after batch success
 */
export function afterBatch(ctx: BatchContext, callback: BatchCallback): void {
    ctx.afterCallbacks.push(callback);
}

/**
 * Helper to build UPDATE statements with proper binding.
 *
 * @param table - Table name
 * @param updates - Object of column-value pairs to update
 * @param where - Object of column-value pairs for WHERE clause
 * @returns SQL string and bind values
 */
export function buildUpdate(
    table: string,
    updates: Record<string, unknown>,
    where: Record<string, unknown>
): { sql: string; values: unknown[] } {
    const setClauses: string[] = [];
    const whereClauses: string[] = [];
    const values: unknown[] = [];

    for (const [col, val] of Object.entries(updates)) {
        setClauses.push(`${col} = ?`);
        values.push(val);
    }

    for (const [col, val] of Object.entries(where)) {
        whereClauses.push(`${col} = ?`);
        values.push(val);
    }

    const sql = `UPDATE ${table} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;
    return { sql, values };
}

/**
 * Helper to build INSERT statements with proper binding.
 *
 * @param table - Table name
 * @param data - Object of column-value pairs to insert
 * @returns SQL string and bind values
 */
export function buildInsert(
    table: string,
    data: Record<string, unknown>
): { sql: string; values: unknown[] } {
    const columns = Object.keys(data);
    const placeholders = columns.map(() => "?").join(", ");
    const values = Object.values(data);

    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
    return { sql, values };
}

/**
 * Helper to build DELETE statements with proper binding.
 *
 * @param table - Table name
 * @param where - Object of column-value pairs for WHERE clause
 * @returns SQL string and bind values
 */
export function buildDelete(
    table: string,
    where: Record<string, unknown>
): { sql: string; values: unknown[] } {
    const whereClauses: string[] = [];
    const values: unknown[] = [];

    for (const [col, val] of Object.entries(where)) {
        whereClauses.push(`${col} = ?`);
        values.push(val);
    }

    const sql = `DELETE FROM ${table} WHERE ${whereClauses.join(" AND ")}`;
    return { sql, values };
}
