import { describe, expect, test } from 'bun:test';
import { maskSecret, isSensitiveKey, toPublicInfo } from '../../src/provider/provider';
import type { Info } from '../../src/provider/provider';

describe('maskSecret', () => {
  test('returns undefined for empty string', () => {
    expect(maskSecret('')).toBeUndefined();
  });

  test('masks short values (<=8 chars) with ****', () => {
    expect(maskSecret('short')).toBe('****');
    expect(maskSecret('12345678')).toBe('****');
  });

  test('masks long values keeping first 4 and last 4', () => {
    expect(maskSecret('sk-abcdef123456')).toBe('sk-a****3456');
  });

  test('handles exactly 9 chars', () => {
    expect(maskSecret('123456789')).toBe('1234****6789');
  });
});

describe('isSensitiveKey', () => {
  test('matches exact names', () => {
    expect(isSensitiveKey('key')).toBe(true);
    expect(isSensitiveKey('token')).toBe(true);
    expect(isSensitiveKey('secret')).toBe(true);
    expect(isSensitiveKey('password')).toBe(true);
  });

  test('matches hyphenated variants', () => {
    expect(isSensitiveKey('api-key')).toBe(true);
    expect(isSensitiveKey('client-secret')).toBe(true);
    expect(isSensitiveKey('access-key-id')).toBe(true);
  });

  test('matches underscored variants', () => {
    expect(isSensitiveKey('api_key')).toBe(true);
    expect(isSensitiveKey('refresh_token')).toBe(true);
    expect(isSensitiveKey('secret_access_key')).toBe(true);
  });

  test('matches camelCase variants', () => {
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('accessToken')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isSensitiveKey('APIKey')).toBe(true);
    expect(isSensitiveKey('TOKEN')).toBe(true);
  });

  test('rejects non-sensitive names', () => {
    expect(isSensitiveKey('name')).toBe(false);
    expect(isSensitiveKey('url')).toBe(false);
    expect(isSensitiveKey('model')).toBe(false);
    expect(isSensitiveKey('id')).toBe(false);
  });
});

describe('toPublicInfo', () => {
  test('masks top-level key field', () => {
    const provider = {
      id: 'test',
      name: 'Test Provider',
      key: 'sk-very-secret-key-12345',
    } as unknown as Info;
    const result = toPublicInfo(provider);
    expect(result.key).toBe('sk-v****2345');
  });

  test('masks nested options.apiKey', () => {
    const provider = {
      id: 'test',
      name: 'Test',
      options: {
        apiKey: 'sk-secret-key-abcdef',
      },
    } as unknown as Info;
    const result = toPublicInfo(provider);
    expect((result as any).options.apiKey).toBe('sk-s****cdef');
  });

  test('masks nested access_key_id variant', () => {
    const provider = {
      id: 'test',
      name: 'Test',
      options: {
        access_key_id: 'AKIAVERYLONGSECRET',
      },
    } as unknown as Info;
    const result = toPublicInfo(provider);
    expect((result as any).options.access_key_id).toBe('AKIA****CRET');
  });

  test('preserves non-sensitive fields', () => {
    const provider = {
      id: 'test',
      name: 'Test Provider',
      models: { 'test-model': { id: 'test-model' } },
    } as unknown as Info;
    const result = toPublicInfo(provider);
    expect(result.id as string).toBe('test');
    expect(result.name).toBe('Test Provider');
  });

  test('strips functions and symbols', () => {
    const provider = {
      id: 'test',
      name: 'Test',
      fn: () => 'hello',
    } as unknown as Info;
    const result = toPublicInfo(provider) as any;
    expect(result.fn).toBeUndefined();
  });
});
