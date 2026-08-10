import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUFFER_LINES,
  DEFAULT_CONTROL_MINUTES,
  DEFAULT_PORT,
  parseArgs,
} from '../../src/cli/args.js';

describe('parseArgs', () => {
  it('-- 以降をコマンドと引数として取り出す', () => {
    const result = parseArgs(['--', 'codex', 'resume', '--last']);
    expect(result.kind).toBe('run');
    if (result.kind !== 'run') return;
    expect(result.command).toBe('codex');
    expect(result.args).toEqual(['resume', '--last']);
  });

  it('-- 以降のオプション風の引数を解釈しない', () => {
    const result = parseArgs(['--', 'claude', '--port', '1']);
    expect(result.kind).toBe('run');
    if (result.kind !== 'run') return;
    expect(result.args).toEqual(['--port', '1']);
    expect(result.options.port).toBe(DEFAULT_PORT);
  });

  it('既定値を返す', () => {
    const result = parseArgs(['--', 'codex']);
    if (result.kind !== 'run') throw new Error('run を期待');
    expect(result.options).toEqual({
      cwd: null,
      port: DEFAULT_PORT,
      bufferLines: DEFAULT_BUFFER_LINES,
      controlMinutes: DEFAULT_CONTROL_MINUTES,
      recordPath: null,
      localOnly: false,
    });
  });

  it('全オプションを解析する', () => {
    const result = parseArgs([
      '--cwd',
      'C:\\work\\日本語 フォルダー',
      '--port',
      '50000',
      '--buffer-lines',
      '500',
      '--control-minutes',
      '3',
      '--record',
      'log.txt',
      '--local-only',
      '--',
      'codex',
    ]);
    if (result.kind !== 'run') throw new Error('run を期待');
    expect(result.options).toEqual({
      cwd: 'C:\\work\\日本語 フォルダー',
      port: 50000,
      bufferLines: 500,
      controlMinutes: 3,
      recordPath: 'log.txt',
      localOnly: true,
    });
  });

  it('--help と --version を返す', () => {
    expect(parseArgs(['--help']).kind).toBe('help');
    expect(parseArgs(['--version']).kind).toBe('version');
  });

  it('-- が無い場合はエラー', () => {
    expect(parseArgs(['codex']).kind).toBe('error');
    expect(parseArgs([]).kind).toBe('error');
  });

  it('-- の後ろが空ならエラー', () => {
    expect(parseArgs(['--']).kind).toBe('error');
  });

  it('不正な数値を拒否する', () => {
    expect(parseArgs(['--port', 'abc', '--', 'codex']).kind).toBe('error');
    expect(parseArgs(['--port', '0', '--', 'codex']).kind).toBe('error');
    expect(parseArgs(['--port', '70000', '--', 'codex']).kind).toBe('error');
    expect(parseArgs(['--buffer-lines', '1', '--', 'codex']).kind).toBe('error');
    expect(parseArgs(['--control-minutes', '0', '--', 'codex']).kind).toBe('error');
  });

  it('値のないオプションを拒否する', () => {
    expect(parseArgs(['--cwd', '--', 'codex']).kind).toBe('error');
    expect(parseArgs(['--port']).kind).toBe('error');
  });

  it('未知のオプションを拒否する', () => {
    expect(parseArgs(['--unknown', '--', 'codex']).kind).toBe('error');
  });
});
