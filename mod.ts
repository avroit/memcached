abstract class MemcachedClient {
  abstract get(key: string): Promise<string | null>;
  abstract set(key: string, value: string, lifetime?: number): Promise<boolean>;
  abstract replace(
    key: string,
    value: string,
    lifetime?: number
  ): Promise<boolean>;
  abstract delete(key: string): Promise<boolean>;
  abstract flush(): Promise<boolean>;
  abstract add(key: string, value: string, lifetime?: number): Promise<boolean>;
  abstract append(key: string, value: string): Promise<boolean>;
  abstract prepend(key: string, value: string): Promise<boolean>;
  abstract incr(key: string, value: number): Promise<number>;
  abstract decr(key: string, value: number): Promise<number>;
  abstract stats(): Promise<string[]>;
  abstract closeAll(): void;
}

export class Memcached implements MemcachedClient {
  private static ENDING_LINES = new Set([
    "END",
    "STORED",
    "NOT_STORED",
    "EXISTS",
    "NOT_FOUND",
    "DELETED",
    "OK",
  ]);
  private port?: number;
  private hostname: string;
  private maxBufferSize: number;
  private isUnixSocket: boolean;
  private pool: Deno.Conn[] = [];
  private poolSize: number;
  private que: Array<[(conn: Deno.Conn) => void, (reason: unknown) => void]> =
    [];
  private defaultQueTimeout: number;

  constructor(options: {
    host: string;
    port?: number;
    maxBufferSize?: number;
    poolSize?: number;
    defaultQueTimeout?: number;
  }) {
    const {
      port,
      host,
      maxBufferSize = 2048,
      poolSize = 10,
      defaultQueTimeout = -Infinity,
    } = options;

    if (!port && !host) {
      throw new Error("Expected port or hostname");
    }

    this.hostname = host;
    this.port = port;
    this.isUnixSocket = host.endsWith(".sock");

    if (!this.isUnixSocket && !port) {
      throw new Error("Expected port");
    }

    this.maxBufferSize = maxBufferSize;
    this.poolSize = poolSize;
    this.defaultQueTimeout = defaultQueTimeout;
  }

  private async createConnection(): Promise<Deno.Conn> {
    return this.isUnixSocket
      ? await Deno.connect({ path: this.hostname, transport: "unix" })
      : await Deno.connect({ hostname: this.hostname, port: this.port! });
  }

  private getConnection(
    timeout: number = this.defaultQueTimeout
  ): Promise<Deno.Conn> {
    if (this.pool.length > 0) {
      return Promise.resolve(this.pool.pop()!);
    }

    if (this.pool.length + this.que.length < this.poolSize) {
      return this.createConnection();
    }

    const { promise, resolve, reject } = Promise.withResolvers<Deno.Conn>();

    if (timeout > 0) {
      const t = setTimeout(() => {
        reject(
          new Error(
            `Connection in QUE timeout: Pool size=${this.poolSize}, Queue length=${this.que.length}`
          )
        );
      }, timeout);
      promise.finally(() => clearTimeout(t));
    }

    this.que.push([resolve, reject]);

    return promise;
  }

  private releaseConnection(conn: Deno.Conn): void {
    if (this.que.length > 0) {
      // Resolve the next queued request with this connection
      const item = this.que.shift();
      if (item) {
        const [resolve] = item;
        resolve(conn);
        return;
      }
    }

    if (this.pool.length < this.poolSize) {
      // Add connection back to the pool if there's room
      this.pool.push(conn);
    } else {
      // Otherwise, close the connection
      conn.close();
    }
  }

  private async request(command: string, timeout?: number): Promise<string> {
    const connection = await this.getConnection(timeout);
    try {
      const buffer = new Uint8Array(this.maxBufferSize);
      let totalBytesRead = 0;
      let partial = "";
      const lines: string[] = [];

      // Write the command to the server
      await connection.write(new TextEncoder().encode(command));

      readLoop: while (true) {
        const bytesRead = await connection.read(buffer);
        if (bytesRead === null) break; // EOF

        const chunkStr = new TextDecoder().decode(
          buffer.subarray(0, bytesRead)
        );

        totalBytesRead += bytesRead;
        partial += chunkStr;

        // Check line by line to see if we reached "EN"
        const parts = partial.split("\r\n");
        partial = parts.pop()!;

        // Process complete line
        for (const line of parts) {
          lines.push(line);
          if (
            Memcached.ENDING_LINES.has(line) ||
            command.startsWith("incr") ||
            command.startsWith("decr")
          ) {
            // We've reached the end, stop reading
            partial = ""; // No need to keep partial anymore
            break readLoop; // break out of the read loop
          }
        }

        // If any line starts with "EN", Or we are ending lines, stop reading
        if (
          lines.some((l) => l.startsWith("EN") || Memcached.ENDING_LINES.has(l))
        ) {
          break readLoop;
        }

        // Check for a maximum size limit
        if (totalBytesRead >= this.maxBufferSize) {
          throw new Error("Response exceeds maximum buffer size.");
        }
      }

      return [...lines, partial].filter(Boolean).join("\r\n");
    } finally {
      this.releaseConnection(connection);
    }
  }

  closeAll(): void {
    // Close all active connections in the pool
    while (this.pool.length > 0) {
      const conn = this.pool.pop();
      if (conn) conn.close();
    }

    // Gracefully reject all queued requests
    this.que.forEach(([, r]) => r(new Error("Connection closing")));
    // Clear the request queue
    this.que = [];
  }

  async get(key: string): Promise<string | null> {
    const response = await this.request(`get ${key}\r\n`);
    if (response.startsWith("VALUE")) {
      const [, value] = response.split("\r\n");
      return value;
    }
    return null;
  }

  async set(
    key: string,
    value: string,
    lifetime: number = 30,
    timeout?: number
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    const command = `set ${key} 0 ${lifetime} ${value.length}\r\n${value}\r\n`;
    const response = await this.request(command, timeout);
    if (!response.startsWith("STORED")) {
      return Promise.reject(new Error(`Failed to set key: ${response}`));
    }
    return true;
  }

  async replace(
    key: string,
    value: string,
    lifetime: number = 30,
    timeout?: number
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    const command = `replace ${key} 0 ${lifetime} ${value.length}\r\n${value}\r\n`;
    const response = await this.request(command, timeout);
    if (!response.startsWith("STORED")) {
      return Promise.reject(new Error(`Failed to replace key: ${response}`));
    }
    return true;
  }

  async delete(key: string, timeout?: number): Promise<boolean> {
    const response = await this.request(`delete ${key}\r\n`, timeout);
    if (!response.startsWith("DELETED")) {
      return Promise.reject(new Error(`Failed to delete key: ${response}`));
    }
    return true;
  }

  async flush(timeout?: number): Promise<boolean> {
    const response = await this.request("flush_all\r\n", timeout);
    if (!response.startsWith("OK")) {
      return Promise.reject(new Error(`Failed to flush: ${response}`));
    }
    return true;
  }

  async add(
    key: string,
    value: string,
    lifetime: number = 30,
    timeout?: number
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    const command = `add ${key} 0 ${lifetime} ${value.length}\r\n${value}\r\n`;
    const response = await this.request(command, timeout);
    if (!response.startsWith("STORED")) {
      return Promise.reject(new Error(`Failed to add key: ${response}`));
    }
    return true;
  }

  async append(key: string, value: string, timeout?: number): Promise<boolean> {
    const command = `append ${key} 0 0 ${value.length}\r\n${value}\r\n`;
    const response = await this.request(command, timeout);
    if (!response.startsWith("STORED")) {
      return Promise.reject(new Error(`Failed to append to key: ${response}`));
    }
    return true;
  }

  async prepend(
    key: string,
    value: string,
    timeout?: number
  ): Promise<boolean> {
    const command = `prepend ${key} 0 0 ${value.length}\r\n${value}\r\n`;
    const response = await this.request(command, timeout);
    if (!response.startsWith("STORED")) {
      return Promise.reject(new Error(`Failed to prepend to key: ${response}`));
    }
    return true;
  }

  async incr(key: string, value: number, timeout?: number): Promise<number> {
    const command = `incr ${key} ${value}\r\n`;
    const response = await this.request(command, timeout);
    const result = parseInt(response.trim(), 10);
    if (isNaN(result)) {
      return Promise.reject(new Error(`Failed to increment key: ${response}`));
    }
    return result;
  }

  async decr(key: string, value: number, timeout?: number): Promise<number> {
    const command = `decr ${key} ${value}\r\n`;
    const response = await this.request(command, timeout);
    const result = parseInt(response.trim(), 10);
    if (isNaN(result)) {
      return Promise.reject(new Error(`Failed to decrement key: ${response}`));
    }
    return result;
  }

  async stats(timeout?: number): Promise<string[]> {
    const response = await this.request("stats\r\n", timeout);
    return response.split("\r\n").filter((line) => line && line !== "END");
  }
}

export class InMemoryCached extends MemcachedClient {
  override closeAll(): void {
    console.warn("InMemoryCached.closeAll() is a no-op");
  }
  private store: Map<string, { value: string; expiresAt: number }> = new Map();

  override async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (entry && (entry.expiresAt === 0 || entry.expiresAt > Date.now())) {
      return entry.value;
    }
    await this.store.delete(key);
    return null;
  }

  override async set(
    key: string,
    value: string,
    lifetime: number = 30
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    const expiresAt = lifetime > 0 ? Date.now() + lifetime * 1_000 : 0;
    await this.store.set(key, { value, expiresAt });
    return true;
  }

  override async replace(
    key: string,
    value: string,
    lifetime: number = 30
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    if (!this.store.has(key)) {
      return Promise.reject(new Error(`Key not found: ${key}`));
    }
    await this.set(key, value, lifetime);
    return true;
  }

  override async delete(key: string): Promise<boolean> {
    await this.store.delete(key);
    return true;
  }

  override async flush(): Promise<boolean> {
    await this.store.clear();
    return true;
  }

  override async add(
    key: string,
    value: string,
    lifetime: number = 30
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    if (this.store.has(key)) {
      return Promise.reject(new Error(`Key already exists: ${key}`));
    }
    await this.set(key, value, lifetime);
    return true;
  }

  override async append(key: string, value: string): Promise<boolean> {
    const existingValue = await this.get(key);
    if (existingValue === null) {
      return Promise.reject(new Error(`Key not found: ${key}`));
    }
    await this.set(key, existingValue + value, 0);
    return true;
  }

  override async prepend(key: string, value: string): Promise<boolean> {
    const existingValue = await this.get(key);
    if (existingValue === null) {
      return Promise.reject(new Error(`Key not found: ${key}`));
    }
    await this.set(key, value + existingValue, 0);
    return true;
  }

  override async incr(key: string, value: number): Promise<number> {
    const existingValue = await this.get(key);
    if (existingValue === null) {
      return Promise.reject(new Error(`Key not found: ${key}`));
    }
    const newValue = parseInt(existingValue, 10) + value;
    await this.set(key, newValue.toString(), 0);
    return newValue;
  }

  override async decr(key: string, value: number): Promise<number> {
    const existingValue = await this.get(key);
    if (existingValue === null) {
      return Promise.reject(new Error(`Key not found: ${key}`));
    }
    const newValue = parseInt(existingValue, 10) - value;
    await this.set(key, newValue.toString(), 0);
    return newValue;
  }

  override async stats(): Promise<string[]> {
    return await Array.from(this.store.entries()).map(
      ([key, { value, expiresAt }]) =>
        `${key}: ${value}, expires at: ${
          expiresAt === 0 ? "never" : new Date(expiresAt).toISOString()
        }`
    );
  }
}
