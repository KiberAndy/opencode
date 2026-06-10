import { describe, expect, test } from "bun:test"
import {
  autoscrollDirection,
  autoscrollSpeed,
  AUTOSCROLL_DEADZONE,
  AUTOSCROLL_SPEED_CAP,
} from "../../../../../tui/src/util/scroll-autoscroll"

describe("autoscrollSpeed", () => {
  describe("deadzone", () => {
    test("returns 0 for deltaY inside deadzone (|d| <= 1)", () => {
      expect(autoscrollSpeed(0)).toBe(0)
      expect(autoscrollSpeed(0.5)).toBe(0)
      expect(autoscrollSpeed(-0.5)).toBe(0)
      expect(autoscrollSpeed(1)).toBe(0)
      expect(autoscrollSpeed(-1)).toBe(0)
    })

    test("returns non-zero just outside deadzone", () => {
      expect(autoscrollSpeed(1.01)).toBeGreaterThan(0)
      expect(autoscrollSpeed(-1.01)).toBeLessThan(0)
    })
  })

  describe("sign", () => {
    test("positive speed for positive deltaY", () => {
      expect(autoscrollSpeed(2)).toBeGreaterThan(0)
      expect(autoscrollSpeed(10)).toBeGreaterThan(0)
    })

    test("negative speed for negative deltaY", () => {
      expect(autoscrollSpeed(-2)).toBeLessThan(0)
      expect(autoscrollSpeed(-10)).toBeLessThan(0)
    })

    test("is odd: f(-d) === -f(d)", () => {
      for (const d of [2, 5, 8, 12.5, 100]) {
        expect(autoscrollSpeed(-d)).toBeCloseTo(-autoscrollSpeed(d), 10)
      }
    })
  })

  describe("monotonicity in deadzone region", () => {
    test("speed grows with |deltaY| up to cap", () => {
      const s2 = Math.abs(autoscrollSpeed(2))
      const s3 = Math.abs(autoscrollSpeed(3))
      const s4 = Math.abs(autoscrollSpeed(4))
      const s5 = Math.abs(autoscrollSpeed(5))
      expect(s2).toBeLessThan(s3)
      expect(s3).toBeLessThan(s4)
      expect(s4).toBeLessThan(s5)
    })
  })

  describe("speed cap", () => {
    test("speed never exceeds AUTOSCROLL_SPEED_CAP", () => {
      for (const d of [5, 6, 10, 20, 50, 100, 1000, 10000]) {
        expect(Math.abs(autoscrollSpeed(d))).toBeLessThanOrEqual(AUTOSCROLL_SPEED_CAP)
        expect(Math.abs(autoscrollSpeed(-d))).toBeLessThanOrEqual(AUTOSCROLL_SPEED_CAP)
      }
    })

    test("speed equals cap at large enough deltaY", () => {
      expect(Math.abs(autoscrollSpeed(20))).toBe(AUTOSCROLL_SPEED_CAP)
      expect(Math.abs(autoscrollSpeed(100))).toBe(AUTOSCROLL_SPEED_CAP)
    })

    test("speed is below cap just before threshold (~d=5.87)", () => {
      expect(Math.abs(autoscrollSpeed(5))).toBeLessThan(AUTOSCROLL_SPEED_CAP)
    })

    test("speed hits cap right after threshold (~d=6)", () => {
      expect(Math.abs(autoscrollSpeed(6))).toBe(AUTOSCROLL_SPEED_CAP)
    })
  })

  describe("numerical stability", () => {
    test("no NaN or Infinity for extreme inputs", () => {
      expect(Number.isFinite(autoscrollSpeed(Number.MAX_SAFE_INTEGER))).toBe(true)
      expect(Number.isFinite(autoscrollSpeed(-Number.MAX_SAFE_INTEGER))).toBe(true)
    })

    test("no NaN for subnormal float inputs", () => {
      expect(Number.isNaN(autoscrollSpeed(Number.MIN_VALUE))).toBe(false)
    })
  })

  describe("known values", () => {
    test("d=2 -> ~0.985 cells/tick (un-capped formula value)", () => {
      expect(autoscrollSpeed(2)).toBeCloseTo(Math.pow(2, 1.3) * 0.4, 6)
    })

    test("d=5 -> ~3.24 cells/tick (just below cap)", () => {
      expect(autoscrollSpeed(5)).toBeCloseTo(Math.pow(5, 1.3) * 0.4, 6)
    })

    test("d=10 -> exactly at cap", () => {
      expect(autoscrollSpeed(10)).toBe(AUTOSCROLL_SPEED_CAP)
    })
  })
})

describe("autoscrollDirection", () => {
  test("returns 'none' inside deadzone", () => {
    expect(autoscrollDirection(0)).toBe("none")
    expect(autoscrollDirection(0.5)).toBe("none")
    expect(autoscrollDirection(-0.5)).toBe("none")
    expect(autoscrollDirection(1)).toBe("none")
    expect(autoscrollDirection(-1)).toBe("none")
  })

  test("returns 'down' for positive deltaY outside deadzone", () => {
    expect(autoscrollDirection(2)).toBe("down")
    expect(autoscrollDirection(20)).toBe("down")
  })

  test("returns 'up' for negative deltaY outside deadzone", () => {
    expect(autoscrollDirection(-2)).toBe("up")
    expect(autoscrollDirection(-20)).toBe("up")
  })
})

describe("integration: scroll simulation", () => {
  const TICK_MS = 16

  function simulate(initial: number, anchorY: number, ticks: number, mouseYAt: (tick: number) => number) {
    let scrollTop = initial
    for (let i = 0; i < ticks; i++) {
      const speed = autoscrollSpeed(mouseYAt(i) - anchorY)
      scrollTop += speed
    }
    return scrollTop
  }

  test("constant mouse 5 cells below anchor: scrolls down at ~3.24 cells/tick", () => {
    const speed = autoscrollSpeed(5)
    const result = simulate(0, 50, 60, () => 55)
    expect(result).toBeCloseTo(60 * speed, 6)
  })

  test("constant mouse at deadzone: no scroll", () => {
    const result = simulate(100, 50, 60, () => 50)
    expect(result).toBe(100)
  })

  test("constant mouse 1 cell above deadzone: scrolls up", () => {
    const result = simulate(0, 50, 60, () => 48)
    expect(result).toBeLessThan(0)
  })

  test("mouse returns to anchor: scroll stops, position stays where it was", () => {
    let scrollTop = 0
    scrollTop = simulate(scrollTop, 50, 30, () => 55) // scrolls down
    const afterScroll = scrollTop
    scrollTop = simulate(scrollTop, 50, 30, () => 50) // mouse at anchor
    expect(scrollTop).toBe(afterScroll) // no further movement
  })

  test("mouse crosses anchor: scroll reverses direction", () => {
    const afterDown = simulate(0, 50, 30, () => 60)
    const afterUp = simulate(afterDown, 50, 30, () => 40)
    expect(afterUp).toBeLessThan(afterDown) // went back up
  })

  test("large mouse distance: scroll capped, total per second is bounded", () => {
    const cellsPerSecond = (autoscrollSpeed(100) * 1000) / TICK_MS
    expect(cellsPerSecond).toBeLessThanOrEqual((AUTOSCROLL_SPEED_CAP * 1000) / TICK_MS)
  })

  test("deadzone boundary is exactly at |d| = 1", () => {
    expect(autoscrollSpeed(1 - 0.0001)).toBe(0)
    expect(autoscrollSpeed(1 + 0.0001)).toBeGreaterThan(0)
    expect(autoscrollSpeed(-(1 - 0.0001))).toBe(0)
    expect(autoscrollSpeed(-(1 + 0.0001))).toBeLessThan(0)
  })
})

describe("integration: AUTOSCROLL_DEADZONE contract", () => {
  test("matches the magic number 1 used in the component", () => {
    expect(AUTOSCROLL_DEADZONE).toBe(1)
  })

  test("matches the speed cap 4 used in the component", () => {
    expect(AUTOSCROLL_SPEED_CAP).toBe(4)
  })
})
