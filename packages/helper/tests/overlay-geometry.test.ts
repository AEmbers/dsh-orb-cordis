import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OBSERVATION_FRAME_OUTSET,
  observationFramePlacement,
  pointInRect,
  selectionToolbarBounds,
  selectionToolbarMenuBounds,
  SELECTION_TOOLBAR_SIZE,
} from '../src/overlay-geometry.ts'

const work = { x: 0, y: 0, width: 1000, height: 800 }

describe('overlay geometry', () => {
  it('places the toolbar below the mouse-up point and clamps it to the work area', () => {
    assert.deepEqual(selectionToolbarBounds({ x: 100, y: 200 }, SELECTION_TOOLBAR_SIZE, work), {
      x: 100,
      y: 208,
      width: 280,
      height: 46,
    })
    const edge = selectionToolbarBounds({ x: 990, y: 790 }, SELECTION_TOOLBAR_SIZE, work)
    assert.equal(edge.x + edge.width <= work.width, true)
    assert.equal(edge.y + edge.height <= work.height, true)
    assert.equal(edge.x, 720)
  })

  it('grows the language menu down, and up when it would leave the work area', () => {
    const below = selectionToolbarMenuBounds({ x: 20, y: 40 }, { width: 280, height: 120 }, work)
    assert.equal(below.y, 40)
    assert.equal(below.height, 120)
    const above = selectionToolbarMenuBounds({ x: 20, y: 760 }, { width: 280, height: 120 }, work)
    assert.equal(above.y < 760, true)
    assert.equal(above.y + above.height <= work.height, true)
  })

  it('keeps the observation hole on the rectangle and clips a flush edge', () => {
    assert.equal(OBSERVATION_FRAME_OUTSET, 36)
    const placed = observationFramePlacement({ x: 100, y: 80, width: 200, height: 150 }, work)
    assert.deepEqual(placed.bounds, { x: 64, y: 44, width: 272, height: 222 })
    assert.deepEqual(placed.glow, { top: 28, right: 28, bottom: 28, left: 28 })
    assert.deepEqual(placed.stroke, { top: 8, right: 8, bottom: 8, left: 8 })
    const clipped = observationFramePlacement({ x: 0, y: 10, width: 40, height: 40 }, work)
    assert.equal(clipped.bounds.x, 0)
    assert.equal(clipped.glow.left, 0)
    assert.equal(clipped.stroke.left, 8)
    assert.equal(pointInRect({ x: 64, y: 44 }, placed.bounds), true)
    assert.equal(pointInRect({ x: 64 + 272, y: 44 }, placed.bounds), false)
  })
})
