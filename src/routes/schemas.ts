/** Shared JSON schemas: used for validation, response serialization and the OpenAPI docs. */

export const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    code: { type: 'string' },
  },
  required: ['error', 'code'],
} as const;

export const urlRecordSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', examples: ['125'] },
    shortCode: { type: 'string', examples: ['21'] },
    shortUrl: { type: 'string', examples: ['http://localhost:3000/21'] },
    longUrl: { type: 'string' },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['id', 'shortCode', 'shortUrl', 'longUrl', 'expiresAt'],
} as const;

export const bearerSecurity = [{ bearerAuth: [] }];

export function errors(...codes: number[]): Record<number, typeof errorSchema> {
  return Object.fromEntries(codes.map((code) => [code, errorSchema]));
}

export function rateLimitConfig(rule: { max: number; timeWindowMs: number }) {
  return { rateLimit: { max: rule.max, timeWindow: rule.timeWindowMs } };
}
