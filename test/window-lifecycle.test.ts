import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  applyLoginStartup,
  isBackgroundLaunch,
  isHeadlessLaunch,
  supportsLoginStartup,
  createWindowActivationGate,
  ownsAppRuntime,
  registerNativeWindowActivation,
  shouldBeginAppBootstrap,
  shouldQuitOnWindowAllClosed
} from '../src/main/window-lifecycle.js';

describe('native window activation', () => {
  it.each(['darwin', 'win32', 'linux'])('keeps native fullscreen available on macOS (%s)', (platform) => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const constructor = source.slice(source.indexOf('  window = new BrowserWindow({'), source.indexOf("  if (process.platform === 'win32') window.removeMenu();"))
      .replace(' as const', '');
    let options: Record<string, unknown> | undefined;
    vm.runInNewContext(constructor, {
      BrowserWindow: function (value: Record<string, unknown>) { options = value; },
      layout: {}, icon: null, process: { platform },
      titleBarOverlayForTheme: () => ({}), windowBackgroundForTheme: () => '#181818', getConfig: () => ({ ui: { theme: 'dark' } }),
      UI_BASE_ZOOM: 1, path: { join: () => 'preload.js' }, __dirname: '/app'
    });
    expect(options?.fullscreenable).toBe(platform === 'darwin');
    expect(options?.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  });

  it('maximizes only on initial presentation and preserves user-sized geometry on reopen', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const present = source.slice(source.indexOf('function showWindow()'), source.indexOf('\nsetFinishNotifier(', source.indexOf('function showWindow()'))).replace('function showWindow(): void', 'function showWindow()');
    const operations: string[] = [];
    const state = { minimized: false };
    const native = { isMinimized: () => state.minimized, isFullScreen: () => false,
      maximize: () => operations.push('maximize'),
      restore: () => operations.push('restore'),
      show: () => operations.push('show'), focus: () => operations.push('focus') };
    const createWindow = vi.fn();
    const context = vm.createContext({ window: native, quitting: false, createWindow, headless: false });
    vm.runInContext(present + '\nshowWindow();', context);
    expect(operations.splice(0)).toEqual(['show', 'focus']);
    state.minimized = true;
    vm.runInContext('showWindow()', context);
    expect(operations.splice(0)).toEqual(['restore', 'show', 'focus']);
    context.quitting = true;
    vm.runInContext('showWindow()', context);
    expect(operations).toEqual([]);

    let ready!: () => void;
    const startup = source.slice(source.indexOf("  window.once('ready-to-show'"), source.indexOf('  // A renderer that fails', source.indexOf("  window.once('ready-to-show'")));
    const startupOperations: string[] = [];
    const startupState = { fullscreen: false };
    const showWindow = vi.fn(() => startupOperations.push('showWindow'));
    const launch = vm.createContext({ window: {
      once: (_event: string, listener: () => void) => { ready = listener; },
      isFullScreen: () => startupState.fullscreen,
      maximize: () => startupOperations.push('maximize')
    }, quitting: false, showWindow });
    vm.runInContext(startup, launch);
    ready();
    expect(startupOperations.splice(0)).toEqual(['maximize', 'showWindow']);
    startupState.fullscreen = true;
    ready();
    expect(startupOperations.splice(0)).toEqual(['showWindow']);
    launch.quitting = true;
    ready();
    expect(showWindow).toHaveBeenCalledTimes(2);
  });
  it('passively observes on first visible use without opening a browser, never on repeat show or quit', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const listener = source.slice(source.indexOf("  window.on('show'"), source.indexOf("  window.once('ready-to-show'"));
    let show!: () => void;
    let state = 'ready';
    const start = vi.fn(async () => { state = 'pending'; return {}; });
    const context = vm.createContext({ window: { on: (event: string, callback: () => void) => {
      expect(event).toBe('show'); show = callback;
    } }, quitting: false, getChatModels: () => ({ state }), startChatModelDiscovery: start, logWarn: vi.fn() });
    vm.runInContext(listener, context);
    show(); await Promise.resolve(); expect(start).not.toHaveBeenCalled();
    state = 'unknown';
    show(); await Promise.resolve();
    show(); await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(false);
    state = 'unavailable';
    show(); await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    state = 'unknown';
    context.quitting = true;
    show();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('never bootstraps shared state from a secondary or already-quitting process', () => {
    expect(ownsAppRuntime(true)).toBe(true);
    expect(ownsAppRuntime(false)).toBe(false);
    expect(shouldBeginAppBootstrap(true, false)).toBe(true);
    expect(shouldBeginAppBootstrap(false, false)).toBe(false);
    expect(shouldBeginAppBootstrap(false, true)).toBe(false);
    expect(shouldBeginAppBootstrap(true, true)).toBe(false);
  });

  it('drops second-instance focus requests until renderer security and IPC startup are ready', () => {
    const show = vi.fn();
    const gate = createWindowActivationGate(show);

    // Electron can emit second-instance after its `ready` event while our async startup is still
    // restoring state. The initial startup path will show a window itself, so this early request
    // must not create one before CSP/permission/IPC setup is complete.
    gate.request();
    expect(show).not.toHaveBeenCalled();

    gate.enable();
    expect(show).not.toHaveBeenCalled();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);

    // `before-quit` closes the gate again while bounded teardown drains. Native activation or a
    // second launch in that window must not resurrect application UI during shutdown.
    gate.disable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);

    // Startup is async. A continuation that resumes after `before-quit` can still execute its
    // old enable() call; shutdown must be a one-way boundary so that stale continuation cannot
    // reactivate Dock/second-instance/tray presentation.
    expect(gate.isDisabled()).toBe(true);
    gate.enable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('reopens the app from the macOS Dock activation event', () => {
    const listeners = new Map<string, () => void>();
    const source = { on: vi.fn((event: 'activate', listener: () => void) => listeners.set(event, listener)) };
    const show = vi.fn();
    registerNativeWindowActivation(source, show, 'darwin');

    expect(source.on).toHaveBeenCalledWith('activate', show);
    listeners.get('activate')!();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it.each(['win32', 'linux'] as const)('does not add a foreign activation contract on %s', (platform) => {
    const source = { on: vi.fn() };
    registerNativeWindowActivation(source, vi.fn(), platform);
    expect(source.on).not.toHaveBeenCalled();
  });

  it('keeps a macOS app alive after its last window closes, regardless of close-to-tray preference', () => {
    expect(shouldQuitOnWindowAllClosed('darwin', true)).toBe(false);
    expect(shouldQuitOnWindowAllClosed('darwin', false)).toBe(false);
  });

  it.each(['win32', 'linux'] as const)('keeps close-to-tray semantics on %s', (platform) => {
    expect(shouldQuitOnWindowAllClosed(platform, true)).toBe(false);
    expect(shouldQuitOnWindowAllClosed(platform, false)).toBe(true);
  });
});

describe('Windows login startup', () => {
  it('writes only packaged Windows login settings and supports turning the same entry off', () => {
    const app = { isPackaged: true, setLoginItemSettings: vi.fn() };
    applyLoginStartup(app, true, 'win32', 'C:/Program Files/Chat On Steroids/app.exe');
    applyLoginStartup(app, false, 'win32', 'C:/Program Files/Chat On Steroids/app.exe');
    expect(app.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true, path: 'C:/Program Files/Chat On Steroids/app.exe', args: ['--background'] }],
      [{ openAtLogin: false, path: 'C:/Program Files/Chat On Steroids/app.exe', args: ['--background'] }]
    ]);
    for (const platform of ['darwin', 'linux'] as const) applyLoginStartup(app, true, platform);
    app.isPackaged = false;
    applyLoginStartup(app, true, 'win32');
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(supportsLoginStartup('win32', false)).toBe(false);
  });
  it('ignores background second-instance launches while ordinary launches still focus', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.on('second-instance'");
    const handler = source.slice(start, source.indexOf('\n});', start) + 4);
    let received!: (event: unknown, argv: string[]) => void;
    const request = vi.fn();
    vm.runInNewContext(handler, { app: { on: (_: string, listener: typeof received) => { received = listener; } }, windowActivation: { request }, isBackgroundLaunch });
    received({}, ['app.exe', '--background']);
    expect(request).not.toHaveBeenCalled();
    received({}, ['app.exe']);
    expect(request).toHaveBeenCalledOnce();
    expect(isBackgroundLaunch(['app.exe', '--background=false'])).toBe(false);
    expect(source).toContain('if (!isBackgroundLaunch(process.argv)) windowActivation.request();');
  });
});

describe('headless launch', () => {
  it('reads --headless as its own launch discriminator, not as --background', () => {
    expect(isHeadlessLaunch(['app.exe', '--headless'])).toBe(true);
    expect(isHeadlessLaunch(['app.exe'])).toBe(false);
    expect(isHeadlessLaunch(['app.exe', '--headless=false'])).toBe(false);
    expect(isHeadlessLaunch(['app.exe', '--background'])).toBe(false);
    expect(isBackgroundLaunch(['app.exe', '--headless'])).toBe(false);
    expect(isHeadlessLaunch(['app.exe', '--also-headless'])).toBe(false);
  });

  it('refuses every activation source without turning into a shutdown gate', () => {
    const show = vi.fn();
    const headlessGate = createWindowActivationGate(show, false);
    headlessGate.request();
    headlessGate.enable();
    headlessGate.request();
    expect(show).not.toHaveBeenCalled();
    // Headless must not reuse the before-quit disabled flag: bootstrap uses that flag as its own
    // stop-restoring-shared-state signal, so a headless launch would never reach Core or bridge.
    expect(headlessGate.isDisabled()).toBe(false);

    const ordinary = createWindowActivationGate(show, true);
    ordinary.enable();
    ordinary.request();
    expect(show).toHaveBeenCalledTimes(1);

    // Ordinary and background launches keep the documented presentation behavior.
    const background = createWindowActivationGate(show);
    background.enable();
    background.request();
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('never constructs or presents a window through the startup funnel', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const funnel = source
      .slice(source.indexOf('function createWindow(): void {'), source.indexOf('setFinishNotifier(', source.indexOf('function showWindow()')))
      .replace('function createWindow(): void', 'function createWindow()')
      .replace('function showWindow(): void', 'function showWindow()')
      .replace(' as const', '');
    const headlessContext = vm.createContext({
      headless: true, quitting: false, window: null as unknown,
      BrowserWindow: function () { throw new Error('headless constructed a BrowserWindow'); },
      Tray: function () { throw new Error('headless constructed a Tray'); }
    });
    expect(() => vm.runInContext(funnel + 'showWindow(); createWindow();', headlessContext)).not.toThrow();
    expect(headlessContext.window).toBeNull();

    // Neighboring case: the same funnel still constructs the ordinary window when not headless.
    const constructed: string[] = [];
    const native = { on: () => undefined, once: () => undefined, removeMenu: () => undefined,
      loadFile: () => undefined, loadURL: () => undefined,
      webContents: { on: () => undefined, setWindowOpenHandler: () => undefined } };
    const ordinaryContext = vm.createContext({
      headless: false, quitting: false, window: null as unknown,
      BrowserWindow: function () { constructed.push('BrowserWindow'); return native; },
      screen: { getPrimaryDisplay: () => ({ workArea: {} }) },
      windowLayoutForWorkArea: () => ({}), browserWindowIconPath: () => null,
      getConfig: () => ({ ui: {} }), titleBarOverlayForTheme: () => ({}),
      windowBackgroundForTheme: () => '#181818', UI_BASE_ZOOM: 1,
      path: { join: () => 'index.html' }, __dirname: '/app',
      process: { platform: 'linux', env: {}, resourcesPath: '/res' },
      app: { isPackaged: false }
    });
    vm.runInContext(funnel + 'createWindow();', ordinaryContext);
    expect(constructed).toEqual(['BrowserWindow']);
    expect(ordinaryContext.window).toBe(native);
  });

  it('keeps the tray and the finish notifier out of a headless process', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const trayCreation = source.indexOf('tray = new Tray(');
    const trayBlock = source.slice(
      source.lastIndexOf('if (!headless) {', trayCreation),
      source.indexOf('logInfo(', trayCreation)
    );
    const trayCalls = (headless: boolean) => {
      const calls: string[] = [];
      const context = vm.createContext({
        headless, tray: null as unknown,
        Tray: function () { calls.push('tray'); return { on: () => undefined }; },
        trayIcon: () => ({}), trayGuidArgsForPlatform: () => [],
        windowActivation: { request: () => calls.push('open') },
        refreshTray: () => calls.push('refresh'), onStatusChange: () => calls.push('status')
      });
      vm.runInContext(trayBlock, context);
      return { calls, tray: context.tray };
    };
    expect(trayCalls(true)).toEqual({ calls: [], tray: null });
    expect(trayCalls(false).calls).toEqual(['tray', 'refresh', 'status']);

    const notifier = source.slice(
      source.indexOf('setFinishNotifier(', source.indexOf('function showWindow()')),
      source.indexOf('setBrowserWorkArea(')
    ).replace(/\(\): void =>/g, '() =>');
    const installed: unknown[] = [];
    const install = (headless: boolean) => {
      const context = vm.createContext({ headless, setFinishNotifier: (listener: unknown) => installed.push(listener) });
      vm.runInContext(notifier, context);
    };
    install(true);
    expect(installed).toEqual([null]);
    install(false);
    expect(typeof installed[1]).toBe('function');
  });

  it('wires headless as its own launch mode while background startup keeps its path', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    expect(source).toContain('const headless = isHeadlessLaunch(process.argv);');
    expect(source).toContain('const windowActivation = createWindowActivationGate(showWindow, !headless);');
    expect(source).toContain('if (headless) return;');
    // Background still only skips the first presentation and re-enables ordinary activation.
    expect(source).toContain('if (!isBackgroundLaunch(process.argv)) windowActivation.request();');
  });
});
