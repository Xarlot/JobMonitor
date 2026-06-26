/**
 * Thin wrapper over the Web Notifications API for "X finished" desktop pings.
 *
 * All sends are best-effort: a no-op when the API is missing or permission isn't
 * granted, and never throws. `Notification` is a local OS-level API — no PR/flow
 * data leaves the browser.
 */

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission {
  return notificationsSupported() ? Notification.permission : 'denied';
}

/** Request permission if still "default"; returns the resulting permission. */
export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface NotifyInput {
  title: string;
  body: string;
  /** Collapses repeat pings for the same item instead of stacking them. */
  tag?: string;
  /** Opened in a new tab when the notification is clicked. */
  url?: string;
}

export function sendNotification({ title, body, tag, url }: NotifyInput): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    if (url) {
      n.onclick = () => {
        try {
          window.focus();
          window.open(url, '_blank', 'noopener,noreferrer');
        } finally {
          n.close();
        }
      };
    }
  } catch {
    // Notification constructor can throw in some contexts (e.g. no document); ignore.
  }
}
