// 假语言服务器（仅供 lsp-gateway-e2e 测试）：收到第一条消息后，
// 1) 把一条含中文的消息切成两次 stdout 写入，切点落在多字节字符中间；
// 2) 紧接着在同一次写入里再拼一条消息（工作目录与 HOME）。
const frame = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};
let replied = false;
process.stdin.on('data', () => {
  if (replied) return;
  replied = true;
  const zh = frame({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: '模块 已加载：规则 计算' } });
  const env = frame({ jsonrpc: '2.0', method: 'test/env', params: { cwd: process.cwd(), home: process.env.HOME, pid: process.pid, execArgv: process.execArgv } });
  const cut = zh.indexOf(Buffer.from('载')) + 1;
  process.stdout.write(zh.subarray(0, cut));
  setTimeout(() => process.stdout.write(Buffer.concat([zh.subarray(cut), env])), 20);
});
const keepAlive = setInterval(() => {}, 1000);
// 与真实语言服务器一致：stdin 关闭（网关退出）即退出，避免成为孤儿进程
// ASTER_FAKE_STUBBORN=1（ASTER_* 会被网关转发给子进程）：忽略 stdin 关闭与 SIGTERM，
// 用来验证清理是按进程组 SIGKILL 的，而不是靠子进程自觉退出
if (process.env.ASTER_FAKE_STUBBORN === '1') {
  process.on('SIGTERM', () => {});
} else {
  process.stdin.on('end', () => { clearInterval(keepAlive); process.exit(0); });
}
