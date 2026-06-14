export interface IRegistryStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): void | Thenable<void>;
}

export class LiveSessionRegistry {
  private static readonly KEY = 'liveSessionIds';

  private _ids: string[];
  private readonly _listeners: Array<(ids: string[]) => void> = [];

  constructor(private readonly _storage: IRegistryStorage) {
    this._ids = _storage.get<string[]>(LiveSessionRegistry.KEY) ?? [];
  }

  add(sessionId: string): void {
    if (this._ids.includes(sessionId)) {
      return;
    }
    this._ids = [...this._ids, sessionId];
    void this._storage.update(LiveSessionRegistry.KEY, [...this._ids]);
    this._notify();
  }

  remove(sessionId: string): void {
    const next = this._ids.filter(id => id !== sessionId);
    if (next.length === this._ids.length) {
      return;
    }
    this._ids = next;
    void this._storage.update(LiveSessionRegistry.KEY, [...this._ids]);
    this._notify();
  }

  getIds(): string[] {
    return [...this._ids];
  }

  onDidChange(listener: (ids: string[]) => void): { dispose(): void } {
    this._listeners.push(listener);
    return {
      dispose: () => {
        const i = this._listeners.indexOf(listener);
        if (i >= 0) {
          this._listeners.splice(i, 1);
        }
      },
    };
  }

  dispose(): void {
    this._listeners.length = 0;
  }

  private _notify(): void {
    const ids = this.getIds();
    for (const l of [...this._listeners]) {
      l(ids);
    }
  }
}
