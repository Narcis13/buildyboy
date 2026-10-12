import type { SessionStatus } from '../../shared/types.ts';

/**
 * Session status machine. Given the current status and a hook event, returns the next status
 * (or the current one when the event doesn't change it).
 */
export function nextStatus(current: SessionStatus, event: string, payload: Record<string, unknown> = {}): SessionStatus {
  if (current === 'ended' && event !== 'SessionStart') return 'ended';
  // Subagent events never change the parent's top-level state, except that they prove it's working.
  switch (event) {
    case 'SessionStart':
      return 'idle';
    case 'UserPromptSubmit':
    case 'UserPromptExpansion':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PostToolBatch':
    case 'PermissionDenied':
    case 'SubagentStart':
    case 'SubagentStop':
    case 'PostCompact':
    case 'TaskCreated':
    case 'TaskCompleted':
      return 'working';
    case 'PermissionRequest':
    case 'Elicitation':
      return 'waiting';
    case 'Notification': {
      const t = String(payload.notification_type ?? '');
      if (t === 'permission_prompt' || t === 'agent_needs_input' || t.startsWith('elicitation')) return 'waiting';
      if (t === 'idle_prompt') return current === 'working' ? current : 'idle';
      return current;
    }
    case 'PreCompact':
      return 'compacting';
    case 'Stop':
      return 'idle';
    case 'StopFailure':
      return 'error';
    case 'SessionEnd':
      return 'ended';
    default:
      return current === 'stale' ? 'working' : current;
  }
}

export const STALE_AFTER_MS = 10 * 60 * 1000;

export function isStale(status: SessionStatus, lastEventAt: number, now = Date.now()): boolean {
  return status === 'working' && now - lastEventAt > STALE_AFTER_MS;
}
