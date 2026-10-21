import {
  ArrowLeft,
  FileText,
  Folder,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MarketRepository } from '../application/market-repository';
import type { DirectoryListing, SourceFile } from '../domain/market';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface SourcePickerProps {
  open: boolean;
  repository: MarketRepository;
  onOpenChange: (open: boolean) => void;
  onSelect: (file: SourceFile) => void;
}

export function readableFileSize(bytes: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} МБ`;
}

export function SourcePicker({
  open,
  repository,
  onOpenChange,
  onSelect,
}: SourcePickerProps) {
  const [directory, setDirectory] = useState<{ id?: string }>({});
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    repository
      .listSources(directory.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setListing(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Не удалось открыть папку.',
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, repository, directory]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="source-dialog">
        <DialogHeader>
          <DialogTitle>Выберите CSV с компьютера</DialogTitle>
          <DialogDescription>
            Исходный файл останется в своей папке. Приложение прочитает его с
            диска.
          </DialogDescription>
        </DialogHeader>
        {listing && (
          <nav className="source-roots" aria-label="Доступные папки">
            {listing.roots.map((root) => (
              <Button
                key={root.id}
                type="button"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => setDirectory({ id: root.id })}
              >
                <Folder size={13} />
                {root.name}
              </Button>
            ))}
          </nav>
        )}
        <div className="source-location">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="На папку выше"
            disabled={loading || !listing?.parentId}
            onClick={() => setDirectory({ id: listing?.parentId })}
          >
            <ArrowLeft size={15} />
          </Button>
          <span title={listing?.path}>
            {listing?.path ?? 'Доступные файлы'}
          </span>
        </div>
        <div className="source-list" aria-busy={loading}>
          {loading ? (
            <div className="source-message" role="status">
              <LoaderCircle size={18} className="animate-spin" />
              Читаем папку…
            </div>
          ) : error ? (
            <div className="source-message">
              <p className="form-error" role="alert">
                {error}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDirectory((current) => ({ ...current }))}
              >
                <RefreshCw size={14} />
                Повторить
              </Button>
            </div>
          ) : listing?.entries.length ? (
            <ul>
              {listing.entries.map((entry) => (
                <li key={entry.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="source-entry"
                    onClick={() => {
                      if (entry.kind === 'directory')
                        setDirectory({ id: entry.id });
                      else {
                        onSelect(entry);
                        onOpenChange(false);
                      }
                    }}
                  >
                    {entry.kind === 'directory' ? (
                      <Folder size={17} />
                    ) : (
                      <FileText size={17} />
                    )}
                    <span title={entry.name}>{entry.name}</span>
                    <small>
                      {entry.kind === 'file'
                        ? readableFileSize(entry.size)
                        : 'Папка'}
                    </small>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="source-message">В этой папке нет CSV-файлов.</div>
          )}
        </div>
        <p className="source-help">
          Показаны только CSV и папки. Другие папки с историей можно добавить в{' '}
          <code>dataDirectories</code> файла <code>terminal.config.json</code>.
        </p>
      </DialogContent>
    </Dialog>
  );
}
