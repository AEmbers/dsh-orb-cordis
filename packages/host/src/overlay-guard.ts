/**
 * Computer Use overlay cloak.
 * Capture stays on screencapture: the exclude list is always empty.
 * Clicks pass through the ball, and the observation frame is shown before the next capture.
 */

import { randomUUID } from 'node:crypto'

export const OVERLAY_GUARD_ACK_TIMEOUT_MS = 1_000
export const OVERLAY_GUARD_INPUT_DRAIN_MS = 80

export interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface OverlayGuardTransport {
  hasHelper(): boolean
  send(message: { id: string; type: string; [key: string]: unknown }, signal?: AbortSignal): Promise<void>
  setHidInput(active: boolean): void
  sleep?(ms: number): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

export function createOverlayGuard(transport: OverlayGuardTransport) {
  let inputDepth = 0
  const sleep = transport.sleep ?? delay

  return {
    async withCapture<T>(run: (session: { excludeWindowIds: readonly number[] }) => Promise<T>): Promise<T> {
      return run({ excludeWindowIds: [] })
    },

    async withInput<T>(run: () => Promise<T>): Promise<T> {
      inputDepth += 1
      const outer = inputDepth === 1
      const cloaked = outer && transport.hasHelper()
      try {
        if (outer) {
          transport.setHidInput(true)
          if (cloaked) await transport.send({ type: 'overlay-input', id: randomUUID(), active: true })
        }
        const value = await run()
        if (cloaked) await sleep(OVERLAY_GUARD_INPUT_DRAIN_MS)
        return value
      } finally {
        inputDepth -= 1
        if (inputDepth === 0) {
          try {
            if (cloaked) await transport.send({ type: 'overlay-input', id: randomUUID(), active: false })
          } finally {
            transport.setHidInput(false)
          }
        }
      }
    },

    async setObservationFrame(bounds: OverlayRect | null, signal?: AbortSignal): Promise<void> {
      if (!transport.hasHelper()) return
      if (bounds !== null && signal?.aborted) {
        await transport.send({ type: 'observation-frame', id: randomUUID(), bounds: null })
        return
      }
      try {
        await transport.send({ type: 'observation-frame', id: randomUUID(), bounds }, signal)
      } catch (error) {
        if (bounds !== null && signal?.aborted) {
          await transport.send({ type: 'observation-frame', id: randomUUID(), bounds: null })
          return
        }
        throw error
      }
    },
  }
}
