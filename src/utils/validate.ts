const CUSTOM_ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,16}$/;
const SHORT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
export const MAX_LONG_URL_LENGTH = 2048;

export function isValidLongUrl(value: string): boolean {
  if (value.length > MAX_LONG_URL_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidCustomAlias(value: string): boolean {
  return CUSTOM_ALIAS_PATTERN.test(value);
}

/** Cheap pre-check so junk paths never reach Redis or Postgres. */
export function isPlausibleShortCode(value: string): boolean {
  return SHORT_CODE_PATTERN.test(value);
}
