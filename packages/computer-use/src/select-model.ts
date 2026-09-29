/**
 * Official `selectModel` always writes the chosen model as the global default.
 * A later `saveSelection` is queued behind that write, so the previous default is restored.
 * Those settings fields are volatile, so the write does not restart plugins.
 *
 * Calls are serialized across every copy of this module in the process, so the ball and `code_agent`
 * cannot interleave their select and restore steps. A short window still remains: official
 * `selectModel` has no session-only option, so another window that creates a session between the
 * official write and the restore sees the chosen model once.
 */

const QUEUE = Symbol.for('dsh-orb.select-model.queue')

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const holder = globalThis as { [QUEUE]?: Promise<unknown> }
  const run = (holder[QUEUE] ?? Promise.resolve()).then(task, task)
  holder[QUEUE] = run.catch(() => undefined)
  return run
}

export interface KeptModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface SelectModelKeepDefaultHost {
  readonly sessionController: {
    selectModel(request: KeptModelSelection & { readonly sessionId: string }): Promise<unknown>
  }
  readonly agentDefaultModel?: {
    currentSelection(): KeptModelSelection
    saveSelection(selection: KeptModelSelection): Promise<void>
  } | undefined
}

/** Apply a model to one session, then put the global default back if it changed. */
export function selectModelKeepDefault(
  ctx: SelectModelKeepDefaultHost,
  request: KeptModelSelection & { readonly sessionId: string },
): Promise<void> {
  return enqueue(() => selectAndRestore(ctx, request))
}

async function selectAndRestore(
  ctx: SelectModelKeepDefaultHost,
  request: KeptModelSelection & { readonly sessionId: string },
): Promise<void> {
  const defaults = ctx.agentDefaultModel
  const previous = defaults?.currentSelection()
  const chosen: KeptModelSelection = {
    provider: request.provider,
    model: request.model,
    ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
  }
  await ctx.sessionController.selectModel({ sessionId: request.sessionId, ...chosen })
  if (defaults === undefined) {
    console.error('dsh-orb: agentDefaultModel is missing; a session model may replace the global default')
    return
  }
  if (previous === undefined || sameSelection(previous, chosen)) return
  await defaults.saveSelection(previous)
  console.error('dsh-orb: restored the global default model after a session-only selection')
}

function sameSelection(left: KeptModelSelection, right: KeptModelSelection): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}
