#!/usr/bin/env node
/**
 * Load test: 10:1 read/write mix against a running instance, using autocannon.
 *
 *   node scripts/load-test.mjs [--url http://localhost:3000] [--connections 100] [--duration 30]
 *
 * Seeds N links, then every connection cycles 10 redirects (GET /{code}) and 1 create
 * (POST /v1/urls). Fails (exit 1) if p99 latency exceeds the 50ms target, any request
 * errors, or any status other than 302/201 comes back.
 * Run the server with RATE_LIMIT_ENABLED=false, or every client IP is throttled.
 */
import autocannon from 'autocannon';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.TARGET_URL ?? 'http://localhost:3000' },
    connections: { type: 'string', default: '100' },
    duration: { type: 'string', default: '30' },
    seed: { type: 'string', default: '200' },
    'p99-target': { type: 'string', default: '50' },
  },
});

const base = values.url.replace(/\/$/, '');
const connections = Number(values.connections);
const duration = Number(values.duration);
const p99Target = Number(values['p99-target']);
const READS_PER_WRITE = 10;

async function seed(count) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const res = await fetch(`${base}/v1/urls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ longUrl: `https://example.com/seed/${i}` }),
    });
    if (res.status !== 201) {
      throw new Error(`seeding failed: HTTP ${res.status} ${await res.text()}`);
    }
    codes.push((await res.json()).shortCode);
  }
  return codes;
}

console.log(`Seeding ${values.seed} links on ${base} …`);
const codes = await seed(Number(values.seed));
let next = 0;

// Every connection cycles through 10 redirects then 1 create: an exact 10:1 read/write mix.
const redirect = {
  method: 'GET',
  setupRequest: (req) => ({ ...req, path: `/${codes[next++ % codes.length]}` }),
};
const create = {
  method: 'POST',
  path: '/v1/urls',
  headers: { 'content-type': 'application/json' },
  setupRequest: (req) => ({
    ...req,
    body: JSON.stringify({ longUrl: `https://example.com/load/${Date.now()}/${Math.random()}` }),
  }),
};

console.log(`Running ${duration}s with ${connections} connections (${READS_PER_WRITE}:1 GET /{code} : POST /v1/urls)`);

const result = await new Promise((resolve, reject) => {
  autocannon(
    {
      url: base,
      connections,
      duration,
      requests: [...Array(READS_PER_WRITE).fill(redirect), create],
    },
    (error, res) => (error ? reject(error) : resolve(res)),
  );
});

const statuses = Object.fromEntries(
  Object.entries(result.statusCodeStats ?? {}).map(([code, stat]) => [code, stat.count]),
);

console.table([
  {
    'req/s': Math.round(result.requests.average),
    'p50 ms': result.latency.p50,
    'p90 ms': result.latency.p90,
    'p99 ms': result.latency.p99,
    'max ms': result.latency.max,
    requests: result.requests.total,
    errors: result.errors + result.timeouts,
  },
]);
console.log('status codes:', statuses);

const unexpected = Object.keys(statuses).filter((code) => code !== '302' && code !== '201');
const failures = [];
if (result.latency.p99 > p99Target) failures.push(`p99 ${result.latency.p99}ms > ${p99Target}ms`);
if (result.errors + result.timeouts > 0) failures.push(`${result.errors + result.timeouts} errors/timeouts`);
if (unexpected.length > 0) failures.push(`unexpected status codes: ${unexpected.join(', ')}`);

if (failures.length > 0) {
  console.error(`FAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`PASS: p99 ${result.latency.p99}ms ≤ ${p99Target}ms across the mixed workload`);
