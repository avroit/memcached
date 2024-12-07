import { InMemoryCached } from "./mod.ts";
import { assertEquals, assertThrows } from "@std/assert";

Deno.test("InMemoryCached should store and retrieve values", async () => {
  const cache = new InMemoryCached();
  cache.set("key1", "value1");
  assertEquals(await cache.get("key1"), "value1");
});

Deno.test(
  "InMemoryCached should return undefined for non-existent keys",
  async () => {
    const cache = new InMemoryCached();
    assertEquals(await cache.get("nonExistentKey"), null);
  }
);

Deno.test("InMemoryCached should overwrite existing values", async () => {
  const cache = new InMemoryCached();
  cache.set("key1", "value1");
  cache.set("key1", "value2");
  assertEquals(await cache.get("key1"), "value2");
});

Deno.test("InMemoryCached should delete values", async () => {
  const cache = new InMemoryCached();
  cache.set("key1", "value1");
  cache.delete("key1");
  assertEquals(await cache.get("key1"), null);
});

Deno.test("InMemoryCached should store and retrieve values", async () => {
  const cache = new InMemoryCached();
  cache.set("key1", "value1");
  assertEquals(await cache.get("key1"), "value1");
});

Deno.test(
  "InMemoryCached should return undefined for non-existent keys",
  async () => {
    const cache = new InMemoryCached();
    assertEquals(await cache.get("nonExistentKey"), null);
  }
);

Deno.test("InMemoryCached should overwrite existing values", async () => {
  const cache = new InMemoryCached();
  cache.set("key1", "value1");
  cache.set("key1", "value2");
  assertEquals(await cache.get("key1"), "value2");
});

Deno.test("InMemoryCached should delete values", async () => {
  const cache = new InMemoryCached();
  cache.set("key1", "value1");
  cache.delete("key1");
  assertEquals(await cache.get("key1"), null);
});

Deno.test("InMemoryCached should clear all values", async () => {
  const cache = new InMemoryCached();
  cache.set("key1", "value1");
  cache.set("key2", "value2");
  cache.flush();
  assertEquals(await cache.get("key1"), null);
  assertEquals(await cache.get("key2"), null);
});

Deno.test("InMemoryCached should handle expiration of values", async () => {
  const cache = new InMemoryCached();
  cache.set("key1", "value1", 1); // 1 second expiration
  await new Promise((resolve) => setTimeout(resolve, 1500)); // wait for 1.5 seconds
  assertEquals(await cache.get("key1"), null);
});
