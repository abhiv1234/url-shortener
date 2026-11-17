import { describe, expect, it } from 'vitest';
import { buildClickEvent, serializeClickEvent } from '../src/analytics/clickEvent.js';
import { ClickWriter, processClickMessages } from '../src/workers/clickWriter.js';

function fakeDb(rowCount: (params: unknown[][]) => number = (params) => params[0].length) {
  const calls: { sql: string; params: unknown[][] }[] = [];
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[][]) => {
        calls.push({ sql, params });
        return { rowCount: rowCount(params), rows: [] };
      },
    } as never,
  };
}

const event = (urlId: string) => buildClickEvent({ urlId, ip: '1.2.3.4', referrer: 'https://t.co', salt: 's' });

describe('ClickWriter', () => {
  it('inserts events column-wise with an idempotent, FK-safe statement', async () => {
    const { db, calls } = fakeDb();
    const events = [event('1'), event('2')];

    const written = await new ClickWriter(db).write(events);

    expect(written).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('unnest');
    expect(calls[0].sql).toContain('ON CONFLICT DO NOTHING');
    expect(calls[0].sql).toContain('WHERE EXISTS');
    expect(calls[0].params[0]).toEqual(events.map((e) => e.eventId));
    expect(calls[0].params[1]).toEqual(['1', '2']);
  });

  it('splits large batches into chunks', async () => {
    const { db, calls } = fakeDb();
    const events = Array.from({ length: 5 }, (_, i) => event(String(i + 1)));

    expect(await new ClickWriter(db, 2).write(events)).toBe(5);
    expect(calls.map((call) => call.params[0].length)).toEqual([2, 2, 1]);
  });

  it('reports only rows actually inserted (duplicates are skipped)', async () => {
    const { db } = fakeDb(() => 1);
    expect(await new ClickWriter(db).write([event('1'), event('1')])).toBe(1);
  });
});

describe('processClickMessages', () => {
  it('skips malformed messages and writes the valid ones', async () => {
    const written: unknown[] = [];
    const writer = {
      write: async (events: unknown[]) => {
        written.push(...events);
        return events.length;
      },
    };

    const result = await processClickMessages(
      [
        { value: Buffer.from(serializeClickEvent(event('5'))) },
        { value: Buffer.from('garbage') },
        { value: null },
      ],
      writer,
    );

    expect(result).toEqual({ written: 1, invalid: 2 });
    expect(written).toHaveLength(1);
  });

  it('does not touch the database for an all-invalid batch', async () => {
    let calls = 0;
    const result = await processClickMessages([{ value: Buffer.from('{}') }], {
      write: async () => {
        calls += 1;
        return 0;
      },
    });
    expect(result).toEqual({ written: 0, invalid: 1 });
    expect(calls).toBe(0);
  });
});
