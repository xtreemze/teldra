/**
 * Deterministic canvas touch-gesture recognizer.
 * It has no DOM or IFC dependencies: Babylon retains orbit/pan/pinch ownership,
 * while three-contact history, two taps and long press are mutually exclusive.
 */
export interface CanvasTouchPoint {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly time: number;
  readonly pointerType?: "touch" | "pen";
}
export type CanvasGestureIntent =
  | {readonly type: "longpress" | "doubletap"; readonly x: number; readonly y: number}
  | {readonly type: "undo" | "redo"};

interface Contact {
  readonly startX: number;
  readonly startY: number;
  readonly startedAt: number;
  readonly pointerType: "touch" | "pen";
  x: number;
  y: number;
}
type Session = "single" | "multi" | "three" | "blocked" | "held" | null;
interface RecentTap { readonly x: number; readonly y: number; readonly time: number; readonly pointerType: "touch" | "pen" }
const MOVE_TOLERANCE = 10;
const HOLD_MS = 480;
const DOUBLE_TAP_MS = 320;
const SWIPE_MS = 850;
const SWIPE_X = 80;
const SWIPE_Y = 45;

export class CanvasGestureArbiter {
  private readonly contacts = new Map<number, Contact>();
  private session: Session = null;
  private recentTap: RecentTap | null = null;
  private historyDirection: "undo" | "redo" | null = null;
  private suppressUntil = 0;

  get activeContacts(): number { return this.contacts.size; }

  down(p: CanvasTouchPoint): void {
    if (this.contacts.has(p.pointerId)) { this.abort(p.time); return; }
    if (!this.contacts.size) {
      this.session = "single";
      this.historyDirection = null;
    }
    const pointerType = p.pointerType ?? "touch";
    const mixed = [...this.contacts.values()].some(c => c.pointerType !== pointerType);
    this.contacts.set(p.pointerId, {
      startX: p.x, startY: p.y, x: p.x, y: p.y, startedAt: p.time, pointerType,
    });
    if (mixed) {
      this.session = "blocked";
      this.recentTap = null;
      this.historyDirection = null;
      this.suppressUntil = Math.max(this.suppressUntil, p.time + 500);
      return;
    }
    if (this.contacts.size === 2) {
      this.session = "multi";
      this.recentTap = null;
      this.suppressUntil = Math.max(this.suppressUntil, p.time + 500);
    } else if (this.contacts.size === 3) {
      const contacts = [...this.contacts.values()];
      const first = Math.min(...contacts.map(c => c.startedAt));
      const stationary = contacts.every(c => Math.hypot(c.x - c.startX, c.y - c.startY) <= 14);
      this.session = contacts.every(c => c.pointerType === "touch") && stationary && p.time - first <= 280 ? "three" : "blocked";
      this.historyDirection = null;
      this.suppressUntil = Math.max(this.suppressUntil, p.time + 700);
    } else if (this.contacts.size > 3) {
      this.session = "blocked";
      this.historyDirection = null;
      this.suppressUntil = Math.max(this.suppressUntil, p.time + 700);
    }
  }

  move(p: CanvasTouchPoint): {readonly blockCamera: boolean; readonly cancelHold: boolean} {
    const c = this.contacts.get(p.pointerId);
    if (!c) return {blockCamera: false, cancelHold: false};
    c.x = p.x; c.y = p.y;
    const moved = Math.hypot(c.x - c.startX, c.y - c.startY) > MOVE_TOLERANCE;
    if (this.session === "single" && moved) {
      this.session = "blocked";
      this.recentTap = null;
      return {blockCamera: false, cancelHold: true};
    }
    if (this.contacts.size >= 3) {
      if (this.session === "three") {
        const all = [...this.contacts.values()];
        const dx = all.reduce((sum, v) => sum + v.x - v.startX, 0) / 3;
        const dy = all.reduce((sum, v) => sum + v.y - v.startY, 0) / 3;
        const youngest = Math.max(...all.map(v => v.startedAt));
        const consistent = all.every(v => Math.abs(v.x - v.startX) >= 55 &&
          Math.sign(v.x - v.startX) === Math.sign(dx));
        if (p.time - youngest <= SWIPE_MS && Math.abs(dx) >= SWIPE_X &&
          Math.abs(dy) <= SWIPE_Y && Math.abs(dx) > 1.6 * Math.abs(dy) && consistent) {
          this.historyDirection = dx < 0 ? "undo" : "redo";
        } else {
          // A reversed, vertical or dispersed swipe loses its candidate.
          // Do not commit a command based on an earlier transient direction.
          this.historyDirection = null;
        }
      }
      return {blockCamera: true, cancelHold: true};
    }
    return {blockCamera: false, cancelHold: this.session !== "single"};
  }

  hold(now: number): CanvasGestureIntent | null {
    if (this.session !== "single" || this.contacts.size !== 1) return null;
    const c = [...this.contacts.values()][0]!;
    if (now - c.startedAt < HOLD_MS ||
      Math.hypot(c.x - c.startX, c.y - c.startY) > MOVE_TOLERANCE) return null;
    this.session = "held";
    this.recentTap = null;
    this.suppressUntil = Math.max(this.suppressUntil, now + 800);
    return {type: "longpress", x: c.x, y: c.y};
  }

  up(p: CanvasTouchPoint): CanvasGestureIntent | null {
    const c = this.contacts.get(p.pointerId);
    if (!c) return null;
    c.x = p.x; c.y = p.y;
    let intent: CanvasGestureIntent | null = null;
    if (this.session === "three" && this.contacts.size === 3) {
      // Re-evaluate the *release* positions before accepting history.
      this.move(p);
    }
    if (this.session === "three" && this.contacts.size === 3 && this.historyDirection) {
      intent = {type: this.historyDirection};
      this.session = "blocked";
      this.suppressUntil = Math.max(this.suppressUntil, p.time + 500);
    } else if (this.session === "single" && this.contacts.size === 1 &&
      p.time - c.startedAt <= 300 &&
      Math.hypot(c.x - c.startX, c.y - c.startY) <= MOVE_TOLERANCE) {
      const last = this.recentTap;
      if (last && last.pointerType === c.pointerType && p.time - last.time <= DOUBLE_TAP_MS &&
        Math.hypot(p.x - last.x, p.y - last.y) <= 28) {
        intent = {type: "doubletap", x: p.x, y: p.y};
        this.recentTap = null;
        this.suppressUntil = Math.max(this.suppressUntil, p.time + 350);
      } else {
        this.recentTap = {x: p.x, y: p.y, time: p.time, pointerType: c.pointerType};
      }
    }
    if (this.session !== "single") {
      this.recentTap = null;
      this.suppressUntil = Math.max(this.suppressUntil, p.time + 350);
    }
    this.contacts.delete(p.pointerId);
    if (!this.contacts.size) {
      this.session = null;
      this.historyDirection = null;
    } else if (this.session !== "three") {
      this.session = "blocked";
    }
    return intent;
  }

  /** A cancelled, interrupted or lost pointer cannot produce any command. */
  abort(now: number): void {
    this.contacts.clear();
    this.session = null;
    this.recentTap = null;
    this.historyDirection = null;
    this.suppressUntil = Math.max(this.suppressUntil, now + 400);
  }

  /** Swallowed only for touch-generated clicks after gesture ownership changed. */
  suppressClick(now: number): boolean {
    return now <= this.suppressUntil;
  }
}
