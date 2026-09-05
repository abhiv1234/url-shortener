const CUSTOM_ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,16}$/;

export function isValidLongUrl(value: string): boolean {
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
