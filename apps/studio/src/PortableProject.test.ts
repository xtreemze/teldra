import { describe, expect, it } from "vitest";
import { createDownloadProjectHandle } from "./PortableProject";

describe("portable project downloads", () => {
  it("stages and exports a copy only on close, retaining the source until then", async () => {
    const exported: Uint8Array[] = [];
    const handle = createDownloadProjectHandle("home.teldra", new Uint8Array([1, 2]), bytes => { exported.push(bytes); });
    expect(handle.saveMode).toBe("download");
    const writable = await handle.createWritable(); await writable.write(new Uint8Array([3, 4]));
    expect(exported).toHaveLength(0);
    expect([...new Uint8Array(await (await handle.getFile()).arrayBuffer())]).toEqual([1, 2]);
    await writable.close(); expect([...exported[0]!]).toEqual([3, 4]);
    expect([...new Uint8Array(await (await handle.getFile()).arrayBuffer())]).toEqual([3, 4]);
  });
  it("keeps the previous bytes when export fails or a staged write is aborted", async () => {
    const handle = createDownloadProjectHandle("home.teldra", new Uint8Array([1]), () => { throw new Error("blocked"); });
    const writable = await handle.createWritable(); await writable.write(new Uint8Array([9]));
    await expect(writable.close()).rejects.toThrow("blocked"); await writable.abort?.();
    expect([...new Uint8Array(await (await handle.getFile()).arrayBuffer())]).toEqual([1]);
  });
});
