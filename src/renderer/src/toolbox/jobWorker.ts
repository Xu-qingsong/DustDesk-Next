export class JobWorker {
  private worker?: Worker
  private reject?: (error: Error) => void
  private timer?: ReturnType<typeof setTimeout>
  constructor(private factory: () => Worker, private reuse = false) {}
  get reusable() { return !!this.worker && !this.reject }
  cancel() { clearTimeout(this.timer); this.worker?.terminate(); this.worker = undefined; this.reject?.(new Error('任务已取消')); this.reject = undefined }
  run<T>(data: unknown, timeout: number, transfer: Transferable[] = []): Promise<T> {
    if (!this.reuse || this.reject) this.cancel()
    return new Promise((resolve, reject) => {
      const worker = this.worker ?? this.factory(); this.worker = worker; this.reject = reject
      const finish = (failed = false) => { clearTimeout(this.timer); if (!this.reuse || failed) worker.terminate(); if (this.worker === worker) { if (!this.reuse || failed) this.worker = undefined; this.reject = undefined } }
      worker.onmessage = event => { finish(!!event.data.error); if (event.data.error) reject(Error(event.data.error)); else resolve(event.data.result) }
      worker.onerror = event => { finish(true); reject(Error(event.message || '处理失败')) }
      this.timer = setTimeout(() => { finish(true); reject(Error('处理超时，请缩小输入后重试')) }, timeout)
      try { worker.postMessage(data, transfer) } catch (error) { finish(true); reject(error) }
    })
  }
}
