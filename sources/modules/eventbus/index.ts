/**
 * EventBus module exports.
 *
 * Provides pub/sub functionality for real-time event distribution.
 */

export { EventBus } from "./EventBus";
export type { EventType } from "./EventBus";

export { EventEmitter, createEventEmitter } from "./emitter";
export type { RecipientFilter, EmitOptions } from "./emitter";

export {
    // Types
    type UpdateEvent,
    type EphemeralEvent,
    type UpdatePayload,
    type EphemeralPayload,

    // Update event builders
    buildNewSessionUpdate,
    buildUpdateSessionUpdate,
    buildDeleteSessionUpdate,
    buildNewMessageUpdate,
    buildUpdateAccountUpdate,
    buildNewMachineUpdate,
    buildUpdateMachineUpdate,
    buildNewArtifactUpdate,
    buildUpdateArtifactUpdate,
    buildDeleteArtifactUpdate,
    buildRelationshipUpdatedEvent,
    buildNewFeedPostUpdate,
    buildKVBatchUpdateUpdate,

    // Ephemeral event builders
    buildSessionActivityEphemeral,
    buildMachineActivityEphemeral,
    buildUsageEphemeral,
    buildMachineStatusEphemeral,
} from "./events";
