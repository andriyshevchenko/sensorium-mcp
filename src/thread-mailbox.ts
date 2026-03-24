/**
 * In-memory inter-agent message queue.
 *
 * Allows agents on different Telegram threads to send short text messages
 * to each other without going through the operator.  Messages are drained
 * (consumed) by the recipient's next wait_for_instructions cycle.
 */

export interface ThreadMessage {
  fromThreadId: number;
  message: string;
  timestamp: string;
}

const inboxes = new Map<number, ThreadMessage[]>();

export function sendToThread(targetThreadId: number, fromThreadId: number, message: string): void {
  if (!inboxes.has(targetThreadId)) inboxes.set(targetThreadId, []);
  inboxes.get(targetThreadId)!.push({
    fromThreadId,
    message,
    timestamp: new Date().toISOString(),
  });
}

export function drainInbox(threadId: number): ThreadMessage[] {
  const messages = inboxes.get(threadId) || [];
  inboxes.delete(threadId);
  return messages;
}

export function peekInbox(threadId: number): ThreadMessage[] {
  return inboxes.get(threadId) || [];
}
