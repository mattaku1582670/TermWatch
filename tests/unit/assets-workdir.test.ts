import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readAsset, resolveAssetPath } from '../../src/server/http-assets.js';
import { resolveWorkdir } from '../../src/cli/workdir.js';

const root = mkdtempSync(join(tmpdir(), 'termwatch-test-'));
const webRoot = join(root, 'web');
mkdirSync(webRoot, { recursive: true });
writeFileSync(join(webRoot, 'index.html'), '<!doctype html>');
writeFileSync(join(root, 'secret.txt'), 'とても秘密');
mkdirSync(join(root, '日本語 フォルダー'), { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('静的ファイル配信', () => {
  it('ルートの index.html を返す', () => {
    const asset = readAsset(webRoot, '/');
    expect(asset?.contentType).toContain('text/html');
  });

  it('パストラバーサルを拒否する', () => {
    expect(resolveAssetPath(webRoot, '/../secret.txt')).toBeNull();
    expect(resolveAssetPath(webRoot, '/%2e%2e/secret.txt')).toBeNull();
    expect(resolveAssetPath(webRoot, '/..%2fsecret.txt')).toBeNull();
    expect(readAsset(webRoot, '/../secret.txt')).toBeNull();
  });

  it('不正なパーセントエンコードとNUL文字を拒否する', () => {
    expect(resolveAssetPath(webRoot, '/%')).toBeNull();
    expect(resolveAssetPath(webRoot, '/a%00b')).toBeNull();
  });

  it('存在しないファイルは null', () => {
    expect(readAsset(webRoot, '/nope.js')).toBeNull();
  });
});

describe('作業フォルダー検証', () => {
  it('未指定なら基準フォルダーを返す', () => {
    const result = resolveWorkdir(null, root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(root);
  });

  it('日本語・空白を含むフォルダーを解決する', () => {
    const result = resolveWorkdir('日本語 フォルダー', root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(resolve(root, '日本語 フォルダー'));
  });

  it('存在しないフォルダーを拒否する', () => {
    expect(resolveWorkdir('存在しない', root).ok).toBe(false);
  });

  it('ファイルを指定した場合は拒否する', () => {
    expect(resolveWorkdir('secret.txt', root).ok).toBe(false);
  });

  it('空文字を拒否する', () => {
    expect(resolveWorkdir('   ', root).ok).toBe(false);
  });
});
