/**
 * ConnectionManager Durable Object
 *
 * Manages WebSocket connections for real-time communication.
 * Replaces Socket.io functionality with native Workers WebSocket API.
 *
 * Each ConnectionManager instance handles connections for a specific scope
 * (e.g., user connections, room connections).
 */

interface WebSocketSession {
    id: string;
    userId?: string;
    connectedAt: number;
    lastPingAt: number;
}

export class ConnectionManager implements DurableObject {
    private state: DurableObjectState;
    private sessions: Map<WebSocket, WebSocketSession> = new Map();
    private userSockets: Map<string, Set<WebSocket>> = new Map();

    constructor(state: DurableObjectState, _env: unknown) {
        this.state = state;

        // Restore WebSocket sessions from hibernation
        this.state.getWebSockets().forEach((ws) => {
            const meta = ws.deserializeAttachment() as WebSocketSession | null;
            if (meta) {
                this.sessions.set(ws, meta);
                if (meta.userId) {
                    if (!this.userSockets.has(meta.userId)) {
                        this.userSockets.set(meta.userId, new Set());
                    }
                    this.userSockets.get(meta.userId)!.add(ws);
                }
            }
        });
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // WebSocket upgrade
        if (request.headers.get("Upgrade") === "websocket") {
            return this.handleWebSocketUpgrade(request);
        }

        // HTTP API for broadcasting
        if (url.pathname === "/broadcast" && request.method === "POST") {
            return this.handleBroadcast(request);
        }

        // Send message to specific user
        if (url.pathname === "/send" && request.method === "POST") {
            return this.handleSendToUser(request);
        }

        // Get connection stats
        if (url.pathname === "/stats" && request.method === "GET") {
            return this.handleStats();
        }

        return new Response("Not Found", { status: 404 });
    }

    private handleWebSocketUpgrade(request: Request): Response {
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];

        const url = new URL(request.url);
        const userId = url.searchParams.get("userId") || undefined;

        const session: WebSocketSession = {
            id: crypto.randomUUID(),
            userId,
            connectedAt: Date.now(),
            lastPingAt: Date.now(),
        };

        // Accept the WebSocket connection with hibernation support
        this.state.acceptWebSocket(server);
        server.serializeAttachment(session);

        this.sessions.set(server, session);

        // Track user sockets
        if (userId) {
            if (!this.userSockets.has(userId)) {
                this.userSockets.set(userId, new Set());
            }
            this.userSockets.get(userId)!.add(server);
        }

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
        const session = this.sessions.get(ws);
        if (!session) return;

        try {
            const data = typeof message === "string" ? JSON.parse(message) : null;
            if (!data) return;

            switch (data.type) {
                case "ping":
                    session.lastPingAt = Date.now();
                    ws.serializeAttachment(session);
                    ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
                    break;

                case "auth":
                    // Handle authentication/binding to user
                    if (data.userId && !session.userId) {
                        session.userId = data.userId;
                        ws.serializeAttachment(session);

                        if (!this.userSockets.has(data.userId)) {
                            this.userSockets.set(data.userId, new Set());
                        }
                        this.userSockets.get(data.userId)!.add(ws);

                        ws.send(JSON.stringify({ type: "auth:success", sessionId: session.id }));
                    }
                    break;

                default:
                    // Echo unknown messages back for debugging
                    if (data.echo) {
                        ws.send(JSON.stringify({ type: "echo", data: data }));
                    }
            }
        } catch (err) {
            console.error("WebSocket message error:", err);
        }
    }

    async webSocketClose(ws: WebSocket, code: number, _reason: string): Promise<void> {
        const session = this.sessions.get(ws);
        if (session) {
            // Remove from user tracking
            if (session.userId) {
                const userSet = this.userSockets.get(session.userId);
                if (userSet) {
                    userSet.delete(ws);
                    if (userSet.size === 0) {
                        this.userSockets.delete(session.userId);
                    }
                }
            }
            this.sessions.delete(ws);
        }
        console.log(`WebSocket closed: ${code}`);
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        console.error("WebSocket error:", error);
        this.webSocketClose(ws, 1006, "error");
    }

    private async handleBroadcast(request: Request): Promise<Response> {
        try {
            const body = await request.json() as { message: unknown };
            const message = JSON.stringify(body.message);

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
        } catch (err) {
            return Response.json({ error: "Invalid request" }, { status: 400 });
        }
    }

    private async handleSendToUser(request: Request): Promise<Response> {
        try {
            const body = await request.json() as { userId: string; message: unknown };
            const { userId, message } = body;

            const userSet = this.userSockets.get(userId);
            if (!userSet || userSet.size === 0) {
                return Response.json({ success: false, error: "User not connected" }, { status: 404 });
            }

            const messageStr = JSON.stringify(message);
            let sent = 0;
            for (const ws of userSet) {
                try {
                    ws.send(messageStr);
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

    private handleStats(): Response {
        return Response.json({
            totalConnections: this.sessions.size,
            uniqueUsers: this.userSockets.size,
        });
    }
}
