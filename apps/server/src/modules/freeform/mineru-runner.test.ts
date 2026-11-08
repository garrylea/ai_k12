import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { MineruRunner, FreeformMineruError, MineruLimiter } from './mineru-runner.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
  delete process.env.MINERU_TOKEN;
  delete process.env.MINERU_TIMEOUT_MS;
  delete process.env.MINERU_BIN;
});

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

it('按顺序传文件、设置 token、不带 shell', async () => {
  const child = fakeChild();
  spawnMock.mockReturnValue(child);
  process.env.MINERU_TOKEN = 'sk-test';
  const p = new MineruRunner().run(['/tmp/page_01.jpg', '/tmp/page_02.jpg'], '/tmp/out');
  child.emit('close', 0);
  await p;
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [bin, args, opts] = spawnMock.mock.calls[0];
  expect(bin).toBe(process.env.MINERU_BIN ?? 'mineru-open-api');
  expect(args).toEqual(expect.arrayContaining(['extract', '/tmp/page_01.jpg', '/tmp/page_02.jpg', '-o', '/tmp/out', '-f', 'md']));
  expect(opts.shell).toBe(false);
  expect(opts.env.MINERU_TOKEN).toBe('sk-test');
});

it('非 0 退出抛 FreeformMineruError，且 stderr 不含 token', async () => {
  const child = fakeChild();
  spawnMock.mockReturnValue(child);
  process.env.MINERU_TOKEN = 'sk-secret';
  const p = new MineruRunner().run(['/tmp/a.jpg'], '/tmp/out');
  child.stderr.emit('data', Buffer.from('401 sk-secret bad token'));
  child.emit('close', 1);
  await expect(p).rejects.toBeInstanceOf(FreeformMineruError);
  await p.catch((e) => expect(e.message).not.toContain('sk-secret'));
});

describe('MineruRunner 边界', () => {
  it('缺 MINERU_TOKEN 直接抛错且不 spawn', async () => {
    await expect(new MineruRunner().run(['/tmp/a.jpg'], '/tmp/out')).rejects.toBeInstanceOf(FreeformMineruError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('超时 SIGKILL 并拒绝，事后 abort 不再 kill', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    process.env.MINERU_TOKEN = 'sk-test';
    process.env.MINERU_TIMEOUT_MS = '100';
    const controller = new AbortController();
    const p = new MineruRunner().run(['/tmp/a.jpg'], '/tmp/out', controller.signal);
    const assertion = expect(p).rejects.toBeInstanceOf(FreeformMineruError);
    vi.advanceTimersByTime(100 + 5000);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.kill).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('signal 已 abort 时直接拒绝，不 spawn', async () => {
    process.env.MINERU_TOKEN = 'sk-test';
    const controller = new AbortController();
    controller.abort();
    await expect(new MineruRunner().run(['/tmp/a.jpg'], '/tmp/out', controller.signal)).rejects.toBeInstanceOf(
      FreeformMineruError,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('abort 时 kill 并拒绝', async () => {    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    process.env.MINERU_TOKEN = 'sk-test';
    const controller = new AbortController();
    const p = new MineruRunner().run(['/tmp/a.jpg'], '/tmp/out', controller.signal);
    const assertion = expect(p).rejects.toBeInstanceOf(FreeformMineruError);
    controller.abort();
    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', 0);
  });

  it('stderr 只保留最后 500 字符', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    process.env.MINERU_TOKEN = 'sk-test';
    const p = new MineruRunner().run(['/tmp/a.jpg'], '/tmp/out');
    child.stderr.emit('data', Buffer.from('x'.repeat(2000) + 'TAIL'));
    child.emit('close', 2);
    const err = (await p.catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(FreeformMineruError);
    expect(err.message).toContain('TAIL');
    const tail = err.message.split('：').slice(1).join('：');
    expect(tail.length).toBeLessThanOrEqual(500);
  });

  it('spawn 失败也转成 FreeformMineruError', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    process.env.MINERU_TOKEN = 'sk-test';
    const p = new MineruRunner().run(['/tmp/a.jpg'], '/tmp/out');
    child.emit('error', new Error('ENOENT spawn sk-test'));
    const err = (await p.catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(FreeformMineruError);
    expect(err.message).not.toContain('sk-test');
  });
});

describe('MineruLimiter', () => {
  it('限制并发数，超出的排队', async () => {
    const limiter = new MineruLimiter(2);
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const task = (id: number) =>
      limiter.run(async () => {
        started.push(id);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((r) => releases.push(r));
        running -= 1;
      });

    const ps = [task(1), task(2), task(3), task(4)];
    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    expect(releases).toHaveLength(2);

    releases.shift()!();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    releases.shift()!();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4]));

    releases.shift()!();
    releases.shift()!();
    await Promise.all(ps);
    expect(peak).toBe(2);
  });

  it('任务抛错也释放名额', async () => {
    const limiter = new MineruLimiter(1);
    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });
});
