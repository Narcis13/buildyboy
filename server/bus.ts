import type { StreamMessage } from '../shared/types.ts';

export interface BusEntry extends StreamMessage {
  id: number;
}

type Listener = (e: BusEntry) => void;

/** In-memory pub/sub for SSE. Keeps a ring buffer so reconnecting clients can backfill from Last-Event-ID. */
export class Bus {
  private seq = 0;
  private ring: BusEntry[] = [];
  private listeners = new Set<Listener>();
  private size: number;
  constructor(size = 2000) {
    this.size = size;
  }

  publish(topic: string, type: string, data?: unknown) {
    const e: BusEntry = { id: ++this.seq, topic, type, data };
    this.ring.push(e);
    if (this.ring.length > this.size) this.ring.splice(0, this.ring.length - this.size);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // a broken listener must not break publishing
      }
    }
  }

  since(id: number): BusEntry[] | null {
    if (this.ring.length === 0 || id >= this.seq) return [];
    if (this.ring[0].id > id + 1) return null; // gap: client must refetch everything
    return this.ring.filter((e) => e.id > id);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get lastId() {
    return this.seq;
  }
}
