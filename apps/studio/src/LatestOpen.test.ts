import { describe, expect, it } from "vitest";
import { createLatestOpen } from "./LatestOpen";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("createLatestOpen", () => {
  it("lets a newer open win even when the older (demo) open completes last", async () => {
    const disposed: string[] = [];
    const gate = createLatestOpen<string>((stale) => { disposed.push(stale); });
    const demo = deferred<string>();
    const user = deferred<string>();
    const demoRun = gate.start(() => demo.promise);
    const userRun = gate.start(() => user.promise);
    user.resolve("golden-home");
    expect(await userRun).toEqual({ status: "current", value: "golden-home" });
    demo.resolve("21D");
    expect(await demoRun).toEqual({ status: "superseded" });
    expect(disposed).toEqual(["21D"]);
  });

  it("aborts the older request's signal when a newer one starts", async () => {
    const gate = createLatestOpen<string>(() => {});
    let first: AbortSignal | undefined;
    const a = gate.start((signal) => { first = signal; return new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))); });
    const b = gate.start(async () => "b");
    expect(first?.aborted).toBe(true);
    expect(await a).toEqual({ status: "superseded" });
    expect(await b).toEqual({ status: "current", value: "b" });
  });

  it("swallows a superseded failure but surfaces the current one", async () => {
    const gate = createLatestOpen<string>(() => {});
    const old = deferred<string>();
    const oldRun = gate.start(() => old.promise);
    const failing = gate.start(async () => { throw new Error("current failed"); });
    old.reject(new Error("stale failed"));
    expect(await oldRun).toEqual({ status: "superseded" });
    await expect(failing).rejects.toThrow("current failed");
  });

  it("reports pending for the latest request only and clears it when the latest settles", async () => {
    const seen: boolean[] = [];
    const gate = createLatestOpen<string>(() => {}, (p) => seen.push(p));
    const first = deferred<string>();
    const second = deferred<string>();
    const a = gate.start(() => first.promise);
    const b = gate.start(() => second.promise);
    first.resolve("a");
    await a;
    expect(gate.pending()).toBe(true);
    second.resolve("b");
    await b;
    expect(gate.pending()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("disposes a result that completes after cancelAll", async () => {
    const disposed: string[] = [];
    const gate = createLatestOpen<string>((stale) => { disposed.push(stale); });
    const slow = deferred<string>();
    const run = gate.start(() => slow.promise);
    gate.cancelAll();
    slow.resolve("late");
    expect(await run).toEqual({ status: "superseded" });
    expect(disposed).toEqual(["late"]);
    expect(gate.pending()).toBe(false);
  });
});

describe("startAfterChoice", () => {
  it("does not supersede an in-flight request while the user is still choosing, nor when they cancel", async () => {
    const disposed: string[] = [];
    const gate = createLatestOpen<string>((stale) => { disposed.push(stale); });
    const demo = deferred<string>();
    let demoSignal: AbortSignal | undefined;
    const demoRun = gate.start((signal) => { demoSignal = signal; return demo.promise; });
    const picker = deferred<string>();
    const userRun = gate.startAfterChoice(() => picker.promise, async (file) => file);
    expect(demoSignal?.aborted).toBe(false);
    picker.reject(new Error("Project selection was cancelled."));
    await expect(userRun).rejects.toThrow("cancelled");
    expect(demoSignal?.aborted).toBe(false);
    expect(gate.pending()).toBe(true);
    demo.resolve("21D");
    expect(await demoRun).toEqual({ status: "current", value: "21D" });
    expect(disposed).toEqual([]);
  });

  it("supersedes the in-flight request once a file is actually chosen", async () => {
    const disposed: string[] = [];
    const gate = createLatestOpen<string>((stale) => { disposed.push(stale); });
    const demo = deferred<string>();
    const demoRun = gate.start(() => demo.promise);
    const userRun = gate.startAfterChoice(async () => "golden-home", async (file) => file);
    expect(await userRun).toEqual({ status: "current", value: "golden-home" });
    demo.resolve("21D");
    expect(await demoRun).toEqual({ status: "superseded" });
    expect(disposed).toEqual(["21D"]);
  });
});
