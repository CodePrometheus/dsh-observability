/**
 * The folding projection: rebuilds a span tree from the telemetry seam's flat
 * record stream.
 *
 * The seam hands over one record per captured session event. This state
 * machine folds them into spans keyed by `(session.id, turn, step)` — turn to
 * trace root, model step to a child span, tool call/result pair to a child of
 * its requesting step — and emits each span to a sink once its closing event
 * arrives. Identifiers are derived, never generated, and every timestamp comes
 * from the record's own `time`, so live capture and canonical-log replay of
 * the same events produce byte-identical trees.
 *
 * Seam contract facts this projection depends on:
 *
 * - `seq` gaps are routine and never a loss signal: only the first
 *   `assistant/chunk` of each step ships, as the stream-started signal.
 * - `severity` is pre-mapped at capture (`error` for a tool result's own
 *   `isError` and for `turn/end` error reasons), so error status is read, never
 *   re-derived from event semantics.
 * - Records may repeat after a cursor-less re-adoption. Derived identifiers
 *   make a repeat land on the same span rather than a second one.
 *
 * @module dsh-observability/projection
 */

import type { Attributes } from '@opentelemetry/api'
import type { TimedEvent } from '@opentelemetry/sdk-trace-base'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import { stepSpanIdFor, toolSpanIdFor, traceIdFor, turnSpanIdFor } from './ids.ts'
import type { SpanDraft } from './otel.ts'
import { hrTimeFromEpochMillis } from './otel.ts'
import { DSH, EXCEPTION, GEN_AI, SEAM_ATTR, applyRequestAttributes, serializePayload, usageAttributes } from './semconv.ts'

/**
 * Default serialized-payload ceiling per span attribute. A single tool result
 * can carry an entire file and OTLP imposes no per-attribute limit of its own;
 * the canonical session log keeps the full bytes either way.
 */
export const DEFAULT_MAX_ATTRIBUTE_CHARS = 32_768

/** Operation name for a span representing one model request. */
const OPERATION_CHAT = 'chat'

/** Operation name for a span representing one tool execution. */
const OPERATION_EXECUTE_TOOL = 'execute_tool'

/** Receives each span once its closing event arrives. */
export type SpanSink = (draft: SpanDraft) => void

/** Accumulating state of one model step's span. */
interface StepDraft {
  draft: SpanDraft
  /** Guards the time-to-first-chunk attribute against a replayed first chunk. */
  sawFirstChunk: boolean
}

/** Accumulating state of one turn's span, plus its open children. */
interface TurnDraft {
  draft: SpanDraft
  turn: number
  /** Steps between `step/start` and `step/end`, keyed by step ordinal. */
  steps: Map<number, StepDraft>
  /** Tool executions between `tool/call` and `tool/result`, keyed by model-issued call id. */
  tools: Map<string, SpanDraft>
  /** The step currently open, for events that name no step of their own. */
  currentStep?: StepDraft
}

/** Per-session projection state. */
interface SessionDraft {
  /** Time of the session's most recent record, stamped on a force-end sweep that has no record of its own. */
  lastRecordTime: number
  /** Latest `request/header` snapshot; names the model on step spans. */
  header?: SessionEventMap['request/header']['header']
  turn?: TurnDraft
}

/** Read a ledger record's body as the payload of its source event type. */
function bodyOf<T extends keyof SessionEventMap>(record: SessionTelemetryRecord): SessionEventMap[T] {
  return record.body as SessionEventMap[T]
}

/** Span status message for a failed turn; the routing code leads so alerting can group on it. */
function failureMessage(failure: LlmFailure): string {
  return `${failure.code}: ${failure.message}`
}

/**
 * Folds seam records into spans. One instance serves every session the backend
 * observes; per-session state is discarded when its turn closes or when
 * {@link endAll} sweeps.
 */
export class SessionSpanFolder {
  private readonly sessions = new Map<string, SessionDraft>()
  private readonly maxAttributeChars: number

  /**
   * @param sink - receives each completed span; called synchronously from {@link fold}.
   * @param options - projection tunables; `maxAttributeChars` defaults to {@link DEFAULT_MAX_ATTRIBUTE_CHARS}.
   */
  constructor(
    private readonly sink: SpanSink,
    options?: { maxAttributeChars?: number },
  ) {
    this.maxAttributeChars = options?.maxAttributeChars ?? DEFAULT_MAX_ATTRIBUTE_CHARS
  }

  /**
   * Fold one handed-over record into the span tree.
   *
   * Synchronous map work plus at most one sink call, so it satisfies the
   * seam's non-blocking `emit` contract.
   * @param record - the seam record, owned by this folder after handoff.
   */
  fold(record: SessionTelemetryRecord): void {
    const sessionId = String(record.attributes[SEAM_ATTR.sessionId])
    if (record.channel === 'ops') {
      this.foldOps(sessionId, record)
      return
    }
    const state = this.sessions.get(sessionId) ?? { lastRecordTime: record.time }
    state.lastRecordTime = record.time
    this.sessions.set(sessionId, state)
    const eventType = String(record.attributes[SEAM_ATTR.eventType])
    switch (eventType) {
      case 'turn/start':
        this.openTurn(sessionId, state, record)
        return
      case 'request/header':
        this.applyHeader(state, record)
        return
      case 'user/message':
        this.applyUserMessage(state, record)
        return
      case 'step/start':
        this.openStep(sessionId, state, record)
        return
      case 'assistant/chunk':
        this.applyFirstChunk(state, record)
        return
      case 'assistant/message':
        this.applyAssistantMessage(state, record)
        return
      case 'step/end':
        this.closeStep(state, record)
        return
      case 'tool/call':
        this.openTool(sessionId, state, record)
        return
      case 'tool/result':
        this.closeTool(state, record)
        return
      case 'turn/end':
        this.closeTurn(state, record)
        return
      default:
        // The event vocabulary is merge-extensible, so every type without a
        // span of its own — including plugin-merged types this package has
        // never heard of — becomes a point-in-time event on the innermost open
        // span. Dropping them would silently thin the timeline.
        this.addSpanEvent(state, eventType, record)
        return
    }
  }

  /**
   * Close every span still open, marking each as force-ended.
   *
   * Called at backend shutdown: a span left open would sit in this folder
   * until the process exits and never reach the exporter.
   * @param epochMillis - end time stamped on the swept spans.
   */
  endAll(epochMillis: number): void {
    for (const [sessionId, state] of this.sessions) {
      this.forceEndTurn(state, epochMillis)
      this.sessions.delete(sessionId)
    }
  }

  /**
   * Close one session's remaining spans and discard its state.
   *
   * On-demand capture produces no `shutdown` record, so a caller that knows a
   * session's capture is complete retires it here; otherwise the draft and its
   * last request header — the rendered system prompt and every tool schema —
   * stay retained until the process exits.
   * @param sessionId - the session to retire.
   */
  endSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    this.forceEndTurn(state, state.lastRecordTime)
    this.sessions.delete(sessionId)
  }

  /**
   * Serialize one payload onto a span or span-event attribute, marking a clip
   * out of band: the `…[clipped]` marker alone cannot distinguish a truncated
   * payload from one that genuinely ends in it.
   */
  private setPayload(attributes: Attributes, key: string, payload: unknown): void {
    const { text, clipped } = serializePayload(payload, this.maxAttributeChars)
    attributes[key] = text
    if (clipped) attributes[DSH.payloadClipped] = true
  }

  /** Open a turn's root span, or adopt the one a child already synthesized. */
  private openTurn(sessionId: string, state: SessionDraft, record: SessionTelemetryRecord): void {
    const { turn } = bodyOf<'turn/start'>(record)
    const open = this.ensureTurn(sessionId, state, turn, record)
    // Whichever record opened the span, this is the one it should carry: the
    // turn's own start time and log position, and no synthesized marker.
    delete open.draft.attributes[DSH.turnSynthesized]
    open.draft.startEpochMillis = record.time
    open.draft.attributes[DSH.eventSeq] = record.attributes[SEAM_ATTR.eventSeq]
  }

  /**
   * Return the open turn for one recorded turn ordinal, synthesizing its root
   * span when no matching turn is open.
   *
   * A `turn/start` can be missing — a crash window, or a record withheld by a
   * redaction rule. Children derive their identifiers from the ordinal in
   * their own record, so resolving them against a different open turn would
   * export them into a trace whose root never ships, leaving spans permanently
   * orphaned at the collector.
   */
  private ensureTurn(sessionId: string, state: SessionDraft, turn: number, record: SessionTelemetryRecord): TurnDraft {
    if (state.turn?.turn === turn) return state.turn
    // A still-open earlier turn means its turn/end never arrived either.
    if (state.turn !== undefined) this.forceEndTurn(state, record.time)
    const attributes: Attributes = {
      [DSH.sessionId]: sessionId,
      [DSH.turn]: turn,
      [DSH.eventSeq]: record.attributes[SEAM_ATTR.eventSeq],
      [DSH.turnSynthesized]: true,
    }
    // The seam's own header facts keep their spelling on the way out: they are
    // its identity attributes, not attributes this package invents.
    for (const key of [SEAM_ATTR.sessionCwd, SEAM_ATTR.sessionParentId, SEAM_ATTR.sessionSeedLength] as const) {
      const value = record.attributes[key]
      if (value !== undefined) attributes[key] = value
    }
    const opened: TurnDraft = {
      draft: {
        name: `turn ${turn}`,
        traceId: traceIdFor(sessionId, turn),
        spanId: turnSpanIdFor(sessionId, turn),
        startEpochMillis: record.time,
        endEpochMillis: record.time,
        attributes,
        events: [],
      },
      turn,
      steps: new Map(),
      tools: new Map(),
    }
    state.turn = opened
    return opened
  }

  /**
   * Store the header snapshot and stamp the model identity onto the open step.
   *
   * The header event is appended inside its own step, so the step span already
   * exists when it arrives; writing only the stored copy would leave the first
   * step of every conversation without a model attribute.
   */
  private applyHeader(state: SessionDraft, record: SessionTelemetryRecord): void {
    const { header } = bodyOf<'request/header'>(record)
    state.header = header
    const open = state.turn?.currentStep
    if (open === undefined) return
    applyRequestAttributes(open.draft.attributes, header.config)
  }

  /**
   * Record the turn's human prompt, and keep every other user-role message on
   * the timeline.
   *
   * One event type carries the claimed human prompt, `agent.inject()` context
   * (file-change notices, subdir AGENTS.md, skill content, …), and goal
   * continuation rounds; `source.kind` tells them apart. Letting a later
   * injection overwrite {@link DSH.turnInput} would export a file-change
   * notice as the turn's prompt, with nothing marking the substitution.
   */
  private applyUserMessage(state: SessionDraft, record: SessionTelemetryRecord): void {
    const turn = state.turn?.draft
    const { source } = bodyOf<'user/message'>(record)
    if (turn !== undefined && source.kind === 'user' && turn.attributes[DSH.turnInput] === undefined) {
      this.setPayload(turn.attributes, DSH.turnInput, record.body)
      return
    }
    this.addSpanEvent(state, 'user/message', record)
  }

  /** Open one model step's span as a child of its turn. */
  private openStep(sessionId: string, state: SessionDraft, record: SessionTelemetryRecord): void {
    const { turn, step } = bodyOf<'step/start'>(record)
    const open = this.ensureTurn(sessionId, state, turn, record)
    const attributes: Attributes = {
      [GEN_AI.operationName]: OPERATION_CHAT,
      [DSH.sessionId]: sessionId,
      [DSH.turn]: turn,
      [DSH.step]: step,
      [DSH.eventSeq]: record.attributes[SEAM_ATTR.eventSeq],
    }
    if (state.header !== undefined) applyRequestAttributes(attributes, state.header.config)
    const stepDraft: StepDraft = {
      draft: {
        name: `step ${step}`,
        traceId: traceIdFor(sessionId, turn),
        spanId: stepSpanIdFor(sessionId, turn, step),
        parentSpanId: turnSpanIdFor(sessionId, turn),
        startEpochMillis: record.time,
        endEpochMillis: record.time,
        attributes,
        events: [],
      },
      sawFirstChunk: false,
    }
    open.steps.set(step, stepDraft)
    open.currentStep = stepDraft
  }

  /** Record time-to-first-chunk from the step's one shipped chunk. */
  private applyFirstChunk(state: SessionDraft, record: SessionTelemetryRecord): void {
    const { step } = bodyOf<'assistant/chunk'>(record)
    const stepDraft = state.turn?.steps.get(step)
    if (stepDraft === undefined || stepDraft.sawFirstChunk) return
    stepDraft.sawFirstChunk = true
    stepDraft.draft.attributes[DSH.timeToFirstChunkMillis] = record.time - stepDraft.draft.startEpochMillis
  }

  /** Attach the assembled reply and its token usage to the step's span. */
  private applyAssistantMessage(state: SessionDraft, record: SessionTelemetryRecord): void {
    const { step, message, usage } = bodyOf<'assistant/message'>(record)
    const stepDraft = state.turn?.steps.get(step)
    if (stepDraft === undefined) return
    this.setPayload(stepDraft.draft.attributes, DSH.stepOutput, message)
    if (usage !== undefined) Object.assign(stepDraft.draft.attributes, usageAttributes(usage))
  }

  /** Close one step's span at its own end event. */
  private closeStep(state: SessionDraft, record: SessionTelemetryRecord): void {
    const { step } = bodyOf<'step/end'>(record)
    const turn = state.turn
    const stepDraft = turn?.steps.get(step)
    if (turn === undefined || stepDraft === undefined) return
    turn.steps.delete(step)
    if (turn.currentStep === stepDraft) delete turn.currentStep
    this.complete(stepDraft.draft, record.time)
  }

  /**
   * Open one tool execution's span.
   *
   * A step is one model request plus the tools it calls, so the tool span
   * nests under its requesting step. A call whose step is already closed
   * (possible only in a crash-window replay) falls back to the turn.
   */
  private openTool(sessionId: string, state: SessionDraft, record: SessionTelemetryRecord): void {
    const { turn, step, callId, name, arguments: args } = bodyOf<'tool/call'>(record)
    const open = this.ensureTurn(sessionId, state, turn, record)
    const id = String(callId)
    const parentSpanId = open.steps.has(step)
      ? stepSpanIdFor(sessionId, turn, step)
      : turnSpanIdFor(sessionId, turn)
    const attributes: Attributes = {
      [GEN_AI.operationName]: OPERATION_EXECUTE_TOOL,
      [GEN_AI.toolName]: name,
      [GEN_AI.toolCallId]: id,
      [DSH.sessionId]: sessionId,
      [DSH.turn]: turn,
      [DSH.step]: step,
      [DSH.eventSeq]: record.attributes[SEAM_ATTR.eventSeq],
    }
    this.setPayload(attributes, DSH.toolInput, args)
    open.tools.set(id, {
      name: `tool ${name}`,
      traceId: traceIdFor(sessionId, turn),
      spanId: toolSpanIdFor(sessionId, turn, step, id),
      parentSpanId,
      startEpochMillis: record.time,
      endEpochMillis: record.time,
      attributes,
      events: [],
    })
  }

  /**
   * Close one tool execution's span.
   *
   * The call id is read from the result message rather than a top-level field:
   * `tool/call` carries `callId` directly, `tool/result` carries it only
   * inside its message content.
   */
  private closeTool(state: SessionDraft, record: SessionTelemetryRecord): void {
    const { message, error } = bodyOf<'tool/result'>(record)
    const block = message.content[0]
    if (block === undefined) return
    const id = String(block.toolCallId)
    const draft = state.turn?.tools.get(id)
    if (draft === undefined) return
    state.turn?.tools.delete(id)
    this.setPayload(draft.attributes, DSH.toolOutput, block.content)
    if (record.severity === 'error') {
      draft.error = true
      // Code first, as on a failed turn: the status message's leading token is
      // what alerting groups on, and the code is the stable one. The failure
      // identity is optional — a tool can report a model-facing error without
      // one, leaving the status message to the result content.
      if (error !== undefined) draft.errorMessage = `${error.code}: ${error.name}`
    }
    this.complete(draft, record.time)
  }

  /** Close a turn's span at its own end event, after its children. */
  private closeTurn(state: SessionDraft, record: SessionTelemetryRecord): void {
    if (state.turn === undefined) return
    const { reason } = bodyOf<'turn/end'>(record)
    const draft = state.turn.draft
    draft.attributes[DSH.turnEndReason] = reason.kind
    if (record.severity === 'error') {
      draft.error = true
      if (reason.kind === 'error') draft.errorMessage = failureMessage(reason.error)
    }
    this.endTurn(state, record.time, false)
  }

  /**
   * Record one event type without a span of its own as a point-in-time event
   * on the innermost open span.
   */
  private addSpanEvent(state: SessionDraft, eventType: string, record: SessionTelemetryRecord): void {
    const host = state.turn?.currentStep?.draft ?? state.turn?.draft
    if (host === undefined) return
    host.events.push(this.spanEvent(eventType, record))
  }

  /** Build one span event from a record. */
  private spanEvent(name: string, record: SessionTelemetryRecord): TimedEvent {
    const attributes: Attributes = { [DSH.eventType]: name }
    this.setPayload(attributes, DSH.eventBody, record.body)
    const seq = record.attributes[SEAM_ATTR.eventSeq]
    if (seq !== undefined) attributes[DSH.eventSeq] = seq
    return { time: hrTimeFromEpochMillis(record.time), name, attributes }
  }

  /**
   * Fold one operational record.
   *
   * `agent-error` is the only path by which a thrown loop failure reaches the
   * trace: the session event types model no operational error. `shutdown`
   * marks the session's terminal edge and force-ends its turn. The seam owns
   * this op set and may extend it, so an unrecognized op becomes a span event
   * like an unrecognized ledger type — truncating the trace on one would
   * silently split every later span into a second turn.
   */
  private foldOps(sessionId: string, record: SessionTelemetryRecord): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    state.lastRecordTime = record.time
    const op = String(record.attributes[SEAM_ATTR.telemetryOp])
    if (op === 'agent-error') {
      this.applyAgentError(state, record)
      return
    }
    if (op !== 'shutdown') {
      this.addSpanEvent(state, op, record)
      return
    }
    this.forceEndTurn(state, record.time)
    this.sessions.delete(sessionId)
  }

  /**
   * Relay a thrown loop failure as a conventions-shaped exception event.
   *
   * The name `exception` alone renders an empty panel: receivers read the
   * failure from `exception.type` / `exception.message`, which the seam
   * supplies as the record's `error.name` attribute and its body message.
   */
  private applyAgentError(state: SessionDraft, record: SessionTelemetryRecord): void {
    const turn = state.turn
    if (turn === undefined) return
    const host = turn.currentStep?.draft ?? turn.draft
    const { message } = record.body as { message?: string }
    host.events.push({
      time: hrTimeFromEpochMillis(record.time),
      name: EXCEPTION.eventName,
      attributes: {
        [EXCEPTION.type]: record.attributes[SEAM_ATTR.errorName],
        [EXCEPTION.message]: message,
      },
    })
    host.error = true
    if (message !== undefined) host.errorMessage = message
    turn.draft.error = true
  }

  /** Close a turn and every child still open, marking them force-ended. */
  private forceEndTurn(state: SessionDraft, epochMillis: number): void {
    if (state.turn === undefined) return
    this.endTurn(state, epochMillis, true)
  }

  /**
   * Close a turn's remaining children, then the turn itself.
   *
   * Children complete first so a collector receiving them in arrival order
   * never sees a child whose parent already ended.
   */
  private endTurn(state: SessionDraft, epochMillis: number, forced: boolean): void {
    const turn = state.turn
    if (turn === undefined) return
    delete state.turn
    for (const draft of turn.tools.values()) {
      draft.attributes[DSH.forceEnded] = true
      this.complete(draft, epochMillis)
    }
    for (const stepDraft of turn.steps.values()) {
      stepDraft.draft.attributes[DSH.forceEnded] = true
      this.complete(stepDraft.draft, epochMillis)
    }
    if (forced) turn.draft.attributes[DSH.forceEnded] = true
    this.complete(turn.draft, epochMillis)
  }

  /** Stamp the end time and hand one finished span to the sink. */
  private complete(draft: SpanDraft, epochMillis: number): void {
    draft.endEpochMillis = epochMillis
    this.sink(draft)
  }
}
