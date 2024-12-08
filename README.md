# Memcached Client for Deno

This repository provides two classes that implement a Memcached-like API in Deno:

1. **Memcached**: A client for interacting with a real Memcached server.
2. **InMemoryCached**: An in-memory implementation that follows the same interface as the `Memcached` client, useful for local development or testing without relying on a Memcached server.

Both classes implement the `MemcachedClient` abstract class, ensuring a consistent API.

## Features

- **TypeScript-first**: Written in TypeScript for improved safety and clarity.
- **Consistent API**: Both `Memcached` (real server) and `InMemoryCached` (in-memory) share the same methods and interface.
- **Promise-based**: All methods return Promises for clean asynchronous operations.
- **Pool Management**: The `Memcached` class manages a pool of connections to optimize performance.

## Getting Started

### Prerequisites

- [Deno](https://deno.com/)
- A running Memcached server (if you plan to use the `Memcached` class).

### Installation

```bash
deno add jsr:@avroit/memecached
```

You can import directly from your code using a URL that points to your versioned file. For example:

```typescript
import { Memcached, InMemoryCached } from "@avroit/memecached";
```

_(Replace the URL with the actual location where your code is hosted.)_

## Usage

### 1. Connecting to a Memcached Server

```typescript
import { Memcached } from "@avroit/memecached";

async function main() {
  const client = new Memcached({
    host: "127.0.0.1",
    port: 11211,
  });

  // Set a value
  await client.set("username", "alice", 60); // Expires in 60 seconds

  // Retrieve the value
  const value = await client.get("username");
  console.log(value); // "alice"

  // Increment a numeric value
  await client.set("counter", "10");
  const newValue = await client.incr("counter", 5); // returns 15
  console.log(newValue); // 15

  // Delete the value
  await client.delete("username");

  // Close all connections
  client.closeAll();
}

main();
```

### 2. Using the In-Memory Implementation

`InMemoryCached` is ideal for testing or local development without a running Memcached server. It uses an in-memory `Map` to store data.

```typescript
import { InMemoryCached } from "./memcached.ts";

async function testInMemory() {
  const client = new InMemoryCached();

  // Set a value with a 30-second lifetime (default)
  await client.set("greeting", "hello world");

  // Retrieve the value
  const greeting = await client.get("greeting");
  console.log(greeting); // "hello world"

  // Add a value that doesn't exist yet
  await client.add("newKey", "newValue");

  // Attempting to add again will fail
  try {
    await client.add("newKey", "anotherValue");
  } catch (error) {
    console.error(error.message); // "Key already exists: newKey"
  }

  // Increment and decrement numeric values
  await client.set("score", "100");
  await client.incr("score", 10); // now 110
  await client.decr("score", 5); // now 105

  // Flush all data
  await client.flush();
}

testInMemory();
```

## API Reference

Both `Memcached` and `InMemoryCached` implement the following methods:

- `get(key: string): Promise<string | null>`

  - Retrieves the value for the given key. Returns `null` if not found.

- `set(key: string, value: string, lifetime?: number): Promise<boolean>`

  - Stores a value for the given key. Optionally specify a `lifetime` (in seconds). Returns `true` on success.

- `replace(key: string, value: string, lifetime?: number): Promise<boolean>`

  - Replaces the value for an existing key. Fails if the key does not exist.

- `delete(key: string): Promise<boolean>`

  - Deletes the specified key. Returns `true` on success.

- `flush(): Promise<boolean>`

  - Flushes all data from the cache/memcached server. Returns `true` on success.

- `add(key: string, value: string, lifetime?: number): Promise<boolean>`

  - Adds a new key-value pair only if the key does not already exist. Returns `true` on success.

- `append(key: string, value: string): Promise<boolean>`

  - Appends the given value to the existing value of the key. Fails if the key does not exist.

- `prepend(key: string, value: string): Promise<boolean>`

  - Prepends the given value to the existing value of the key. Fails if the key does not exist.

- `incr(key: string, value: number): Promise<number>`

  - Increments the numeric value stored at `key` by `value`. Fails if the key does not exist or the value is non-numeric.

- `decr(key: string, value: number): Promise<number>`

  - Decrements the numeric value stored at `key` by `value`. Fails if the key does not exist or the value is non-numeric.

- `stats(): Promise<string[]>`

  - Retrieves server or cache statistics. For `InMemoryCached`, this returns information about in-memory entries.

- `closeAll(): void`
  - Closes all active connections (for `Memcached`). For `InMemoryCached`, this is a no-op.

## Error Handling

Most methods will reject their promises with an `Error` if the operation fails. For instance:

- Trying to `replace` a key that doesn’t exist.
- Trying to `add` a key that already exists.
- Attempting `append` or `prepend` on a nonexistent key.

Use `try/catch` blocks or `.catch()` for proper error handling.

## Timeouts

The `Memcached` class supports optional timeouts on individual operations. If an operation takes too long, it will reject with a timeout error. You can specify a timeout as the last argument to methods like `set`, `get`, `delete`, etc.

Example:

```typescript
await client.set("foo", "bar", 30 /* lifetime */, 1000 /* 1s timeout */);
```

If the server does not respond within 1 second, the promise rejects.

_(For `InMemoryCached`, timeouts are not simulated, but the interface still accepts the parameter for compatibility.)_

## Testing & Development

Use `InMemoryCached` in tests for a fast and isolated environment:

```typescript
// example_test.ts

import { InMemoryCached } from "./memcached.ts";
import { assertEquals } from "@std/assert";

Deno.test("in-memory set/get", async () => {
  const client = new InMemoryCached();
  await client.set("testKey", "testValue");
  const value = await client.get("testKey");
  assertEquals(value, "testValue");
});
```

Run tests:

```bash
deno test
```

## Contributing

- Fork the repository and create a new branch for your feature or bugfix.
- Write and run tests before submitting a pull request.
- Ensure your code is properly formatted (`deno fmt`) and linted (`deno lint`).

## License

This project is licensed under the [Creative Commons Legal Code](LICENSE).
