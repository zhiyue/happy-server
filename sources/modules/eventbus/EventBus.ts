/**
 * EventBus Durable Object
 *
 * Provides pub/sub functionality for real-time event distribution.
 * Works alongside ConnectionManager to deliver events to connected clients.
 *
 * Architecture:
 * - Each user has their own EventBus instance (keyed by userId)
 * - EventBus receives events via HTTP and broadcasts to subscribed clients
 * - Integrates with ConnectionManager for WebSocket delivery
 */

/**
 * Event types supported by the EventBus.
 */
export type EventType = "update" | "ephemeral";

/**
 * Subscription entry for tracking event listeners.
 */
interface Subscription {
    id: string;
    channel: string;
    createdAt: number;
}

export class EventBus implements DurableObject {
    private state: DurableObjectState;
    private subscriptions: Map<string, Subscription> = new Map();
    private sessions: Map<WebSocket, { id: string; channels: Set<string> }> = new Map();

    constructor(state: DurableObjectState, _env: unknown) {
        this.state = state;

        // Restore WebSocket sessions from hibernation
        this.state.getWebSockets().forEach((ws) => {
            const meta = ws.deserializeAttachment() as { id: string; channels: string[] } | null;
            if (meta) {
                this.sessions.set(ws, {
                    id: meta.id,
                    channels: new Set(meta.channels),
                });
            }
        });
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // WebSocket upgrade for event subscription
        if (request.headers.get("Upgrade") === "websocket") {
            return this.handleWebSocketUpgrade(request);
        }

        switch (url.pathname) {
            case "/publish":
                return this.handlePublish(request);
            case "/subscribe":
                return this.handleSubscribe(request);
            case "/unsubscribe":
                return this.handleUnsubscribe(request);
            case "/broadcast":
                return this.handleBroadcast(request);
            case "/stats":
                return this.handleStats();
            default:
                return new Response("Not Found", { status: 404 });
        }
    }

    /**
     * Handle WebSocket upgrade for real-time event subscription.
     */
    private handleWebSocketUpgrade(request: Request): Response {
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];

        const url = new URL(request.url);
        const channels = url.searchParams.get("channels")?.split(",") || [];

        const sessionId = crypto.randomUUID();
        const meta = {
            id: sessionId,
            channels,
        };

        this.state.acceptWebSocket(server);
        server.serializeAttachment(meta);

        this.sessions.set(server, {
            id: sessionId,
            channels: new Set(channels),
        });

        // Send confirmation
        server.send(JSON.stringify({
            type: "connected",
            sessionId,
            channels,
        }));

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    /**
     * Handle incoming WebSocket messages.
     */
    async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
        const session = this.sessions.get(ws);
        if (!session) return;

        try {
            const data = typeof message === "string" ? JSON.parse(message) : null;
            if (!data) return;

            switch (data.type) {
                case "subscribe":
                    if (data.channel) {
                        session.channels.add(data.channel);
                        ws.serializeAttachment({
                            id: session.id,
                            channels: Array.from(session.channels),
                        });
                        ws.send(JSON.stringify({
                            type: "subscribed",
                            channel: data.channel,
                        }));
                    }
                    break;

                case "unsubscribe":
                    if (data.channel) {
                        session.channels.delete(data.channel);
                        ws.serializeAttachment({
                            id: session.id,
                            channels: Array.from(session.channels),
                        });
                        ws.send(JSON.stringify({
                            type: "unsubscribed",
                            channel: data.channel,
                        }));
                    }
                    break;

                case "ping":
                    ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
                    break;
            }
        } catch (err) {
            console.error("EventBus WebSocket message error:", err);
        }
    }

    /**
     * Handle WebSocket close.
     */
    async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
        this.sessions.delete(ws);
    }

    /**
     * Handle WebSocket error.
     */
    async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
        this.sessions.delete(ws);
    }

    /**
     * Publish an event to a specific channel.
     */
    private async handlePublish(request: Request): Promise<Response> {
        try {
            const body = await request.json() as {
                type: EventType;
                channel: string;
                payload: unknown;
            };

            const { type, channel, payload } = body;

            // Broadcast to all WebSocket sessions subscribed to this channel
            let sent = 0;
            const message = JSON.stringify({
                type,
                channel,
                payload,
                timestamp: Date.now(),
            });

            for (const [ws, session] of this.sessions) {
                if (session.channels.has(channel) || session.channels.has("*")) {
                    try {
                        ws.send(message);
                        sent++;
                    } catch {
                        // Socket may be closed
                    }
                }
            }

            return Response.json({ success: true, sent });
        } catch {
            return Response.json({ error: "Invalid request" }, { status: 400 });
        }
    }

    /**
     * Subscribe to a channel (HTTP API for non-WebSocket clients).
     */
    private async handleSubscribe(request: Request): Promise<Response> {
        try {
            const body = await request.json() as { channel: string; subscriberId: string };
            const { channel, subscriberId } = body;

            const subscription: Subscription = {
                id: subscriberId,
                channel,
                createdAt: Date.now(),
            };

            this.subscriptions.set(`${subscriberId}:${channel}`, subscription);

            return Response.json({ success: true, subscription });
        } catch {
            return Response.json({ error: "Invalid request" }, { status: 400 });
        }
    }

    /**
     * Unsubscribe from a channel.
     */
    private async handleUnsubscribe(request: Request): Promise<Response> {
        try {
            const body = await request.json() as { channel: string; subscriberId: string };
            const { channel, subscriberId } = body;

            this.subscriptions.delete(`${subscriberId}:${channel}`);

            return Response.json({ success: true });
        } catch {
            return Response.json({ error: "Invalid request" }, { status: 400 });
        }
    }

    /**
     * Broadcast to all connected sessions regardless of channel.
     */
    private async handleBroadcast(request: Request): Promise<Response> {
        try {
            const body = await request.json() as {
                type: EventType;
                payload: unknown;
            };

            const message = JSON.stringify({
                type: body.type,
                payload: body.payload,
                timestamp: Date.now(),
            });

            let sent = 0;
            for (const ws of this.sessions.keys()) {
                try {
                    ws.send(message);
                    sent++;
                } catch {
                    // Socket may be closed
                }
            }

            return Response.json({ success: true, sent });
        } catch {
            return Response.json({ error: "Invalid request" }, { status: 400 });
        }
    }

    /**
     * Get EventBus statistics.
     */
    private handleStats(): Response {
        const channelCounts: Record<string, number> = {};
        for (const session of this.sessions.values()) {
            for (const channel of session.channels) {
                channelCounts[channel] = (channelCounts[channel] || 0) + 1;
            }
        }

        return Response.json({
            totalSessions: this.sessions.size,
            totalSubscriptions: this.subscriptions.size,
            channelCounts,
        });
    }
}
