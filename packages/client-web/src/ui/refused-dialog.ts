// "Connection refused" dialog — shown when the room DO deliberately closes us (room full / rate
// limited) so we stop retrying forever and explain why, instead of an endless "Reconnecting…".
import { CLOSE_ROOM_FULL, MAX_CONNECTIONS } from "@komuboard/shared";
import { type CoDialog, createDialog } from "../dialog";

export interface RefusedDialogOpts {
  /** Re-attempt the connection (reconnect the provider). */
  onRetry: () => void;
  /** Leave for a fresh, empty room. */
  onNewBoard: () => void;
}

export interface RefusedDialog {
  /** Show the dialog for a given close code (CLOSE_ROOM_FULL / CLOSE_RATE_LIMIT). */
  show(code: number): void;
}

export function createRefusedDialog(opts: RefusedDialogOpts): RefusedDialog {
  let dialog: CoDialog | null = null;

  return {
    show(code: number): void {
      dialog?.close(); // replace any prior instance (e.g. a retry that hit the full room again)
      const full = code === CLOSE_ROOM_FULL;

      const body = document.createElement("div");
      body.className = "refused-body";
      const title = document.createElement("p");
      title.className = "refused-title";
      title.textContent = full ? "This room is full" : "You were disconnected";
      const sub = document.createElement("p");
      sub.className = "refused-sub";
      sub.textContent = full
        ? `Up to ${MAX_CONNECTIONS} people can edit a board at once. Try again in a moment, or start a new board.`
        : "You were sending updates too quickly and got disconnected. This usually clears up right away.";
      body.append(title, sub);

      const footer = document.createElement("div");
      footer.className = "refused-footer";
      if (full) {
        const fresh = document.createElement("button");
        fresh.type = "button";
        fresh.className = "btn-ghost";
        fresh.textContent = "New board";
        fresh.addEventListener("click", () => opts.onNewBoard());
        footer.appendChild(fresh);
      }
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn-primary";
      retry.textContent = full ? "Try again" : "Reconnect";
      retry.addEventListener("click", () => {
        dialog?.close();
        opts.onRetry();
      });
      footer.appendChild(retry);

      dialog = createDialog({
        title: full ? "Room full" : "Disconnected",
        body,
        footer,
        width: 360,
      });
      dialog.open();
    },
  };
}
