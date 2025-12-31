/**
 * Event emitter helper for sending real-time updates to clients.
 *
 * Provides a simple interface to emit events via the ConnectionManager
 * Durable Object. Used by route handlers to send updates to connected clients.
 */

import type { UpdatePayload, EphemeralPayload } from "./events";

/**
 * Recipient filter types for controlling which connections receive events.
 */
export type RecipientFilter =
    | { type: "all-interested-in-session"; sessionId: string }
    | { type: "user-scoped-only" }
    | { type: "machine-scoped-only"; machineId: string }
    | { type: "all-user-authenticated-connections" };

/**
 * Options for emitting an event.
 */
export interface EmitOptions {
    /** User ID to send the event to */
    userId: string;
    /** Filter to control which connections receive the event */
    recipientFilter?: RecipientFilter;
}

/**
 * Event emitter class for sending real-time updates.
 */
export class EventEmitter {
    private connectionManager: DurableObjectNamespace;

    constructor(connectionManager: DurableObjectNamespace) {
        this.connectionManager = connectionManager;
    }

    /**
     * Emit an update event to a user's connections.
     *
     * @param payload - Update event payload
     * @param options - Emit options including userId and optional filter
     */
    async emitUpdate(payload: UpdatePayload, options: EmitOptions): Promise<void> {
        await this.emit("update", payload, options);
    }

    /**
     * Emit an ephemeral event to a user's connections.
     *
     * @param payload - Ephemeral event payload
     * @param options - Emit options including userId and optional filter
     */
    async emitEphemeral(payload: EphemeralPayload, options: EmitOptions): Promise<void> {
        await this.emit("ephemeral", payload, options);
    }

    /**
     * Internal emit method that sends events to the ConnectionManager DO.
     */
    private async emit(
        eventType: "update" | "ephemeral",
        payload: UpdatePayload | EphemeralPayload,
        options: EmitOptions
    ): Promise<void> {
        const { userId, recipientFilter } = options;

        // Get the ConnectionManager DO for this user
        const id = this.connectionManager.idFromName(userId);
        const stub = this.connectionManager.get(id);

        // Build the message with event type and filter
        const message = {
            eventType,
            payload,
            filter: recipientFilter || { type: "all-user-authenticated-connections" },
        };

        try {
            // Send to the ConnectionManager's /send endpoint
            await stub.fetch("http://internal/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    userId,
                    message,
                }),
            });
        } catch (error) {
            // Log but don't throw - event delivery is best-effort
            console.error(`Failed to emit ${eventType} event to user ${userId}:`, error);
        }
    }

    /**
     * Broadcast an event to all connections of a user.
     *
     * @param payload - Event payload
     * @param userId - User ID to broadcast to
     */
    async broadcast(payload: UpdatePayload | EphemeralPayload, userId: string): Promise<void> {
        const id = this.connectionManager.idFromName(userId);
        const stub = this.connectionManager.get(id);

        try {
            await stub.fetch("http://internal/broadcast", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: payload }),
            });
        } catch (error) {
            console.error(`Failed to broadcast event to user ${userId}:`, error);
        }
    }
}

/**
 * Create an event emitter instance.
 *
 * @param connectionManager - ConnectionManager Durable Object namespace
 * @returns EventEmitter instance
 */
export function createEventEmitter(connectionManager: DurableObjectNamespace): EventEmitter {
    return new EventEmitter(connectionManager);
}
