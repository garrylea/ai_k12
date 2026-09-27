import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { probeServer } = require('./probe-server.js');

/** 用例里起的 server，afterEach 统一关闭。 */
const servers = [];

/** 起一个监听随机端口的本地 server，返回它的 base url。 */
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
});

describe('probeServer', () => {
  it('服务器在（200）→ true', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    expect(await probeServer(url, 1000)).toBe(true);
  });

  it('404 也算可达 → true（要判断的是「连不连得上」，不是「路径对不对」）', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    expect(await probeServer(url, 1000)).toBe(true);
  });

  it('500 也算可达 → true', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    expect(await probeServer(url, 1000)).toBe(true);
  });

  it('端口没人监听 → false', async () => {
    const server = http.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    expect(await probeServer(`http://127.0.0.1:${port}`, 1000)).toBe(false);
  });

  it('URL 不可解析 → false', async () => {
    expect(await probeServer('not a url', 1000)).toBe(false);
  });

  it('连上了但永不响应 + 短超时 → false', async () => {
    const url = await listen(() => {
      /* 故意不响应 */
    });
    expect(await probeServer(url, 300)).toBe(false);
  });

  it('timeoutMs 非法（0）→ 退化为默认值，不会永不 settle', async () => {
    // 关键：服务器**接受连接但永不响应** —— 只有「超时确实生效」这次探测才会 settle。
    // 若把 0 原样传给 socket.setTimeout（Node 里 0 = 不超时），本用例会挂死到 vitest 超时。
    // 退化后的默认超时是 3000ms，故给用例留 8s 上限。
    const url = await listen(() => {
      /* 故意不响应 */
    });
    await expect(probeServer(url, 0)).resolves.toBe(false);
  }, 8000);
});
