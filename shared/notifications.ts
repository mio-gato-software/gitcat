export type Notification = { id: number; label: string; detail: string; tone: "success" | "neutral" | "warning" };

/** Only the compact preview expires. The record stays available in the notification center. */
export function notificationDuration(tone: Notification["tone"]): number {
  return tone === "warning" ? 10_000 : 6_000;
}

/** Repeated status reads should update one notice instead of filling the workspace. */
export function addNotification(items: Notification[], next: Notification): Notification[] {
  let routineCount = 0;
  return [next, ...items.filter((item) => item.label !== next.label || item.detail !== next.detail || item.tone !== next.tone)]
    .filter((item) => item.tone === "warning" || ++routineCount <= 50);
}

/** A preview never displays a multiline command log or grows with its contents. */
export function notificationSummary(item: Notification): string {
  const message = `${item.label} · ${item.detail}`.replace(/\s+/g, " ").trim();
  return message.length > 140 ? `${message.slice(0, 139)}…` : message;
}
