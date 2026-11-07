import { createSignal, onCleanup, onMount, Show } from "solid-js";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaControlsProps {
  readonly hasUnsavedChanges: () => boolean;
}

function installed() {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

function iosBrowser() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/** Optional controls: the workspace stays usable without install, SW, or network access. */
export function PwaControls(props: PwaControlsProps) {
  const [isOnline, setOnline] = createSignal(navigator.onLine);
  const [isInstalled, setInstalled] = createSignal(installed());
  const [prompt, setPrompt] = createSignal<InstallPrompt | null>(null);
  const [updateAvailable, setUpdateAvailable] = createSignal(false);
  const [helpVisible, setHelpVisible] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  let registration: ServiceWorkerRegistration | undefined;
  let acceptingUpdate = false;

  const onConnectionChange = () => setOnline(navigator.onLine);
  const onAppInstalled = () => { setInstalled(true); setPrompt(null); setHelpVisible(false); };
  const onBeforeInstall = (event: Event) => {
    event.preventDefault();
    setPrompt(event as InstallPrompt);
  };
  const checkUpdate = () =>
    setUpdateAvailable(Boolean(registration?.waiting && navigator.serviceWorker.controller));
  const onUpdateFound = () => {
    registration?.installing?.addEventListener("statechange", checkUpdate);
  };
  const onControllerChange = () => {
    checkUpdate();
    if (acceptingUpdate && !props.hasUnsavedChanges()) window.location.reload();
  };
  const onFocus = () => { void registration?.update().catch(() => undefined); };

  onMount(() => {
    window.addEventListener("online", onConnectionChange);
    window.addEventListener("offline", onConnectionChange);
    window.addEventListener("appinstalled", onAppInstalled);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("focus", onFocus);
    if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register(import.meta.env.BASE_URL + "service-worker.js")
        .then(value => {
          registration = value;
          registration.addEventListener("updatefound", onUpdateFound);
          navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
          checkUpdate();
        })
        .catch(() => {
          setNotice("Offline installation is unavailable in this browser.");
        });
    }
  });
  onCleanup(() => {
    window.removeEventListener("online", onConnectionChange);
    window.removeEventListener("offline", onConnectionChange);
    window.removeEventListener("appinstalled", onAppInstalled);
    window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    window.removeEventListener("focus", onFocus);
    registration?.removeEventListener("updatefound", onUpdateFound);
    navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
  });

  const install = async () => {
    const choice = prompt();
    if (!choice) return;
    setPrompt(null);
    try {
      await choice.prompt();
      const result = await choice.userChoice;
      if (result.outcome === "accepted") setNotice("");
    } catch {
      setNotice("Installation was not completed. Use your browser's install menu.");
    }
  };
  const update = () => {
    if (props.hasUnsavedChanges()) {
      setNotice("Save or discard your project changes before updating Studio.");
      return;
    }
    if (!registration?.waiting) return;
    acceptingUpdate = true;
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  };

  return (
    <div class="teldra-pwa-controls" role="group" aria-label="App and connection">
      <Show when={!isOnline()}>
        <span class="teldra-pwa-controls__offline" role="status" aria-label="Offline">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 2l20 20M5 9a12 12 0 0 1 12-1M9 13a6 6 0 0 1 4-.3M12 20h.01"/></svg>
          <span class="teldra-pwa-controls__label">Offline</span>
        </span>
      </Show>
      <Show when={!isInstalled() && prompt() !== null}>
        <button type="button" class="teldra-pwa-controls__button" onClick={() => void install()} aria-label="Install Teldra Studio">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3"/></svg>
          <span class="teldra-pwa-controls__label">Install</span>
        </button>
      </Show>
      <Show when={!isInstalled() && prompt() === null && iosBrowser()}>
        <button type="button" class="teldra-pwa-controls__button" onClick={() => setHelpVisible(!helpVisible())} aria-expanded={helpVisible()} aria-label="Add Teldra Studio to Home Screen">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V3m-4 4 4-4 4 4M5 12v8h14v-8"/></svg>
          <span class="teldra-pwa-controls__label">Add to Home Screen</span>
        </button>
      </Show>
      <Show when={updateAvailable()}>
        <button type="button" class="teldra-pwa-controls__button" onClick={update} aria-label="Update Teldra Studio">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 7v5h-5M4 17v-5h5M6 9a7 7 0 0 1 12-2l2 5M4 12l2 5a7 7 0 0 0 12-2"/></svg>
          <span class="teldra-pwa-controls__label">Update</span>
        </button>
      </Show>
      <Show when={helpVisible()}>
        <span class="teldra-pwa-controls__notice" role="status">In Safari, open Share and choose Add to Home Screen.</span>
      </Show>
      <Show when={notice()}>
        <span class="teldra-pwa-controls__notice" role="status">{notice()}</span>
      </Show>
    </div>
  );
}
