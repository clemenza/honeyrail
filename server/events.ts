import type { EventInput, GatewayEvent, Store } from "./types.js";

type EventCallback = (event: GatewayEvent) => void;

export class EventBus {
  private subscribers: Set<EventCallback>;

  constructor() {
    this.subscribers = new Set();
  }

  subscribe(callback: EventCallback) {
    this.subscribers.add(callback);
    return () => { this.subscribers.delete(callback); };
  }

  publish(event: GatewayEvent) {
    for (const callback of this.subscribers) {
      try {
        callback(event);
      } catch (error) {
        console.error("Error in event subscriber:", error);
      }
    }
  }
}

export async function publishEvent(store: Store, bus: EventBus, input: EventInput): Promise<GatewayEvent> {
  const event = await store.appendEvent(input);
  bus.publish(event);
  return event;
}
