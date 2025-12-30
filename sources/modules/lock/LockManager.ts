/**
 * LockManager Durable Object
 *
 * Provides distributed locking functionality using Durable Objects.
 * Replaces the process-internal AsyncLock with true distributed locks
 * that work across all Workers instances.
 */

interface LockEntry {
    holder: string;
    acquiredAt: number;
    expiresAt: number;
}

export class LockManager implements DurableObject {
    private state: DurableObjectState;
    private locks: Map<string, LockEntry> = new Map();
    private waiters: Map<string, Array<{
        resolve: (acquired: boolean) => void;
        holderId: string;
        ttl: number;
    }>> = new Map();

    constructor(state: DurableObjectState, _env: unknown) {
        this.state = state;

        // Schedule cleanup of expired locks
        this.scheduleCleanup();
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        switch (url.pathname) {
            case "/acquire":
                return this.handleAcquire(request);
            case "/release":
                return this.handleRelease(request);
            case "/extend":
                return this.handleExtend(request);
            case "/status":
                return this.handleStatus(request);
            default:
                return new Response("Not Found", { status: 404 });
        }
    }

    private async handleAcquire(request: Request): Promise<Response> {
        try {
            const body = await request.json() as {
                lockId: string;
                holderId: string;
                ttl: number;
                wait?: boolean;
                timeout?: number;
            };

            const { lockId, holderId, ttl, wait = false, timeout = 30000 } = body;

            // Validate inputs
            if (!lockId || !holderId || !ttl) {
                return Response.json({ error: "Missing required fields" }, { status: 400 });
            }

            // Clean expired locks first
            this.cleanupExpiredLocks();

            // Check if lock is available
            const existing = this.locks.get(lockId);
            if (!existing) {
                // Lock is free, acquire it
                return this.acquireLock(lockId, holderId, ttl);
            }

            // Lock exists - check if it's the same holder (reentrant)
            if (existing.holder === holderId) {
                // Extend the existing lock
                existing.expiresAt = Date.now() + ttl;
                return Response.json({ acquired: true, reentrant: true });
            }

            // Lock held by another - either wait or fail
            if (!wait) {
                return Response.json({
                    acquired: false,
                    holder: existing.holder,
                    expiresAt: existing.expiresAt,
                });
            }

            // Wait for lock
            return this.waitForLock(lockId, holderId, ttl, timeout);
        } catch {
            return Response.json({ error: "Invalid request" }, { status: 400 });
        }
    }

    private acquireLock(lockId: string, holderId: string, ttl: number): Response {
        const entry: LockEntry = {
            holder: holderId,
            acquiredAt: Date.now(),
            expiresAt: Date.now() + ttl,
        };

        this.locks.set(lockId, entry);

        return Response.json({ acquired: true, expiresAt: entry.expiresAt });
    }

    private async waitForLock(
        lockId: string,
        holderId: string,
        ttl: number,
        timeout: number
    ): Promise<Response> {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                // Remove from waiters on timeout
                const waiterList = this.waiters.get(lockId);
                if (waiterList) {
                    const idx = waiterList.findIndex((w) => w.holderId === holderId);
                    if (idx !== -1) {
                        waiterList.splice(idx, 1);
                    }
                }
                resolve(Response.json({ acquired: false, timeout: true }));
            }, timeout);

            const waiter = {
                resolve: (acquired: boolean) => {
                    clearTimeout(timeoutId);
                    if (acquired) {
                        const entry = this.locks.get(lockId);
                        resolve(Response.json({ acquired: true, expiresAt: entry?.expiresAt }));
                    } else {
                        resolve(Response.json({ acquired: false }));
                    }
                },
                holderId,
                ttl,
            };

            if (!this.waiters.has(lockId)) {
                this.waiters.set(lockId, []);
            }
            this.waiters.get(lockId)!.push(waiter);
        });
    }

    private async handleRelease(request: Request): Promise<Response> {
        try {
            const body = await request.json() as { lockId: string; holderId: string };
            const { lockId, holderId } = body;

            const existing = this.locks.get(lockId);
            if (!existing) {
                return Response.json({ released: false, error: "Lock not found" });
            }

            if (existing.holder !== holderId) {
                return Response.json({ released: false, error: "Not lock holder" }, { status: 403 });
            }

            this.locks.delete(lockId);
            this.notifyWaiters(lockId);

            return Response.json({ released: true });
        } catch {
            return Response.json({ error: "Invalid request" }, { status: 400 });
        }
    }

    private async handleExtend(request: Request): Promise<Response> {
        try {
            const body = await request.json() as { lockId: string; holderId: string; ttl: number };
            const { lockId, holderId, ttl } = body;

            const existing = this.locks.get(lockId);
            if (!existing) {
                return Response.json({ extended: false, error: "Lock not found" });
            }

            if (existing.holder !== holderId) {
                return Response.json({ extended: false, error: "Not lock holder" }, { status: 403 });
            }

            existing.expiresAt = Date.now() + ttl;

            return Response.json({ extended: true, expiresAt: existing.expiresAt });
        } catch {
            return Response.json({ error: "Invalid request" }, { status: 400 });
        }
    }

    private handleStatus(request: Request): Response {
        const url = new URL(request.url);
        const lockId = url.searchParams.get("lockId");

        if (lockId) {
            const entry = this.locks.get(lockId);
            if (entry) {
                return Response.json({
                    locked: true,
                    holder: entry.holder,
                    acquiredAt: entry.acquiredAt,
                    expiresAt: entry.expiresAt,
                    waiters: this.waiters.get(lockId)?.length || 0,
                });
            }
            return Response.json({ locked: false });
        }

        // Return all locks
        const allLocks: Record<string, LockEntry & { waiters: number }> = {};
        for (const [id, entry] of this.locks) {
            allLocks[id] = {
                ...entry,
                waiters: this.waiters.get(id)?.length || 0,
            };
        }

        return Response.json({
            totalLocks: this.locks.size,
            locks: allLocks,
        });
    }

    private notifyWaiters(lockId: string): void {
        const waiterList = this.waiters.get(lockId);
        if (!waiterList || waiterList.length === 0) return;

        // Get next waiter (FIFO)
        const nextWaiter = waiterList.shift();
        if (nextWaiter) {
            // Acquire lock for the waiter
            const entry: LockEntry = {
                holder: nextWaiter.holderId,
                acquiredAt: Date.now(),
                expiresAt: Date.now() + nextWaiter.ttl,
            };
            this.locks.set(lockId, entry);
            nextWaiter.resolve(true);
        }

        if (waiterList.length === 0) {
            this.waiters.delete(lockId);
        }
    }

    private cleanupExpiredLocks(): void {
        const now = Date.now();
        const expired: string[] = [];

        for (const [lockId, entry] of this.locks) {
            if (entry.expiresAt <= now) {
                expired.push(lockId);
            }
        }

        for (const lockId of expired) {
            this.locks.delete(lockId);
            this.notifyWaiters(lockId);
        }
    }

    private scheduleCleanup(): void {
        // Set up alarm for periodic cleanup
        this.state.storage.setAlarm(Date.now() + 60000); // Run every minute
    }

    async alarm(): Promise<void> {
        this.cleanupExpiredLocks();
        this.scheduleCleanup();
    }
}
