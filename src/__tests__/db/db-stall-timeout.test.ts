// @vitest-environment node
// #842：经 Hyperdrive 的连接卡死时，查询必须在有限时间内以明确的错误失败，而不是把请求挂到被平台掐断。
//
// 用一个本地假 Postgres 服务端模拟两种卡死：
// - 「建连卡死」：接受 TCP 连接，但从不回应启动报文；
// - 「查询卡死」：完成启动握手（AuthenticationOk + ReadyForQuery），之后吞掉所有查询、永不回包。
// 不依赖真实数据库，测的是 createDb 实际配置出来的 pg 连接池行为，而不是源码文本。
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { createDb, DB_CONNECT_TIMEOUT_MS, DB_QUERY_TIMEOUT_MS } from '@/db';
import { firstRowOf, rowsOf } from '@/db/result';

type Mode = 'stall-on-connect' | 'stall-on-query' | 'stall-after-begin';

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

/** AuthenticationOk：'R' + int32 长度 8 + int32 0。 */
const AUTH_OK = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
/** ReadyForQuery：'Z' + int32 长度 5 + 状态 'I'（空闲）。 */
const READY_FOR_QUERY = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);

/** BEGIN 的应答：CommandComplete('BEGIN') + ReadyForQuery('T'，事务中)。 */
function beginReply(): Buffer {
  const tag = Buffer.from('BEGIN\0');
  const complete = Buffer.alloc(5);
  complete.write('C', 0);
  complete.writeInt32BE(4 + tag.length, 1);
  return Buffer.concat([complete, tag, Buffer.from([0x5a, 0, 0, 0, 5, 0x54])]);
}

async function startFakePostgres(mode: Mode): Promise<string> {
  // 整个服务端只应答一次 BEGIN：新建的连接上不会再有成功的查询。
  let answeredBegin = false;
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    let greeted = false;
    socket.on('data', (chunk: Buffer) => {
      if (mode === 'stall-on-connect') return;
      // 第一包是 StartupMessage（无 SSL）：完成握手。
      if (!greeted) {
        greeted = true;
        socket.write(Buffer.concat([AUTH_OK, READY_FOR_QUERY]));
        return;
      }
      // stall-after-begin：只应答第一条简单查询（drizzle 事务的 BEGIN），之后一律不回。
      if (mode === 'stall-after-begin' && !answeredBegin && chunk[0] === 0x51 /* 'Q' */) {
        answeredBegin = true;
        socket.write(beginReply());
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `postgres://u:p@127.0.0.1:${port}/stall_db`;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** 取 drizzle 包装错误里的驱动原始错误信息（drizzle 抛 "Failed query: …"，原始错误在 cause 上）。 */
function driverMessage(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } };
  return `${e.message ?? ''} | ${e.cause?.message ?? ''}`;
}

describe('createDb 卡死兜底超时（#842）', () => {
  it('生产超时取值：建连 10s、查询 30s', () => {
    expect(DB_CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(DB_QUERY_TIMEOUT_MS).toBe(30_000);
  });

  it('连接池实际带上了这两个超时与空闲回收', async () => {
    const url = await startFakePostgres('stall-on-query');
    const db = createDb({ HYPERDRIVE: { connectionString: url } });
    const options = (db.$client as unknown as { options: Record<string, unknown> }).options;
    expect(options.connectionTimeoutMillis).toBe(DB_CONNECT_TIMEOUT_MS);
    expect(options.query_timeout).toBe(DB_QUERY_TIMEOUT_MS);
    expect(options.idleTimeoutMillis).toBe(20_000);
    expect(options.max).toBe(1);
    await db.$client.end();
  });

  it('建连卡死：在连接超时内以明确错误失败', async () => {
    const url = await startFakePostgres('stall-on-connect');
    const db = createDb({ HYPERDRIVE: { connectionString: url } }, { connectTimeoutMs: 200 });
    const started = Date.now();
    const err = await db.execute(sql`SELECT 1`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(driverMessage(err)).toMatch(/timeout/i);
    expect(Date.now() - started).toBeLessThan(5_000);
    await db.$client.end();
  });

  it('查询卡死：在查询超时内以 "Query read timeout" 失败，而不是一直挂着', async () => {
    const url = await startFakePostgres('stall-on-query');
    const db = createDb({ HYPERDRIVE: { connectionString: url } }, { queryTimeoutMs: 200 });
    const started = Date.now();
    const err = await db.execute(sql`SELECT 1`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(driverMessage(err)).toContain('Query read timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
    await db.$client.end();
  });

  it('查询超时后出错的连接被移出池：下一条查询新建连接，同样有界失败', async () => {
    const url = await startFakePostgres('stall-on-query');
    const db = createDb({ HYPERDRIVE: { connectionString: url } }, { queryTimeoutMs: 150 });
    await expect(db.execute(sql`SELECT 1`)).rejects.toBeTruthy();
    await expect(db.execute(sql`SELECT 2`)).rejects.toBeTruthy();
    // max=1 的池里只留下新连接：卡住的那条没有被放回去复用。
    expect(sockets.length).toBe(2);
    await db.$client.end();
  });
});

describe('事务内卡死：连接被作废并让出池位（#842）', () => {
  // 池大小 1 + 很短的建连超时：若卡死的连接没有让出池位，下一条查询会以
  // "timeout exceeded when trying to connect" 失败；让出了则是新连接上的 "Query read timeout"。
  const options = { max: 1, queryTimeoutMs: 150, connectTimeoutMs: 400 };

  it('事务回调中的查询卡死：事务有界失败，后续查询拿到新连接', async () => {
    const url = await startFakePostgres('stall-after-begin');
    const db = createDb({ HYPERDRIVE: { connectionString: url } }, options);
    const started = Date.now();
    const txErr = await db.transaction(async (tx) => tx.execute(sql`SELECT 1`)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    // drizzle 用 rollback 的错误替换原始错误；作废后的连接让 rollback 也报查询读超时，原因不丢。
    expect(driverMessage(txErr)).toContain('Query read timeout');
    expect(driverMessage(txErr)).not.toMatch(/Client was closed|not queryable/);

    const err = await db.execute(sql`SELECT 2`).then(() => null, (e: unknown) => e);
    expect(driverMessage(err)).not.toMatch(/trying to connect|connection timeout/i);
    expect(sockets.length).toBe(2);
    await db.$client.end();
  });

  it('BEGIN 本身卡死（drizzle 此时不会 release）：池位同样被让出', async () => {
    const url = await startFakePostgres('stall-on-query');
    const db = createDb({ HYPERDRIVE: { connectionString: url } }, options);
    const txErr = await db.transaction(async (tx) => tx.execute(sql`SELECT 1`)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(driverMessage(txErr)).toContain('Query read timeout');

    const err = await db.execute(sql`SELECT 2`).then(() => null, (e: unknown) => e);
    expect(driverMessage(err)).toContain('Query read timeout');
    expect(sockets.length).toBe(2);
    await db.$client.end();
  });
});

describe('rowsOf / firstRowOf：execute 结果取行（#842）', () => {
  it('node-postgres 的 QueryResult：取 .rows', () => {
    const result = { rows: [{ id: 'a' }, { id: 'b' }], rowCount: 2 };
    expect(rowsOf<{ id: string }>(result)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(firstRowOf<{ id: string }>(result)).toEqual({ id: 'a' });
  });

  it('postgres-js 形态（行数组本身）：原样返回', () => {
    const result = [{ id: 'a' }];
    expect(rowsOf(result)).toBe(result);
  });

  it('没有行：空数组 / undefined', () => {
    expect(rowsOf({ rows: [] })).toEqual([]);
    expect(firstRowOf({ rows: [] })).toBeUndefined();
  });

  it('认不出的形态直接报错，不当成「没有行」', () => {
    expect(() => rowsOf({ count: 3 })).toThrow(/无法识别/);
    expect(() => rowsOf(undefined)).toThrow(/无法识别/);
  });
});
