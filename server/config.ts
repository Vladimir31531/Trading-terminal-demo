import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ServiceConfig {
  projectRoot: string;
  projectId: string;
  dataDir: string;
  dataDirectories: string[];
  port: number;
  devPort: number;
}

export async function loadConfig(): Promise<ServiceConfig> {
  const projectRoot = await realpath(resolve(import.meta.dir, '..'));
  const settings: unknown = await Bun.file(
    resolve(projectRoot, 'terminal.config.json'),
  ).json();
  if (
    !settings ||
    typeof settings !== 'object' ||
    !('dataDirectories' in settings) ||
    !Array.isArray(settings.dataDirectories) ||
    !settings.dataDirectories.length ||
    settings.dataDirectories.some(
      (entry: unknown) => typeof entry !== 'string' || !entry.trim(),
    )
  ) {
    throw new Error(
      'Укажите папки с CSV в terminal.config.json: dataDirectories.',
    );
  }
  const dataDirectories: string[] = [];
  for (const entry of settings.dataDirectories as string[]) {
    const directory = await realpath(resolve(projectRoot, entry));
    if (!(await stat(directory)).isDirectory())
      throw new Error('Путь dataDirectories должен указывать на папку.');
    if (!dataDirectories.includes(directory)) dataDirectories.push(directory);
  }
  const port = Number(process.env.TERMINAL_PORT ?? 3000);
  const devPort = Number(process.env.TERMINAL_DEV_PORT ?? 3001);
  for (const value of [port, devPort]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error('Порт должен быть целым числом от 1 до 65535.');
  }
  if (port === devPort)
    throw new Error('Порты приложения и RSBuild должны различаться.');
  return {
    projectRoot,
    projectId: createHash('sha256').update(projectRoot).digest('hex'),
    dataDir: resolve(projectRoot, '.data'),
    dataDirectories,
    port,
    devPort,
  };
}
