import { ScenarioAssertionError } from "./assertions";

export type MockWebSocketEvent = {
  type: string;
  data?: unknown;
  code?: number;
  reason?: string;
  message?: string;
};

export type MockWebSocketListener = (event: MockWebSocketEvent) => void;

export type MockWebSocketController = {
  sockets: MockWebSocket[];
  nextSocket: (index?: number) => MockWebSocket;
  latestSocket: () => MockWebSocket;
  restore: () => void;
  clear: () => void;
};

export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readonly sent: unknown[] = [];

  binaryType: BinaryType = "blob";
  readyState = MockWebSocket.CONNECTING;
  closeCalls = 0;
  closeCode: number | undefined;
  closeReason: string | undefined;

  private readonly listeners = new Map<string, Set<MockWebSocketListener>>();

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = url.toString();
    this.protocols = protocols;
  }

  addEventListener(type: string, listener: MockWebSocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<MockWebSocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: MockWebSocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.closeCalls++;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close", { code, reason });
  }

  open(): void {
    if (this.readyState !== MockWebSocket.CONNECTING) return;
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  receive(data: unknown): void {
    this.emit("message", { data });
  }

  fail(message = "Mock WebSocket error"): void {
    this.emit("error", { message });
  }

  closeFromServer(code = 1000, reason = ""): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close", { code, reason });
  }

  private emit(type: string, event: Omit<MockWebSocketEvent, "type"> = {}): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;

    for (const listener of listeners) {
      listener({ type, ...event });
    }
  }
}

export function installMockWebSocket(): MockWebSocketController {
  const websocketGlobal = globalThis as typeof globalThis & { WebSocket?: typeof WebSocket };
  const original = websocketGlobal.WebSocket;
  const sockets: MockWebSocket[] = [];
  let restored = false;

  class InstalledMockWebSocket extends MockWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this);
    }
  }

  websocketGlobal.WebSocket = InstalledMockWebSocket as unknown as typeof WebSocket;

  return {
    sockets,
    nextSocket: (index = 0) => {
      const socket = sockets[index];
      if (!socket) throw new ScenarioAssertionError(`No mock WebSocket at index ${index}`);
      return socket;
    },
    latestSocket: () => {
      const socket = sockets.at(-1);
      if (!socket) throw new ScenarioAssertionError("No mock WebSocket was created");
      return socket;
    },
    restore: () => {
      if (restored) return;
      if (original) {
        websocketGlobal.WebSocket = original;
      } else {
        Reflect.deleteProperty(websocketGlobal, "WebSocket");
      }
      restored = true;
    },
    clear: () => {
      sockets.length = 0;
    },
  };
}
