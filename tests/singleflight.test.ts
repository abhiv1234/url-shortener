import { describe, expect, it } from 'vitest';
import { Singleflight } from '../src/cache/singleflight.js';

describe('Singleflight', () => {
  it('runs the leader path when the lock is acquired', async () => {
    const redis = {
      async set() {
        return 'OK';
      },
      async eval() {
        return 1;
      },
    };

    const singleflight = new Singleflight(redis);
    const result = await singleflight.run(
      'abc',
      async () => 'leader',
      async () => 'waiter',
      async () => 'timeout',
    );

    expect(result).toBe('leader');
  });

  it('waits for the waiter path when the lock is held', async () => {
    let waitCalls = 0;
    const redis = {
      async set() {
        return null;
      },
      async eval() {
        return 1;
      },
    };

    const singleflight = new Singleflight(redis, 10, 100);
    const result = await singleflight.run(
      'abc',
      async () => 'leader',
      async () => {
        waitCalls += 1;
        return waitCalls >= 2 ? 'waiter' : null;
      },
      async () => 'timeout',
    );

    expect(result).toBe('waiter');
    expect(waitCalls).toBeGreaterThanOrEqual(2);
  });

  it('falls through to timeout after waiting expires', async () => {
    const redis = {
      async set() {
        return null;
      },
      async eval() {
        return 1;
      },
    };

    const singleflight = new Singleflight(redis, 10, 30);
    const result = await singleflight.run(
      'abc',
      async () => 'leader',
      async () => null,
      async () => 'timeout',
    );

    expect(result).toBe('timeout');
  });

  it('releases only its own lock token', async () => {
    let storedToken: string | undefined;
    const evalCalls: string[][] = [];
    const redis = {
      async set(_key: string, value: string) {
        storedToken = value;
        return 'OK';
      },
      async eval(_script: string, _numKeys: number, ...args: string[]) {
        evalCalls.push(args);
        return 1;
      },
    };

    const singleflight = new Singleflight(redis);
    await singleflight.run('abc', async () => 'leader', async () => null, async () => 'timeout');

    expect(evalCalls).toEqual([['sf:abc', storedToken]]);
  });

  it('does not let a failed lock release mask the leader result', async () => {
    const redis = {
      async set() {
        return 'OK';
      },
      async eval(): Promise<unknown> {
        throw new Error('redis down');
      },
    };

    const singleflight = new Singleflight(redis);
    const result = await singleflight.run(
      'abc',
      async () => 'leader',
      async () => null,
      async () => 'timeout',
    );

    expect(result).toBe('leader');
  });

  it('falls straight through to the source when the lock cannot be acquired', async () => {
    const redis = {
      async set(): Promise<string | null> {
        throw new Error('redis down');
      },
      async eval() {
        return 1;
      },
    };

    const singleflight = new Singleflight(redis);
    const result = await singleflight.run(
      'abc',
      async () => 'leader',
      async () => null,
      async () => 'timeout',
    );

    expect(result).toBe('timeout');
  });
});
