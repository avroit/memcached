abstract class MemcachedClient {
  abstract get(key: string): Promise<string | null>;
  abstract set(key: string, value: string, lifetime?: number): Promise<boolean>;
  abstract replace(
    key: string,
    value: string,
    lifetime?: number,
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

/**
 * A Memcached client implementation for Deno.
 */
export class Memcached implements MemcachedClient {
  /**
   * Set of lines that indicate the end of a response from the server.
   */
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

  /**
   * Creates an instance of Memcached.
   * @param options - Configuration options for the Memcached client.
   */
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

  /**
   * Creates a new connection to the Memcached server.
   * @returns A promise that resolves to a Deno.Conn object.
   */
  private async createConnection(): Promise<Deno.Conn> {
    return this.isUnixSocket
      ? await Deno.connect({ path: this.hostname, transport: "unix" })
      : await Deno.connect({ hostname: this.hostname, port: this.port! });
  }

  /**
   * Retrieves a connection from the pool or creates a new one if necessary.
   * @param timeout - The timeout for the connection request.
   * @returns A promise that resolves to a Deno.Conn object.
   */
  private getConnection(
    timeout: number = this.defaultQueTimeout,
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
            `Connection in QUE timeout: Pool size=${this.poolSize}, Queue length=${this.que.length}`,
          ),
        );
      }, timeout);
      promise.finally(() => clearTimeout(t));
    }

    this.que.push([resolve, reject]);

    return promise;
  }

  /**
   * Releases a connection back to the pool or closes it if the pool is full.
   * @param conn - The connection to release.
   */
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

  /**
   * Sends a command to the Memcached server and returns the response.
   * @param command - The command to send.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to the server's response.
   */
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
          buffer.subarray(0, bytesRead),
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

  /**
   * Closes all active connections in the pool and rejects all queued requests.
   */
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

  /**
   * Retrieves the value associated with the given key.
   * @param key - The key to retrieve.
   * @returns A promise that resolves to the value or null if not found.
   */
  async get(key: string): Promise<string | null> {
    const response = await this.request(`get ${key}\r\n`);
    if (response.startsWith("VALUE")) {
      const [, value] = response.split("\r\n");
      return value;
    }
    return null;
  }

  /**
   * Sets a value for the given key with an optional lifetime.
   * @param key - The key to set.
   * @param value - The value to set.
   * @param lifetime - The lifetime of the key in seconds.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to true if the operation was successful.
   */
  async set(
    key: string,
    value: string,
    lifetime: number = 30,
    timeout?: number,
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    const command = `set ${key} 0 ${lifetime} ${value.length}\r\n${value}\r\n`;
    const response = await this.request(command, timeout);
    if (!response.startsWith("STORED")) {
      return Promise.reject(new Error(`Failed to set key: ${response}`));
    }
    return true;
  }

  /**
   * Replaces the value for the given key with an optional lifetime.
   * @param key - The key to replace.
   * @param value - The value to replace.
   * @param lifetime - The lifetime of the key in seconds.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to true if the operation was successful.
   */
  async replace(
    key: string,
    value: string,
    lifetime: number = 30,
    timeout?: number,
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    const command =
      `replace ${key} 0 ${lifetime} ${value.length}\r\n${value}\r\n`;
    const response = await this.request(command, timeout);
    if (!response.startsWith("STORED")) {
      return Promise.reject(new Error(`Failed to replace key: ${response}`));
    }
    return true;
  }

  /**
   * Deletes the value associated with the given key.
   * @param key - The key to delete.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to true if the operation was successful.
   */
  async delete(key: string, timeout?: number): Promise<boolean> {
    const response = await this.request(`delete ${key}\r\n`, timeout);
    if (!response.startsWith("DELETED")) {
      return Promise.reject(new Error(`Failed to delete key: ${response}`));
    }
    return true;
  }

  /**
   * Flushes all data from the server.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to true if the operation was successful.
   */
  async flush(timeout?: number): Promise<boolean> {
    const response = await this.request("flush_all\r\n", timeout);
    if (!response.startsWith("OK")) {
      return Promise.reject(new Error(`Failed to flush: ${response}`));
    }
    return true;
  }

  /**
   * Adds a value for the given key with an optional lifetime.
   * @param key - The key to add.
   * @param value - The value to add.
   * @param lifetime - The lifetime of the key in seconds.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to true if the operation was successful.
   */
  async add(
    key: string,
    value: string,
    lifetime: number = 30,
    timeout?: number,
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    const command = `add ${key} 0 ${lifetime} ${value.length}\r\n${value}\r\n`;
    const response = await this.request(command, timeout);
    if (!response.startsWith("STORED")) {
      return Promise.reject(new Error(`Failed to add key: ${response}`));
    }
    return true;
  }

  /**
   * Appends a value to the existing value of the given key.
   * @param key - The key to append to.
   * @param value - The value to append.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to true if the operation was successful.
   */
  async append(key: string, value: string, timeout?: number): Promise<boolean> {
    const command = `append ${key} 0 0 ${value.length}\r\n${value}\r\n`;
    const response = await this.request(command, timeout);
    if (!response.startsWith("STORED")) {
      return Promise.reject(new Error(`Failed to append to key: ${response}`));
    }
    return true;
  }

  /**
   * Prepends a value to the existing value of the given key.
   * @param key - The key to prepend to.
   * @param value - The value to prepend.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to true if the operation was successful.
   */
  async prepend(
    key: string,
    value: string,
    timeout?: number,
  ): Promise<boolean> {
    const command = `prepend ${key} 0 0 ${value.length}\r\n${value}\r\n`;
    const response = await this.request(command, timeout);
    if (!response.startsWith("STORED")) {
      return Promise.reject(new Error(`Failed to prepend to key: ${response}`));
    }
    return true;
  }

  /**
   * Increments the value of the given key by the specified amount.
   * @param key - The key to increment.
   * @param value - The amount to increment by.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to the new value.
   */
  async incr(key: string, value: number, timeout?: number): Promise<number> {
    const command = `incr ${key} ${value}\r\n`;
    const response = await this.request(command, timeout);
    const result = parseInt(response.trim(), 10);
    if (isNaN(result)) {
      return Promise.reject(new Error(`Failed to increment key: ${response}`));
    }
    return result;
  }

  /**
   * Decrements the value of the given key by the specified amount.
   * @param key - The key to decrement.
   * @param value - The amount to decrement by.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to the new value.
   */
  async decr(key: string, value: number, timeout?: number): Promise<number> {
    const command = `decr ${key} ${value}\r\n`;
    const response = await this.request(command, timeout);
    const result = parseInt(response.trim(), 10);
    if (isNaN(result)) {
      return Promise.reject(new Error(`Failed to decrement key: ${response}`));
    }
    return result;
  }

  /**
   * Retrieves statistics from the server.
   * @param timeout - The timeout for the request.
   * @returns A promise that resolves to an array of statistics.
   */
  async stats(timeout?: number): Promise<string[]> {
    const response = await this.request("stats\r\n", timeout);
    return response.split("\r\n").filter((line) => line && line !== "END");
  }
}

/**
 * InMemoryCached is an in-memory implementation of a Memcached client.
 * It extends the MemcachedClient class and overrides its methods to provide
 * in-memory caching functionality. This is so that you can develop locally
 * and not worry about a Memcached server.
 */
export class InMemoryCached extends MemcachedClient {
  /**
   * Overrides the closeAll method to provide a no-op implementation.
   * This method does nothing in the in-memory cache.
   */
  override closeAll(): void {
    console.warn("InMemoryCached.closeAll() is a no-op");
  }

  private store: Map<string, { value: string; expiresAt: number }> = new Map();

  /**
   * Retrieves the value associated with the given key.
   * @param key - The key to retrieve the value for.
   * @returns A promise that resolves to the value associated with the key, or null if the key does not exist or has expired.
   */
  override async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (entry && (entry.expiresAt === 0 || entry.expiresAt > Date.now())) {
      return entry.value;
    }
    await this.store.delete(key);
    return null;
  }

  /**
   * Sets the value for the given key with an optional lifetime.
   * @param key - The key to set the value for.
   * @param value - The value to set.
   * @param lifetime - The lifetime of the key in seconds. Defaults to 30 seconds.
   * @returns A promise that resolves to true when the value is set.
   */
  override async set(
    key: string,
    value: string,
    lifetime: number = 30,
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    const expiresAt = lifetime > 0 ? Date.now() + lifetime * 1_000 : 0;
    await this.store.set(key, { value, expiresAt });
    return true;
  }

  /**
   * Replaces the value for the given key if it exists.
   * @param key - The key to replace the value for.
   * @param value - The new value to set.
   * @param lifetime - The lifetime of the key in seconds. Defaults to 30 seconds.
   * @returns A promise that resolves to true when the value is replaced, or rejects if the key does not exist.
   */
  override async replace(
    key: string,
    value: string,
    lifetime: number = 30,
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    if (!this.store.has(key)) {
      return Promise.reject(new Error(`Key not found: ${key}`));
    }
    await this.set(key, value, lifetime);
    return true;
  }

  /**
   * Deletes the value associated with the given key.
   * @param key - The key to delete the value for.
   * @returns A promise that resolves to true when the value is deleted.
   */
  override async delete(key: string): Promise<boolean> {
    await this.store.delete(key);
    return true;
  }

  /**
   * Clears all values from the cache.
   * @returns A promise that resolves to true when the cache is cleared.
   */
  override async flush(): Promise<boolean> {
    await this.store.clear();
    return true;
  }

  /**
   * Adds a value for the given key if it does not already exist.
   * @param key - The key to add the value for.
   * @param value - The value to add.
   * @param lifetime - The lifetime of the key in seconds. Defaults to 30 seconds.
   * @returns A promise that resolves to true when the value is added, or rejects if the key already exists.
   */
  override async add(
    key: string,
    value: string,
    lifetime: number = 30,
  ): Promise<boolean> {
    lifetime = Math.max(1, lifetime);
    if (this.store.has(key)) {
      return Promise.reject(new Error(`Key already exists: ${key}`));
    }
    await this.set(key, value, lifetime);
    return true;
  }

  /**
   * Appends a value to the existing value for the given key.
   * @param key - The key to append the value to.
   * @param value - The value to append.
   * @returns A promise that resolves to true when the value is appended, or rejects if the key does not exist.
   */
  override async append(key: string, value: string): Promise<boolean> {
    const existingValue = await this.get(key);
    if (existingValue === null) {
      return Promise.reject(new Error(`Key not found: ${key}`));
    }
    await this.set(key, existingValue + value, 0);
    return true;
  }

  /**
   * Prepends a value to the existing value for the given key.
   * @param key - The key to prepend the value to.
   * @param value - The value to prepend.
   * @returns A promise that resolves to true when the value is prepended, or rejects if the key does not exist.
   */
  override async prepend(key: string, value: string): Promise<boolean> {
    const existingValue = await this.get(key);
    if (existingValue === null) {
      return Promise.reject(new Error(`Key not found: ${key}`));
    }
    await this.set(key, value + existingValue, 0);
    return true;
  }

  /**
   * Increments the numeric value for the given key by the specified value.
   * @param key - The key to increment the value for.
   * @param value - The value to increment by.
   * @returns A promise that resolves to the new value after incrementing, or rejects if the key does not exist.
   */
  override async incr(key: string, value: number): Promise<number> {
    const existingValue = await this.get(key);
    if (existingValue === null) {
      return Promise.reject(new Error(`Key not found: ${key}`));
    }
    const newValue = parseInt(existingValue, 10) + value;
    await this.set(key, newValue.toString(), 0);
    return newValue;
  }

  /**
   * Decrements the numeric value for the given key by the specified value.
   * @param key - The key to decrement the value for.
   * @param value - The value to decrement by.
   * @returns A promise that resolves to the new value after decrementing, or rejects if the key does not exist.
   */
  override async decr(key: string, value: number): Promise<number> {
    const existingValue = await this.get(key);
    if (existingValue === null) {
      return Promise.reject(new Error(`Key not found: ${key}`));
    }
    const newValue = parseInt(existingValue, 10) - value;
    await this.set(key, newValue.toString(), 0);
    return newValue;
  }

  /**
   * Retrieves statistics about the cache.
   * @returns A promise that resolves to an array of strings containing the key, value, and expiration time for each entry in the cache.
   */
  override async stats(): Promise<string[]> {
    return await Array.from(this.store.entries()).map(
      ([key, { value, expiresAt }]) =>
        `${key}: ${value}, expires at: ${
          expiresAt === 0 ? "never" : new Date(expiresAt).toISOString()
        }`,
    );
  }
}
