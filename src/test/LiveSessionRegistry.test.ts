import { describe, it, expect, beforeEach } from 'vitest';
import { LiveSessionRegistry } from '../LiveSessionRegistry';

function makeStorage(initial: string[] = []) {
  const store: Record<string, unknown> = { liveSessionIds: initial };
  return {
    get: <T>(key: string) => store[key] as T | undefined,
    update: (key: string, value: unknown) => { store[key] = value; },
  };
}

describe('LiveSessionRegistry', () => {
  let storage: ReturnType<typeof makeStorage>;
  let registry: LiveSessionRegistry;

  beforeEach(() => {
    storage = makeStorage();
    registry = new LiveSessionRegistry(storage);
  });

  it('starts empty when storage is empty', () => {
    expect(registry.getIds()).toEqual([]);
  });

  it('loads persisted ids from storage on construction', () => {
    const s = makeStorage(['aaa', 'bbb']);
    const r = new LiveSessionRegistry(s);
    expect(r.getIds()).toEqual(['aaa', 'bbb']);
  });

  it('add appends a new id', () => {
    registry.add('aaa');
    expect(registry.getIds()).toEqual(['aaa']);
  });

  it('add is idempotent — does not duplicate', () => {
    registry.add('aaa');
    registry.add('aaa');
    expect(registry.getIds()).toEqual(['aaa']);
  });

  it('add persists to storage', () => {
    registry.add('aaa');
    expect(storage.get<string[]>('liveSessionIds')).toEqual(['aaa']);
  });

  it('remove deletes an existing id', () => {
    registry.add('aaa');
    registry.add('bbb');
    registry.remove('aaa');
    expect(registry.getIds()).toEqual(['bbb']);
  });

  it('remove is a no-op for unknown id', () => {
    registry.add('aaa');
    registry.remove('zzz');
    expect(registry.getIds()).toEqual(['aaa']);
  });

  it('remove persists to storage', () => {
    registry.add('aaa');
    registry.add('bbb');
    registry.remove('aaa');
    expect(storage.get<string[]>('liveSessionIds')).toEqual(['bbb']);
  });

  it('onDidChange fires on add with new ids', () => {
    const received: string[][] = [];
    registry.onDidChange(ids => received.push(ids));
    registry.add('aaa');
    expect(received).toEqual([['aaa']]);
  });

  it('onDidChange fires on remove with new ids', () => {
    registry.add('aaa');
    registry.add('bbb');
    const received: string[][] = [];
    registry.onDidChange(ids => received.push(ids));
    registry.remove('aaa');
    expect(received).toEqual([['bbb']]);
  });

  it('onDidChange does NOT fire when add is a duplicate', () => {
    registry.add('aaa');
    const received: string[][] = [];
    registry.onDidChange(ids => received.push(ids));
    registry.add('aaa');
    expect(received).toEqual([]);
  });

  it('onDidChange does NOT fire when remove targets unknown id', () => {
    registry.add('aaa');
    const received: string[][] = [];
    registry.onDidChange(ids => received.push(ids));
    registry.remove('zzz');
    expect(received).toEqual([]);
  });

  it('disposed listener is not called', () => {
    const received: string[][] = [];
    const sub = registry.onDidChange(ids => received.push(ids));
    sub.dispose();
    registry.add('aaa');
    expect(received).toEqual([]);
  });

  it('getIds returns a copy — mutation does not affect registry', () => {
    registry.add('aaa');
    const ids = registry.getIds();
    ids.push('injected');
    expect(registry.getIds()).toEqual(['aaa']);
  });
});
