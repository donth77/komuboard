import { createStore } from "zustand/vanilla";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface AppState {
  room: string;
  status: ConnectionStatus;
  rttMs: number | null;
  connections: number;
  setStatus: (status: ConnectionStatus) => void;
  setRtt: (rttMs: number) => void;
  setConnections: (connections: number) => void;
}

/** Create the app store for a room. In M1 this gains canvas/tool/selection state. */
export function createAppStore(room: string) {
  return createStore<AppState>((set) => ({
    room,
    status: "connecting",
    rttMs: null,
    connections: 0,
    setStatus: (status) => set({ status }),
    setRtt: (rttMs) => set({ rttMs }),
    setConnections: (connections) => set({ connections }),
  }));
}

export type AppStore = ReturnType<typeof createAppStore>;
