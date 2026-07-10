// The needs-you cue: a decision card blocks Darwin's turn (even Auto runs),
// so a card that fires while the tab is unfocused must reach the user —
// tab-title flash + favicon badge + a macOS notification. Everything
// degrades gracefully: no Notification API, denied permission, or a missing
// favicon just drops that channel. The cue clears the moment the tab is
// focused or the decision settles.

export type NeedsYouCue = {
  /** Cue the user if the tab is unfocused right now; no-op when focused. */
  arm(question: string): void;
  disarm(): void;
};

const FLASH_TITLE = "● Darwin needs you";
const FLASH_MS = 1200;

/** Paint a badge dot onto the current favicon (fallback: a bare dot). */
function badgedFavicon(onReady: (dataUrl: string) => void): void {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const drawDot = () => {
    ctx.fillStyle = "#e5484d";
    ctx.beginPath();
    ctx.arc(23, 23, 8, 0, Math.PI * 2);
    ctx.fill();
    onReady(canvas.toDataURL("image/png"));
  };
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  const href = link?.href || "/favicon.ico";
  const base = new Image();
  base.onload = () => {
    ctx.drawImage(base, 0, 0, 32, 32);
    drawDot();
  };
  base.onerror = () => drawDot();
  base.src = href;
}

function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  return link;
}

function notify(question: string, onShown: (notification: Notification) => void): void {
  if (typeof Notification === "undefined") {
    return;
  }
  const show = () => {
    try {
      const notification = new Notification("Darwin needs you", {
        body: question,
        tag: "galapagos-needs-you",
      });
      notification.onclick = () => window.focus();
      onShown(notification);
    } catch {
      // Some platforms throw instead of denying — degrade to badge only.
    }
  };
  if (Notification.permission === "granted") {
    show();
  } else if (Notification.permission === "default") {
    // Lazy permission ask: first time a card actually needs the user.
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") {
        show();
      }
    });
  }
}

export function createNeedsYouCue(): NeedsYouCue {
  let flashTimer: ReturnType<typeof setInterval> | null = null;
  let baseTitle: string | null = null;
  let originalIconHref: string | null = null;
  let notification: Notification | null = null;
  let armed = false;

  const disarm = () => {
    if (!armed) {
      return;
    }
    armed = false;
    window.removeEventListener("focus", disarm);
    if (flashTimer !== null) {
      clearInterval(flashTimer);
      flashTimer = null;
    }
    if (baseTitle !== null) {
      document.title = baseTitle;
      baseTitle = null;
    }
    if (originalIconHref !== null) {
      iconLink().href = originalIconHref;
      originalIconHref = null;
    }
    notification?.close();
    notification = null;
  };

  const arm = (question: string) => {
    if (typeof document === "undefined" || document.hasFocus()) {
      return;
    }
    disarm();
    armed = true;
    window.addEventListener("focus", disarm);

    baseTitle = document.title;
    flashTimer = setInterval(() => {
      document.title = document.title === FLASH_TITLE ? (baseTitle as string) : FLASH_TITLE;
    }, FLASH_MS);
    document.title = FLASH_TITLE;

    const link = iconLink();
    originalIconHref = link.getAttribute("href") ?? "/favicon.ico";
    badgedFavicon((dataUrl) => {
      if (armed) {
        link.href = dataUrl;
      }
    });

    notify(question, (shown) => {
      if (armed) {
        notification = shown;
      } else {
        shown.close();
      }
    });
  };

  return { arm, disarm };
}
