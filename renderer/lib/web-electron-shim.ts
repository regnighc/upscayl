import { ELECTRON_COMMANDS } from "../../common/electron-commands";

type Listener = (event: any, data: any) => void;

export function createWebElectronShim() {
  const listeners = new Map<string, Listener[]>();

  function connectWS() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onmessage = (event) => {
      try {
        const { command, data } = JSON.parse(event.data as string);
        const fns = listeners.get(command) ?? [];
        fns.forEach((fn) => fn(null, data));
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = () => setTimeout(connectWS, 2000);
  }

  connectWS();

  function emit(command: string, data: any) {
    (listeners.get(command) ?? []).forEach((fn) => fn(null, data));
  }

  return {
    send: (command: string, payload?: any) => {
      if (
        command === ELECTRON_COMMANDS.UPSCAYL ||
        command === ELECTRON_COMMANDS.DOUBLE_UPSCAYL ||
        command === ELECTRON_COMMANDS.FOLDER_UPSCAYL
      ) {
        fetch("/api/upscayl", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command, payload }),
        }).catch((err) =>
          emit(ELECTRON_COMMANDS.UPSCAYL_ERROR, String(err)),
        );
      } else if (command === ELECTRON_COMMANDS.STOP) {
        fetch("/api/stop", { method: "POST" }).catch(() => {});
      }
      // GET_MODELS_LIST, OPEN_FOLDER, PASTE_IMAGE etc. are no-ops in web mode
      return {} as any;
    },

    on: (command: string, func: Listener) => {
      const list = listeners.get(command) ?? [];
      list.push(func);
      listeners.set(command, list);
      return {} as any;
    },

    off: (command: string, func: Listener) => {
      const list = listeners.get(command) ?? [];
      listeners.set(
        command,
        list.filter((f) => f !== func),
      );
      return {} as any;
    },

    invoke: async (command: string, _payload?: any): Promise<any> => {
      if (command === ELECTRON_COMMANDS.SELECT_FILE) {
        return new Promise<string | null>((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".png,.jpg,.jpeg,.webp";
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) {
              resolve(null);
              return;
            }
            const formData = new FormData();
            formData.append("image", file);
            try {
              const res = await fetch("/api/upload", {
                method: "POST",
                body: formData,
              });
              const json = await res.json();
              resolve(json.inputPath as string);
            } catch (err) {
              emit(ELECTRON_COMMANDS.UPSCAYL_ERROR, String(err));
              resolve(null);
            }
          };
          // oncancel fires when dialog is dismissed without selection
          input.addEventListener("cancel", () => resolve(null));
          input.click();
        });
      }

      if (command === ELECTRON_COMMANDS.SELECT_FOLDER) {
        // Batch folder mode is not supported in the web build
        return null;
      }

      return null;
    },

    platform: "linux" as const,

    getSystemInfo: async () => {
      const res = await fetch("/api/system-info");
      return res.json();
    },

    getAppVersion: async () => "2.15.0-web",
  };
}
