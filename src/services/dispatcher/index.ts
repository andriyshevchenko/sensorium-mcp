/**
 * Barrel re-export for the dispatcher subsystem.
 */

// Broker — message types & public API
export type { StoredReaction, StoredMessage } from "./broker.js";
export {
  readPendingReaction,
  readThreadMessages,
  peekThreadMessages,
  appendToThread,
  setBrokerDb,
  setBrokerSentMessageRepository,
  resolveThreadForTopic,
} from "./broker.js";

// Poller — startup entry point
export { startDispatcher } from "./poller.js";
