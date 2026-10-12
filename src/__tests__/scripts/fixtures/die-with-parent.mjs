// 测试专用预加载（node --import）：父进程消失（被 SIGKILL、测试 worker 崩溃）时让网关自行退出。
// 发 SIGTERM 给自己而不是直接 exit：走网关自己的 shutdown（杀子进程、清理工作目录）。
const parent = process.ppid;
// 父进程已死时 stdout/stderr 管道对端已关闭，shutdown 的日志写入会 EPIPE；忽略即可
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => { if (error?.code !== 'EPIPE') throw error; });
}
const timer = setInterval(() => {
  if (process.ppid !== parent) {
    clearInterval(timer);
    process.kill(process.pid, 'SIGTERM');
    // shutdown 若卡住，兜底强退
    setTimeout(() => process.exit(1), 3000).unref();
  }
}, 200);
timer.unref();
