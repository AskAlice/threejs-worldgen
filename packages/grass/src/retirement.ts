/** Frames to wait before freeing a replaced tile geometry (see `Retirement.retire`). */
const RETIRE_AFTER_FRAMES = 60
/** Wall-clock equivalent used when a disposed field no longer gets update() calls. */
const RETIRE_AFTER_MS = RETIRE_AFTER_FRAMES * 16

/**
 * Delayed-free queue. Replaced tile geometries are freed a while later rather than immediately: WebGPU
 * builds render pipelines asynchronously, and one still in flight may read the old geometry. Freeing it
 * at once (which detaches the shared blade attributes) made that pipeline fail and the tile blink out.
 */
export class Retirement {
  private frame = 0
  private retired: { dispose: () => void; frame: number }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  /** Starts a new update frame; retired items are freed `RETIRE_AFTER_FRAMES` frames later. */
  beginFrame(): void {
    this.frame++
  }

  retire(dispose: () => void): void {
    this.retired.push({ dispose, frame: this.frame })
  }

  flush(all = false): void {
    while (this.retired.length && (all || this.frame - this.retired[0].frame > RETIRE_AFTER_FRAMES)) {
      this.retired.shift()!.dispose()
    }
  }

  /** Frees on a timer, for a field that no longer gets `update()` calls (i.e. after `dispose`). */
  schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush(true)
    }, RETIRE_AFTER_MS)
  }
}
