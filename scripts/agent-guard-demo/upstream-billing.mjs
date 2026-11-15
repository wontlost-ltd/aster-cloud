#!/usr/bin/env node
/**
 * Agent 绕过演示的上游计费工具（aster-api#464 阶段 D）：stdio MCP 服务器，只由 aster-guard-mcp 作为子进程拉起
 * （--isolation network：stdio 子进程天然只接受代理的连接）。
 *
 * 工具：
 *   refund_payment { paymentId, amount, reason, approved? }   有副作用的退款（演示策略对它 DENY）
 *   lookup_payment { paymentId }                              只读查询（演示策略 ALLOW）
 *
 * 「工具到底有没有执行」的唯一证据：每次被调用都向 $DEMO_SIDE_EFFECTS 追加一行 JSON
 * `{ "at": ISO 时间, "tool": 工具名, "args": 收到的参数 }`。未设置该变量时拒绝启动，避免副作用无处可查。
 * 日志只写 stderr（stdout 是 MCP 通道）。
 */
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const sideEffectsFile = process.env.DEMO_SIDE_EFFECTS;
if (!sideEffectsFile) {
  process.stderr.write('[upstream-billing] 缺少 DEMO_SIDE_EFFECTS（副作用记录文件路径）\n');
  process.exit(2);
}

const TOOLS = [
  {
    name: 'refund_payment',
    description: '为一笔付款发起退款（有副作用）。',
    inputSchema: {
      type: 'object',
      properties: {
        paymentId: { type: 'string' },
        amount: { type: 'number' },
        reason: { type: 'string' },
        approved: { type: 'boolean', description: '调用方自称已获批准；工具不据此做任何判断' },
      },
      required: ['paymentId', 'amount', 'reason'],
    },
  },
  {
    name: 'lookup_payment',
    description: '查询一笔付款（只读）。',
    inputSchema: {
      type: 'object',
      properties: { paymentId: { type: 'string' } },
      required: ['paymentId'],
    },
  },
];

const HANDLERS = {
  refund_payment: (args) => `已为 ${args.paymentId} 退款 ${args.amount}`,
  lookup_payment: (args) => JSON.stringify({ paymentId: args.paymentId, amount: 5000, currency: 'NZD', status: 'settled' }),
};

const server = new Server({ name: 'agent-guard-demo-billing', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};
  const handler = HANDLERS[name];
  if (!handler) {
    return { isError: true, content: [{ type: 'text', text: `未知工具 ${name}` }] };
  }
  // 先落副作用记录再返回：记录存在即表示工具已执行。
  appendFileSync(sideEffectsFile, `${JSON.stringify({ at: new Date().toISOString(), tool: name, args })}\n`);
  return { content: [{ type: 'text', text: handler(args) }] };
});

await server.connect(new StdioServerTransport());
