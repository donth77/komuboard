// "Connection refused" dialog — shown when the room DO deliberately closes us (room full / rate
// limited) so we stop retrying forever and explain why, instead of an endless "Reconnecting…".
import { CLOSE_ROOM_FULL, MAX_CONNECTIONS } from "@komuboard/shared";
import { type CoDialog, createDialog } from "../dialog";
import { t } from "../i18n";

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
      title.textContent = full ? t("refused.roomFullTitle") : t("refused.disconnectedTitle");
      const sub = document.createElement("p");
      sub.className = "refused-sub";
      sub.textContent = full
        ? t("refused.roomFullBody", { max: MAX_CONNECTIONS })
        : t("refused.rateLimitBody");
      body.append(title, sub);

      const footer = document.createElement("div");
      footer.className = "refused-footer";
      if (full) {
        const fresh = document.createElement("button");
        fresh.type = "button";
        fresh.className = "btn-ghost";
        fresh.textContent = t("refused.newBoard");
        fresh.addEventListener("click", () => opts.onNewBoard());
        footer.appendChild(fresh);
      }
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn-primary";
      retry.textContent = full ? t("refused.tryAgain") : t("refused.reconnect");
      retry.addEventListener("click", () => {
        dialog?.close();
        opts.onRetry();
      });
      footer.appendChild(retry);

      dialog = createDialog({
        title: full ? t("refused.roomFullDialogTitle") : t("refused.disconnectedDialogTitle"),
        body,
        footer,
        width: 360,
      });
      dialog.open();
    },
  };
}
