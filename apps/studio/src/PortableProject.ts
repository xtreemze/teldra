import {
  openBrowserTeldraProject,
  openBrowserTeldraProjectWithPicker,
  supportsBrowserTeldraFileAccess,
  type BrowserTeldraFileHandle,
  type BrowserStudioProject,
} from "./BrowserTeldraProject";

export type ProjectDownload = (bytes: Uint8Array, name: string) => void | Promise<void>;

/** A portable editable copy. Saving exports a download, never overwrites the input. */
export function createDownloadProjectHandle(name: string, input: Uint8Array,
  download: ProjectDownload = downloadProject): BrowserTeldraFileHandle {
  let bytes: Uint8Array = input.slice();
  return {
    name, saveMode: "download",
    async getFile() { return new Blob([bytes.slice().buffer]); },
    async createWritable() {
      let staged: Uint8Array | undefined;
      return {
        async write(value) { staged = value.slice(); },
        async close() {
          if (!staged) throw new Error("No project bytes were staged for download.");
          await download(staged.slice(), name);
          bytes = staged; staged = undefined;
        },
        async abort() { staged = undefined; },
      };
    },
  };
}

function downloadProject(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], {type: "application/zip"}));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.hidden = true;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function openPortableProject(): Promise<BrowserStudioProject> {
  const owner = `studio:${crypto.randomUUID()}`;
  if (supportsBrowserTeldraFileAccess()) return openBrowserTeldraProjectWithPicker(owner);
  const file = await new Promise<File>((resolve, reject) => {
    const input = document.createElement("input"); input.type = "file"; input.accept = ".teldra";
    input.hidden = true;
    const dispose = () => input.remove();
    input.addEventListener("change", () => {
      const file = input.files?.[0]; dispose();
      if (file) resolve(file); else reject(new DOMException("Project selection was cancelled.", "AbortError"));
    }, {once: true});
    input.addEventListener("cancel", () => { dispose(); reject(new DOMException("Project selection was cancelled.", "AbortError")); }, {once: true});
    document.body.append(input); input.click();
  });
  return openBrowserTeldraProject(createDownloadProjectHandle(file.name,
    new Uint8Array(await file.arrayBuffer())), owner);
}

export async function openDemoProject(url: string, options: {
  fileName?: string; onProgress?: (loaded: number, total: number) => void;
} = {}): Promise<BrowserStudioProject> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Demo could not be loaded (${response.status}).`);
  let bytes: Uint8Array;
  if (response.body && options.onProgress) {
    const reader = response.body.getReader(); const chunks: Uint8Array[] = [];
    const total = Number(response.headers.get("content-length") ?? 0); let loaded = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        loaded += chunk.value.length;
        if (loaded > 512 * 1024 * 1024) throw new Error("The demo exceeds the supported download size.");
        chunks.push(chunk.value); options.onProgress(loaded, total);
      }
    } finally { reader.releaseLock(); }
    bytes = new Uint8Array(loaded); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  } else bytes = new Uint8Array(await response.arrayBuffer());
  return openBrowserTeldraProject(createDownloadProjectHandle(options.fileName ?? "teldra-demo.teldra", bytes), `demo:${crypto.randomUUID()}`);
}
