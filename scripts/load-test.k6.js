// k6 version of the load test (https://k6.io):
//   k6 run -e BASE_URL=http://localhost:3000 scripts/load-test.k6.js
// 100 VUs, 90% GET /{code} and 10% POST /v1/urls; fails if redirect p99 >= 50ms.
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    mixed: { executor: 'constant-vus', vus: 100, duration: __ENV.DURATION || '30s' },
  },
  thresholds: {
    'http_req_duration{name:redirect}': ['p(99)<50'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const codes = [];
  for (let i = 0; i < 200; i += 1) {
    const res = http.post(`${BASE_URL}/v1/urls`, JSON.stringify({ longUrl: `https://example.com/seed/${i}` }), {
      headers: { 'Content-Type': 'application/json' },
    });
    codes.push(res.json('shortCode'));
  }
  return { codes };
}

export default function (data) {
  if (Math.random() < 0.9) {
    const code = data.codes[Math.floor(Math.random() * data.codes.length)];
    const res = http.get(`${BASE_URL}/${code}`, { redirects: 0, tags: { name: 'redirect' } });
    check(res, { 'redirect is 302': (r) => r.status === 302 });
  } else {
    const res = http.post(
      `${BASE_URL}/v1/urls`,
      JSON.stringify({ longUrl: `https://example.com/k6/${__VU}/${__ITER}` }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'create' } },
    );
    check(res, { 'create is 201': (r) => r.status === 201 });
  }
}
