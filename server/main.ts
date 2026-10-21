import { resolve } from 'node:path';
import type { ServiceIdentity } from '../src/application/service-contract';
import { createApplication, requestIsLocal } from './application';
import { loadConfig } from './config';
import { acquireServiceLock } from './service-lock';

export async function probeExistingService(
  origin: string,
  projectId: string,
): Promise<ServiceIdentity | undefined> {
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return;
    const identity: unknown = await response.json();
    if (
      identity &&
      typeof identity === 'object' &&
      'app' in identity &&
      identity.app === 'terminal-demo' &&
      'projectId' in identity &&
      identity.projectId === projectId &&
      'protocolVersion' in identity &&
      identity.protocolVersion === 1 &&
      'ready' in identity &&
      typeof identity.ready === 'boolean' &&
      'mode' in identity &&
      ['dev', 'start'].includes(String(identity.mode))
    ) {
      return identity as ServiceIdentity;
    }
  } catch {
    /* An occupied port can belong to another application or an unready process. */
  }
}

async function launch() {
  const config = await loadConfig();
  const mode = process.argv.includes('--dev') ? 'dev' : 'start';
  const origin = `http://127.0.0.1:${config.port}`;
  const identity: ServiceIdentity = {
    app: 'terminal-demo',
    projectId: config.projectId,
    protocolVersion: 1,
    mode,
    ready: false,
  };
  let application: ReturnType<typeof createApplication> | undefined;
  let devServer: { close(): Promise<void> } | undefined;
  let serviceLock: ReturnType<typeof acquireServiceLock> | undefined;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let server: ReturnType<typeof Bun.serve>;
  try {
    // The public port identifies an existing instance before any other startup work.
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: config.port,
      reusePort: false,
      maxRequestBodySize: 2 * 1024 * 1024,
      fetch(request, instance) {
        if (!requestIsLocal(request, config.port))
          return new Response('Forbidden', { status: 403 });
        if (
          request.method === 'GET' &&
          new URL(request.url).pathname === '/api/health'
        )
          return Response.json(identity, {
            headers: { 'Cache-Control': 'no-store' },
          });
        return (
          application?.fetch(request, instance) ??
          new Response('Сервис запускается.', { status: 503 })
        );
      },
    });
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !('code' in cause) ||
      cause.code !== 'EADDRINUSE'
    )
      throw cause;
    let existing = await probeExistingService(origin, config.projectId);
    if (!existing)
      throw new Error(
        `Порт ${config.port} занят другим приложением. Освободите порт или задайте TERMINAL_PORT.`,
      );
    const deadline = Date.now() + 30000;
    while (!existing.ready && Date.now() < deadline) {
      await Bun.sleep(250);
      existing = await probeExistingService(origin, config.projectId);
      if (!existing)
        throw new Error(
          'Первый экземпляр сервиса остановился во время запуска. Повторите команду.',
        );
    }
    if (!existing.ready)
      throw new Error(
        'Первый экземпляр ещё запускается. Повторите команду позже.',
      );
    console.log(
      `Terminal-demo уже запущен (${existing.mode}). Используйте ${origin}/ — второй экземпляр не создан.`,
    );
    return;
  }

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      identity.ready = false;
      try {
        await application?.close();
      } finally {
        try {
          await devServer?.close();
        } finally {
          try {
            await server.stop(true);
          } finally {
            serviceLock?.close();
          }
        }
      }
    })();
    return stopPromise;
  };
  process.on('SIGINT', () => {
    void stop();
  });
  process.on('SIGTERM', () => {
    void stop();
  });

  try {
    // The project lock also prevents a second owner when TERMINAL_PORT changes.
    serviceLock = acquireServiceLock(config.dataDir);
    if (mode === 'dev') {
      const { createRsbuild } = await import('@rsbuild/core');
      const { default: rsbuildConfig } = await import('../rsbuild.config');
      const rsbuild = await createRsbuild({
        cwd: config.projectRoot,
        rsbuildConfig,
      });
      devServer = (await rsbuild.startDevServer()).server;
    } else if (
      !(await Bun.file(resolve(config.projectRoot, 'dist/index.html')).exists())
    ) {
      throw new Error(
        'Сборка интерфейса отсутствует. Сначала выполните bun run build.',
      );
    }
    if (stopping) {
      await devServer?.close();
      return;
    }
    application = createApplication(
      config,
      identity,
      mode === 'dev' ? `http://127.0.0.1:${config.devPort}` : undefined,
    );
    identity.ready = true;
    console.log(
      `\nTerminal-demo: ${origin}/\nCSV читаются с диска. Ctrl+C — остановить сервис.\n`,
    );
  } catch (cause) {
    await stop();
    throw cause;
  }
}

if (import.meta.main) {
  await launch().catch((cause: unknown) => {
    console.error(
      cause instanceof Error
        ? cause.message
        : 'Не удалось запустить Terminal-demo.',
    );
    process.exitCode = 1;
  });
}
