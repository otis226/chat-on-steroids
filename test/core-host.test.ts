import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_RUNTIME_STATUS_SCHEMA,
  coreControlCommand,
  coreHostMode,
  coreRuntimeStatus,
  coreRuntimeStatusPath,
  initCoreRuntimeStatusPath,
  shouldFocusSecondInstance,
  shouldPresentDesktop,
  writeCoreRuntimeStatus
} from '../src/main/core-host.js';

const temps: string[] = [];
afterEach(async () => {
  while (temps.length) await rm(temps.pop()!, { recursive: true, force: true });
});

describe('headless Core launch policy', () => {
  it('keeps Desktop as the default and makes headless explicit', () => {
    expect(coreHostMode(['app.exe'])).toBe('desktop');
    expect(coreHostMode(['app.exe', '--background'])).toBe('desktop');
    expect(coreHostMode(['app.exe', '--headless'])).toBe('headless');
    expect(shouldPresentDesktop('desktop')).toBe(true);
    expect(shouldPresentDesktop('headless')).toBe(false);
  });

  it('routes stop as control and never lets headless/control launches focus Desktop', () => {
    expect(coreControlCommand(['app.exe', '--core-stop'])).toBe('stop');
    expect(coreControlCommand(['app.exe'])).toBeNull();
    expect(shouldFocusSecondInstance('desktop', ['app.exe'], false)).toBe(true);
    expect(shouldFocusSecondInstance('desktop', ['app.exe', '--background'], true)).toBe(false);
    expect(shouldFocusSecondInstance('desktop', ['app.exe', '--headless'], false)).toBe(false);
    expect(shouldFocusSecondInstance('desktop', ['app.exe', '--core-stop'], false)).toBe(false);
    expect(shouldFocusSecondInstance('headless', ['app.exe'], false)).toBe(false);
  });
});

describe('safe Core runtime status', () => {
  const connection = {
    state: 'connected' as const,
    detail: 'Connected',
    publicUrl: 'https://public.example/secret-ish',
    localUrl: 'http://127.0.0.1:1234/token-should-not-leak',
    handshakeAt: 1,
    lastRequestAt: 2,
    lastToolCallAt: 3,
    health: null,
    surfaces: []
  };

  it('projects only safe status fields', () => {
    const status = coreRuntimeStatus({
      mode: 'headless',
      phase: 'ready',
      pid: 123,
      appVersion: '2.1.14',
      startedAt: 100,
      updatedAt: 200,
      connection,
      bridgePort: 8765
    });
    expect(status).toEqual({
      schemaVersion: CORE_RUNTIME_STATUS_SCHEMA,
      mode: 'headless',
      phase: 'ready',
      pid: 123,
      appVersion: '2.1.14',
      startedAt: 100,
      updatedAt: 200,
      connection: { state: 'connected', detail: 'Connected' },
      bridge: { running: true, port: 8765 }
    });
    const text = JSON.stringify(status);
    expect(text).not.toContain('public.example');
    expect(text).not.toContain('token-should-not-leak');
    expect(text).not.toMatch(/publicUrl|localUrl|token|apiKey|credential/i);
  });

  it('writes the operator snapshot under userData/state without secrets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-core-host-'));
    temps.push(root);
    initCoreRuntimeStatusPath(root);
    const status = coreRuntimeStatus({
      mode: 'desktop',
      phase: 'starting',
      pid: 7,
      appVersion: 'test',
      startedAt: 1,
      updatedAt: 2,
      connection,
      bridgePort: null
    });
    await writeCoreRuntimeStatus(status);
    const stored = await readFile(coreRuntimeStatusPath(root), 'utf8');
    expect(JSON.parse(stored)).toEqual(status);
    expect(stored).not.toContain('token-should-not-leak');
  });
});