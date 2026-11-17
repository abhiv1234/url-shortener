import type pg from 'pg';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import type { IssuedToken, TokenService } from '../auth/tokens.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../errors.js';
import { isUniqueViolation } from './urlService.js';

export interface Credentials {
  email: string;
  password: string;
}

export interface PublicUser {
  id: string;
  email: string;
  createdAt: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
/** bcrypt only uses the first 72 bytes; reject longer input instead of silently truncating. */
const MAX_PASSWORD_BYTES = 72;

function parseCredentials(input: unknown): Credentials {
  if (typeof input !== 'object' || input === null) {
    throw new ValidationError('request body must be a JSON object', 'INVALID_BODY');
  }

  const { email, password } = input as Record<string, unknown>;

  if (typeof email !== 'string' || email.length > 254 || !EMAIL_PATTERN.test(email.trim())) {
    throw new ValidationError('email must be a valid email address', 'INVALID_EMAIL');
  }

  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    Buffer.byteLength(password) > MAX_PASSWORD_BYTES
  ) {
    throw new ValidationError(
      `password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_BYTES} bytes long`,
      'INVALID_PASSWORD',
    );
  }

  return { email: email.trim().toLowerCase(), password };
}

export class AuthService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly db: Pick<pg.Pool, 'query'>,
    private readonly tokens: TokenService,
    private readonly bcryptRounds: number,
  ) {}

  async register(input: unknown): Promise<PublicUser> {
    const { email, password } = parseCredentials(input);
    const passwordHash = await hashPassword(password, this.bcryptRounds);

    try {
      const result = await this.db.query<{ id: string; email: string; created_at: Date }>(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2)
         RETURNING id, email, created_at`,
        [email, passwordHash],
      );
      const row = result.rows[0];
      return { id: row.id, email: row.email, createdAt: row.created_at.toISOString() };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('an account with this email already exists', 'EMAIL_TAKEN');
      }
      throw error;
    }
  }

  async login(input: unknown): Promise<IssuedToken> {
    const { email, password } = parseCredentials(input);

    const result = await this.db.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email],
    );
    const user = result.rows[0];

    // Always run one bcrypt comparison so response time does not reveal whether the email exists.
    const hash = user?.password_hash ?? (await this.getDummyHash());
    const valid = await verifyPassword(password, hash);

    if (!user || !valid) {
      throw new UnauthorizedError('invalid email or password', 'INVALID_CREDENTIALS');
    }

    return this.tokens.sign(user.id);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword('not-a-real-password', this.bcryptRounds);
    return this.dummyHash;
  }
}
