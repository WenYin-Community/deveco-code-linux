import { describe, expect, test } from 'bun:test';
import { isSsrfSafeUrl } from '../../src/session/instruction';

describe('isSsrfSafeUrl', () => {
  test('allows public https URLs', () => {
    expect(isSsrfSafeUrl('https://example.com/instructions.md')).toBe(true);
  });

  test('allows public http URLs', () => {
    expect(isSsrfSafeUrl('http://example.com/instructions.md')).toBe(true);
  });

  test('rejects localhost', () => {
    expect(isSsrfSafeUrl('http://localhost:8080/admin')).toBe(false);
  });

  test('rejects 127.0.0.1', () => {
    expect(isSsrfSafeUrl('http://127.0.0.1/admin')).toBe(false);
  });

  test('rejects 0.0.0.0', () => {
    expect(isSsrfSafeUrl('http://0.0.0.0/admin')).toBe(false);
  });

  test('rejects IPv6 loopback ::1', () => {
    expect(isSsrfSafeUrl('http://[::1]/admin')).toBe(false);
  });

  test('rejects AWS metadata endpoint', () => {
    expect(isSsrfSafeUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
  });

  test('rejects 10.x private range', () => {
    expect(isSsrfSafeUrl('http://10.0.0.1/internal')).toBe(false);
  });

  test('rejects 192.168.x private range', () => {
    expect(isSsrfSafeUrl('http://192.168.1.1/router')).toBe(false);
  });

  test('rejects 172.16-31.x private range', () => {
    expect(isSsrfSafeUrl('http://172.16.0.1/internal')).toBe(false);
    expect(isSsrfSafeUrl('http://172.31.0.1/internal')).toBe(false);
  });

  test('allows 172.32.x (outside private range)', () => {
    expect(isSsrfSafeUrl('http://172.32.0.1/')).toBe(true);
  });

  test('rejects decimal-integer IP bypass (2130706433 = 127.0.0.1)', () => {
    expect(isSsrfSafeUrl('http://2130706433/admin')).toBe(false);
  });

  test('rejects link-local 169.254.x range', () => {
    expect(isSsrfSafeUrl('http://169.254.1.1/test')).toBe(false);
  });

  test('rejects non-http protocols', () => {
    expect(isSsrfSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSsrfSafeUrl('ftp://example.com/')).toBe(false);
  });

  test('rejects invalid URLs', () => {
    expect(isSsrfSafeUrl('not-a-url')).toBe(false);
  });

  test('rejects IPv6 link-local fe80::', () => {
    expect(isSsrfSafeUrl('http://[fe80::1]/')).toBe(false);
  });

  test('rejects IPv6 unique-local fc00::', () => {
    expect(isSsrfSafeUrl('http://[fc00::1]/')).toBe(false);
  });
});
