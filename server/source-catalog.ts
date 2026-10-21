import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { DirectoryListing, SourceDirectory } from '../src/domain/market';
import { HttpError } from './http-error';

export function isWithinDirectory(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === '' ||
    (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
  );
}

interface CatalogEntry {
  path: string;
  root: string;
  parentId?: string;
  kind: 'directory' | 'file';
}

/** Only paths enumerated beneath configured roots receive a browser-visible ID. */
export class SourceCatalog {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly ids = new Map<string, string>();
  private readonly roots: SourceDirectory[] = [];

  constructor(directories: string[]) {
    for (const root of directories) {
      const id = this.register({ path: root, root, kind: 'directory' });
      this.roots.push({ id, name: basename(root) || root, kind: 'directory' });
    }
  }

  private register(entry: CatalogEntry): string {
    const previous = this.ids.get(entry.path);
    if (previous) return previous;
    const id = crypto.randomUUID();
    this.ids.set(entry.path, id);
    this.entries.set(id, entry);
    return id;
  }

  private async resolve(
    id: string,
    kind: CatalogEntry['kind'],
  ): Promise<CatalogEntry> {
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== kind)
      throw new HttpError(404, 'Выберите файл или папку заново.');
    let actual: string;
    try {
      actual = await realpath(entry.path);
    } catch {
      throw new HttpError(404, 'Файл или папка больше недоступны.');
    }
    if (!isWithinDirectory(entry.root, actual))
      throw new HttpError(403, 'Путь находится вне разрешённой папки с CSV.');
    return { ...entry, path: actual };
  }

  async filePath(id: string): Promise<string> {
    return (await this.resolve(id, 'file')).path;
  }

  async list(directoryId?: string): Promise<DirectoryListing> {
    const id = directoryId ?? this.roots[0]?.id;
    if (!id) throw new HttpError(404, 'Папки с CSV не настроены.');
    const directory = await this.resolve(id, 'directory');
    const entries: DirectoryListing['entries'] = [];
    const children = await readdir(directory.path, { withFileTypes: true });
    for (const child of children) {
      if (
        child.name.startsWith('.') ||
        child.name === 'node_modules' ||
        child.name === 'dist' ||
        child.isSymbolicLink()
      )
        continue;
      const path = `${directory.path}${sep}${child.name}`;
      if (child.isDirectory()) {
        entries.push({
          id: this.register({
            path,
            root: directory.root,
            parentId: id,
            kind: 'directory',
          }),
          name: child.name,
          kind: 'directory',
        });
      } else if (child.isFile() && /\.csv$/i.test(child.name)) {
        try {
          const info = await stat(path);
          entries.push({
            id: this.register({
              path,
              root: directory.root,
              parentId: id,
              kind: 'file',
            }),
            name: child.name,
            kind: 'file',
            size: info.size,
          });
        } catch (cause) {
          if (
            !(cause instanceof Error) ||
            !('code' in cause) ||
            cause.code !== 'ENOENT'
          ) {
            throw new HttpError(
              403,
              'Не удалось прочитать сведения о CSV. Проверьте доступ к папке.',
            );
          }
          // Files can disappear between listing a directory and reading their metadata.
        }
      }
    }
    entries.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'ru'),
    );
    return {
      id,
      path: directory.path,
      parentId: directory.parentId,
      roots: this.roots,
      entries,
    };
  }
}
