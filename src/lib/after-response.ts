/**
 * 响应后的后台任务（通知等 fire-and-forget 副作用）。
 *
 * 在请求作用域内交给 next/server 的 after()：serverless 运行时会等它跑完再回收实例，不会被截断；
 * 请求作用域外（单测、脚本）after() 会同步抛错，此时退化为直接 fire-and-forget。
 * 两条路径都兜底记录任务的同步异常与拒绝，绝不向调用方冒泡。
 */
import { after } from 'next/server';

export function runAfterResponse(task: () => Promise<unknown> | unknown): void {
  const safeTask = () => Promise.resolve().then(task).catch((err) => console.error('[after-response] task failed', err));
  try {
    after(safeTask);
  } catch {
    void safeTask();
  }
}
