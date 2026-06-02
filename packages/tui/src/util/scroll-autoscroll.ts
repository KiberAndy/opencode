const DEADZONE = 1
const SPEED_CAP = 4
const SPEED_EXPONENT = 1.3
const SPEED_COEFFICIENT = 0.4

export const AUTOSCROLL_DEADZONE = DEADZONE
export const AUTOSCROLL_SPEED_CAP = SPEED_CAP

export type AutoscrollDirection = "none" | "up" | "down"

export function autoscrollSpeed(deltaY: number): number {
  if (Math.abs(deltaY) <= DEADZONE) return 0
  const raw = Math.sign(deltaY) * Math.pow(Math.abs(deltaY), SPEED_EXPONENT) * SPEED_COEFFICIENT
  return Math.sign(raw) * Math.min(Math.abs(raw), SPEED_CAP)
}

export function autoscrollDirection(deltaY: number): AutoscrollDirection {
  if (Math.abs(deltaY) <= DEADZONE) return "none"
  return deltaY > 0 ? "down" : "up"
}
