import { assert, assertEquals, assertRejects } from "@std/assert";
import { Memcached } from "./mod.ts";

const opts = {
  host: "0.0.0.0",
  port: 11211,
  poolSize: 1,
};

Deno.test("Memcached: flush", async () => {
  const memcached = new Memcached(opts);
  assert(await memcached.flush());
  memcached.closeAll();
});

Deno.test("Memcached: set and get", async () => {
  const memcached = new Memcached(opts);
  await memcached.set("key", "value");
  const result = await memcached.get("key");
  assertEquals(result, "value");
  memcached.closeAll();
});

Deno.test("Memcached: delete", async () => {
  const memcached = new Memcached(opts);
  await memcached.set("key", "value");
  await memcached.delete("key");
  const result = await memcached.get("key");
  assertEquals(result, null);
  memcached.closeAll();
});

Deno.test("Memcached: incr", async () => {
  const memcached = new Memcached(opts);
  await memcached.set("counter", `1`);
  await memcached.incr("counter", 1);
  await memcached.incr("counter", 1);
  const result = await memcached.get("counter");
  assertEquals(+result!, 3);
  memcached.closeAll();
});

Deno.test("Memcached: decr", async () => {
  const memcached = new Memcached(opts);
  await memcached.set("counter", `2`);
  await memcached.decr("counter", 1);
  const result = await memcached.get("counter");
  assertEquals(+result!, 1);
  memcached.closeAll();
});

Deno.test("Memcached: add", async () => {
  const memcached = new Memcached(opts);
  const addResult = await memcached.add("new_key", "new_value");
  assertEquals(addResult, true);
  const result = await memcached.get("new_key");
  assertEquals(result, "new_value");

  assertRejects(
    () => memcached.add("new_key", "new_value"),
    Error,
    `Failed to add key: NOT_STORED`
  ).finally(memcached.closeAll.bind(memcached));
});

Deno.test("Memcached replace", async () => {
  const memcached = new Memcached(opts);
  await memcached.set("replace_key", "old_value");
  const replaceResult = await memcached.replace("replace_key", "new_value");
  assertEquals(Boolean(replaceResult), true);
  const result = await memcached.get("replace_key");
  assertEquals(result, "new_value");
  memcached.closeAll();
});

Deno.test("Memcached append", async () => {
  const memcached = new Memcached(opts);
  await memcached.set("append_key", "value");
  const appendResult = await memcached.append("append_key", "_appended");
  assertEquals(appendResult, true);
  const result = await memcached.get("append_key");
  assertEquals(result, "value_appended");
  memcached.closeAll();
});

Deno.test("Memcached prepend", async () => {
  const memcached = new Memcached(opts);
  await memcached.set("prepend_key", "value");
  const prependResult = await memcached.prepend("prepend_key", "prepended_");
  assertEquals(prependResult, true);
  const result = await memcached.get("prepend_key");
  assertEquals(result, "prepended_value");
  memcached.closeAll();
});
