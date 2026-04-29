import { randomUUID } from 'node:crypto';

interface TraceContext {
  traceId: string;
  spanStack: string[]; // stack of open span event IDs (subagent nesting)
}

/**
 * Manages hierarchical trace assignment for events.
 * Tracks active traces per session (by pid and sessionId).
 * Each user-prompt-submit creates a new trace root; subsequent
 * events within the same session are assigned to the active trace.
 */
export class TraceManager {
  private byPid = new Map<number, TraceContext>();
  private bySession = new Map<string, TraceContext>();

  /**
   * Assign traceId and parentId for an incoming event.
   * Call this before eventStore.add() to populate trace fields.
   */
  assignTrace(
    type: string,
    pid: number | null,
    sessionId: string | null,
  ): { traceId: string | null; parentId: string | null } {
    // Session lifecycle events have no trace
    if (type === 'session-start') {
      return { traceId: null, parentId: null };
    }
    if (type === 'session-end') {
      this._clearContext(pid, sessionId);
      return { traceId: null, parentId: null };
    }

    // user-prompt-submit creates a new trace root
    if (type === 'user-prompt-submit') {
      const traceId = randomUUID();
      const ctx: TraceContext = { traceId, spanStack: [] };
      this._setContext(pid, sessionId, ctx);
      return { traceId, parentId: null };
    }

    // All other events: look up active trace
    const ctx = this._getContext(pid, sessionId);
    if (!ctx) {
      return { traceId: null, parentId: null };
    }

    const parentId = ctx.spanStack.length > 0 ? ctx.spanStack[ctx.spanStack.length - 1]! : ctx.traceId;

    if (type === 'subagent-start') {
      // Will be assigned a parentId; the event's own ID will be pushed
      // onto the stack after eventStore.add() via pushSpan()
      return { traceId: ctx.traceId, parentId };
    }

    if (type === 'subagent-stop') {
      // Pop the stack (the subagent that just ended)
      if (ctx.spanStack.length > 0) {
        ctx.spanStack.pop();
      }
      return { traceId: ctx.traceId, parentId };
    }

    if (type === 'stop') {
      const traceId = ctx.traceId;
      this._clearContext(pid, sessionId);
      return { traceId, parentId: null };
    }

    // assistant-streaming is a direct child of the trace root
    if (type === 'assistant-streaming') {
      return { traceId: ctx.traceId, parentId: ctx.traceId };
    }

    // Default: child of current stack top (or trace root)
    return { traceId: ctx.traceId, parentId };
  }

  /**
   * After a subagent-start event is stored, push its event ID onto the span stack
   * so that subsequent events within the subagent are nested under it.
   */
  pushSpan(eventId: string, pid: number | null, sessionId: string | null): void {
    const ctx = this._getContext(pid, sessionId);
    if (ctx) {
      ctx.spanStack.push(eventId);
    }
  }

  // ── Internal context management ────────────────────────────

  private _getContext(pid: number | null, sessionId: string | null): TraceContext | undefined {
    if (pid != null) {
      const ctx = this.byPid.get(pid);
      if (ctx) return ctx;
    }
    if (sessionId) {
      return this.bySession.get(sessionId);
    }
    return undefined;
  }

  private _setContext(pid: number | null, sessionId: string | null, ctx: TraceContext): void {
    if (pid != null) this.byPid.set(pid, ctx);
    if (sessionId) this.bySession.set(sessionId, ctx);
  }

  private _clearContext(pid: number | null, sessionId: string | null): void {
    if (pid != null) this.byPid.delete(pid);
    if (sessionId) this.bySession.delete(sessionId);
  }
}
