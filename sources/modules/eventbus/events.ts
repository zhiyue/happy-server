/**
 * Event type definitions and builder functions for the EventBus.
 *
 * These match the event types from the original eventRouter.ts
 * and provide type-safe event construction for real-time updates.
 */

import * as privacyKit from "privacy-kit";

// ==================== Update Event Types ====================

export type UpdateEvent =
    | NewSessionEvent
    | UpdateSessionEvent
    | DeleteSessionEvent
    | NewMessageEvent
    | UpdateAccountEvent
    | NewMachineEvent
    | UpdateMachineEvent
    | NewArtifactEvent
    | UpdateArtifactEvent
    | DeleteArtifactEvent
    | RelationshipUpdatedEvent
    | NewFeedPostEvent
    | KVBatchUpdateEvent;

interface NewSessionEvent {
    t: "new-session";
    id: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
}

interface UpdateSessionEvent {
    t: "update-session";
    id: string;
    metadata?: { value: string | null; version: number };
    agentState?: { value: string | null; version: number };
}

interface DeleteSessionEvent {
    t: "delete-session";
    sid: string;
}

interface NewMessageEvent {
    t: "new-message";
    sid: string;
    message: {
        id: string;
        seq: number;
        content: unknown;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    };
}

interface UpdateAccountEvent {
    t: "update-account";
    id: string;
    settings?: { value: string | null; version: number };
    github?: {
        id: number;
        login: string;
        avatarUrl: string;
        name: string | null;
    } | null;
    avatar?: {
        path: string;
        url: string;
        width: number;
        height: number;
        thumbhash: string;
    };
}

interface NewMachineEvent {
    t: "new-machine";
    machineId: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
}

interface UpdateMachineEvent {
    t: "update-machine";
    machineId: string;
    metadata?: { value: string; version: number };
    daemonState?: { value: string; version: number };
    activeAt?: number;
}

interface NewArtifactEvent {
    t: "new-artifact";
    artifactId: string;
    seq: number;
    header: string;
    headerVersion: number;
    body: string;
    bodyVersion: number;
    dataEncryptionKey: string;
    createdAt: number;
    updatedAt: number;
}

interface UpdateArtifactEvent {
    t: "update-artifact";
    artifactId: string;
    header?: { value: string; version: number };
    body?: { value: string; version: number };
}

interface DeleteArtifactEvent {
    t: "delete-artifact";
    artifactId: string;
}

interface RelationshipUpdatedEvent {
    t: "relationship-updated";
    uid: string;
    status: "none" | "requested" | "pending" | "friend" | "rejected";
    timestamp: number;
}

interface NewFeedPostEvent {
    t: "new-feed-post";
    id: string;
    body: unknown;
    cursor: string;
    createdAt: number;
}

interface KVBatchUpdateEvent {
    t: "kv-batch-update";
    changes: Array<{
        key: string;
        value: string | null;
        version: number;
    }>;
}

// ==================== Ephemeral Event Types ====================

export type EphemeralEvent =
    | ActivityEvent
    | MachineActivityEvent
    | UsageEvent
    | MachineStatusEvent;

interface ActivityEvent {
    type: "activity";
    id: string;
    active: boolean;
    activeAt: number;
    thinking?: boolean;
}

interface MachineActivityEvent {
    type: "machine-activity";
    id: string;
    active: boolean;
    activeAt: number;
}

interface UsageEvent {
    type: "usage";
    id: string;
    key: string;
    tokens: Record<string, number>;
    cost: Record<string, number>;
    timestamp: number;
}

interface MachineStatusEvent {
    type: "machine-status";
    machineId: string;
    online: boolean;
    timestamp: number;
}

// ==================== Payload Types ====================

export interface UpdatePayload {
    id: string;
    seq: number;
    body: UpdateEvent;
    createdAt: number;
}

export interface EphemeralPayload {
    type: EphemeralEvent["type"];
    [key: string]: unknown;
}

// ==================== Builder Functions ====================

/**
 * Build a new-session update event.
 */
export function buildNewSessionUpdate(
    session: {
        id: string;
        seq: number;
        metadata: string;
        metadataVersion: number;
        agentState: string | null;
        agentStateVersion: number;
        dataEncryptionKey: Uint8Array | null;
        active: boolean;
        lastActiveAt: Date;
        createdAt: Date;
        updatedAt: Date;
    },
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "new-session",
            id: session.id,
            seq: session.seq,
            metadata: session.metadata,
            metadataVersion: session.metadataVersion,
            agentState: session.agentState,
            agentStateVersion: session.agentStateVersion,
            dataEncryptionKey: session.dataEncryptionKey
                ? privacyKit.encodeBase64(session.dataEncryptionKey)
                : null,
            active: session.active,
            activeAt: session.lastActiveAt.getTime(),
            createdAt: session.createdAt.getTime(),
            updatedAt: session.updatedAt.getTime(),
        },
        createdAt: Date.now(),
    };
}

/**
 * Build an update-session update event.
 */
export function buildUpdateSessionUpdate(
    sessionId: string,
    updateSeq: number,
    updateId: string,
    metadata?: { value: string; version: number },
    agentState?: { value: string; version: number }
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "update-session",
            id: sessionId,
            metadata,
            agentState,
        },
        createdAt: Date.now(),
    };
}

/**
 * Build a delete-session update event.
 */
export function buildDeleteSessionUpdate(
    sessionId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "delete-session",
            sid: sessionId,
        },
        createdAt: Date.now(),
    };
}

/**
 * Build a new-message update event.
 */
export function buildNewMessageUpdate(
    message: {
        id: string;
        seq: number;
        content: unknown;
        localId: string | null;
        createdAt: Date;
        updatedAt: Date;
    },
    sessionId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "new-message",
            sid: sessionId,
            message: {
                id: message.id,
                seq: message.seq,
                content: message.content,
                localId: message.localId,
                createdAt: message.createdAt.getTime(),
                updatedAt: message.updatedAt.getTime(),
            },
        },
        createdAt: Date.now(),
    };
}

/**
 * Build an update-account update event.
 */
export function buildUpdateAccountUpdate(
    userId: string,
    profile: {
        settings?: { value: string | null; version: number };
        github?: {
            id: number;
            login: string;
            avatarUrl: string;
            name: string | null;
        } | null;
        avatar?: {
            path: string;
            width: number;
            height: number;
            thumbhash: string;
        };
    },
    updateSeq: number,
    updateId: string,
    filesPublicUrl?: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "update-account",
            id: userId,
            settings: profile.settings,
            github: profile.github,
            avatar: profile.avatar
                ? {
                    ...profile.avatar,
                    url: filesPublicUrl
                        ? `${filesPublicUrl.replace(/\/$/, "")}/${profile.avatar.path}`
                        : profile.avatar.path,
                }
                : undefined,
        },
        createdAt: Date.now(),
    };
}

/**
 * Build a new-machine update event.
 */
export function buildNewMachineUpdate(
    machine: {
        id: string;
        seq: number;
        metadata: string;
        metadataVersion: number;
        daemonState: string | null;
        daemonStateVersion: number;
        dataEncryptionKey: Uint8Array | null;
        active: boolean;
        lastActiveAt: Date;
        createdAt: Date;
        updatedAt: Date;
    },
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "new-machine",
            machineId: machine.id,
            seq: machine.seq,
            metadata: machine.metadata,
            metadataVersion: machine.metadataVersion,
            daemonState: machine.daemonState,
            daemonStateVersion: machine.daemonStateVersion,
            dataEncryptionKey: machine.dataEncryptionKey
                ? privacyKit.encodeBase64(machine.dataEncryptionKey)
                : null,
            active: machine.active,
            activeAt: machine.lastActiveAt.getTime(),
            createdAt: machine.createdAt.getTime(),
            updatedAt: machine.updatedAt.getTime(),
        },
        createdAt: Date.now(),
    };
}

/**
 * Build an update-machine update event.
 */
export function buildUpdateMachineUpdate(
    machineId: string,
    updateSeq: number,
    updateId: string,
    metadata?: { value: string; version: number },
    daemonState?: { value: string; version: number }
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "update-machine",
            machineId,
            metadata,
            daemonState,
        },
        createdAt: Date.now(),
    };
}

/**
 * Build a new-artifact update event.
 */
export function buildNewArtifactUpdate(
    artifact: {
        id: string;
        seq: number;
        header: Uint8Array;
        headerVersion: number;
        body: Uint8Array;
        bodyVersion: number;
        dataEncryptionKey: Uint8Array;
        createdAt: Date;
        updatedAt: Date;
    },
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "new-artifact",
            artifactId: artifact.id,
            seq: artifact.seq,
            header: privacyKit.encodeBase64(artifact.header),
            headerVersion: artifact.headerVersion,
            body: privacyKit.encodeBase64(artifact.body),
            bodyVersion: artifact.bodyVersion,
            dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
            createdAt: artifact.createdAt.getTime(),
            updatedAt: artifact.updatedAt.getTime(),
        },
        createdAt: Date.now(),
    };
}

/**
 * Build an update-artifact update event.
 */
export function buildUpdateArtifactUpdate(
    artifactId: string,
    updateSeq: number,
    updateId: string,
    header?: { value: string; version: number },
    body?: { value: string; version: number }
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "update-artifact",
            artifactId,
            header,
            body,
        },
        createdAt: Date.now(),
    };
}

/**
 * Build a delete-artifact update event.
 */
export function buildDeleteArtifactUpdate(
    artifactId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "delete-artifact",
            artifactId,
        },
        createdAt: Date.now(),
    };
}

/**
 * Build a relationship-updated update event.
 */
export function buildRelationshipUpdatedEvent(
    data: {
        uid: string;
        status: "none" | "requested" | "pending" | "friend" | "rejected";
        timestamp: number;
    },
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "relationship-updated",
            ...data,
        },
        createdAt: Date.now(),
    };
}

/**
 * Build a new-feed-post update event.
 */
export function buildNewFeedPostUpdate(
    feedItem: {
        id: string;
        body: unknown;
        cursor: string;
        createdAt: number;
    },
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "new-feed-post",
            id: feedItem.id,
            body: feedItem.body,
            cursor: feedItem.cursor,
            createdAt: feedItem.createdAt,
        },
        createdAt: Date.now(),
    };
}

/**
 * Build a kv-batch-update update event.
 */
export function buildKVBatchUpdateUpdate(
    changes: Array<{ key: string; value: string | null; version: number }>,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "kv-batch-update",
            changes,
        },
        createdAt: Date.now(),
    };
}

// ==================== Ephemeral Event Builders ====================

/**
 * Build a session activity ephemeral event.
 */
export function buildSessionActivityEphemeral(
    sessionId: string,
    active: boolean,
    activeAt: number,
    thinking?: boolean
): EphemeralPayload {
    return {
        type: "activity",
        id: sessionId,
        active,
        activeAt,
        thinking: thinking || false,
    };
}

/**
 * Build a machine activity ephemeral event.
 */
export function buildMachineActivityEphemeral(
    machineId: string,
    active: boolean,
    activeAt: number
): EphemeralPayload {
    return {
        type: "machine-activity",
        id: machineId,
        active,
        activeAt,
    };
}

/**
 * Build a usage ephemeral event.
 */
export function buildUsageEphemeral(
    sessionId: string,
    key: string,
    tokens: Record<string, number>,
    cost: Record<string, number>
): EphemeralPayload {
    return {
        type: "usage",
        id: sessionId,
        key,
        tokens,
        cost,
        timestamp: Date.now(),
    };
}

/**
 * Build a machine status ephemeral event.
 */
export function buildMachineStatusEphemeral(
    machineId: string,
    online: boolean
): EphemeralPayload {
    return {
        type: "machine-status",
        machineId,
        online,
        timestamp: Date.now(),
    };
}
