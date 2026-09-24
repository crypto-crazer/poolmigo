import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/cli.js';
import { createMemoryLogger, jsonReplacer, serializeError } from '../../src/logger.js';
import { bytes32ToLabel } from '../../src/vault.js';

describe('parseArgs', () => {
  it('defaults to help with no arguments', () => {
    expect(parseArgs([])).toEqual({ command: 'help', dryRunOverride: undefined });
  });

  it('parses the commands', () => {
    expect(parseArgs(['tick']).command).toBe('tick');
    expect(parseArgs(['run']).command).toBe('run');
    expect(parseArgs(['status']).command).toBe('status');
  });

  it('leaves dryRunOverride undefined so the env decides', () => {
    expect(parseArgs(['run']).dryRunOverride).toBeUndefined();
  });

  it('--execute overrides the env toward sending transactions', () => {
    expect(parseArgs(['tick', '--execute']).dryRunOverride).toBe(false);
    expect(parseArgs(['tick', '--no-dry-run']).dryRunOverride).toBe(false);
  });

  it('--dry-run overrides the env toward simulating only', () => {
    expect(parseArgs(['tick', '--dry-run']).dryRunOverride).toBe(true);
  });

  it('later flags win, so --dry-run after --execute is safe', () => {
    expect(parseArgs(['tick', '--execute', '--dry-run']).dryRunOverride).toBe(true);
  });

  it('reports unknown arguments instead of ignoring them', () => {
    const parsed = parseArgs(['tick', '--yolo']);
    expect(parsed.command).toBe('help');
    expect(parsed.error).toMatch(/--yolo/);
  });
});

describe('logger', () => {
  it('emits one JSON object per record with ts/level/msg/svc', () => {
    const { logger, records } = createMemoryLogger('info');
    logger.info('hello', { a: 1 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 'info', msg: 'hello', svc: 'poolmigo-keeper', a: 1 });
    expect(typeof records[0]?.ts).toBe('string');
  });

  it('filters below the configured level', () => {
    const { logger, records } = createMemoryLogger('warn');
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    logger.error('yes');
    expect(records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('serialises bigint token amounts losslessly as decimal strings', () => {
    const { logger, records } = createMemoryLogger('debug');
    const huge = 123456789012345678901234567890n;
    logger.info('amounts', { amount: huge });
    expect(records[0]?.amount).toBe('123456789012345678901234567890');
  });

  it('stamps child fields onto every record', () => {
    const { logger, records } = createMemoryLogger('debug');
    logger.child({ tick: 7 }).info('tick');
    expect(records[0]).toMatchObject({ tick: 7 });
  });

  it('jsonReplacer converts bigint and Error', () => {
    expect(jsonReplacer('k', 1n)).toBe('1');
    expect(jsonReplacer('k', new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
  });

  it('serializeError captures name, message and cause', () => {
    const err = new Error('outer', { cause: new Error('inner') });
    expect(serializeError(err)).toMatchObject({ errName: 'Error', errMsg: 'outer', errCause: 'inner' });
    expect(serializeError('plain string')).toEqual({ errMsg: 'plain string' });
  });
});

describe('bytes32ToLabel', () => {
  it('decodes right-padded ASCII', () => {
    // bytes32("uniswap-v3")
    const raw = `0x${Buffer.from('uniswap-v3').toString('hex').padEnd(64, '0')}` as const;
    expect(bytes32ToLabel(raw)).toBe('uniswap-v3');
  });

  it('falls back to hex for non-printable content', () => {
    const raw = `0x${'ff'.repeat(32)}` as const;
    expect(bytes32ToLabel(raw)).toBe(raw);
  });
});
