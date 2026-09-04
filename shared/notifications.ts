export type Notification = { id: number; label: string; detail: string; tone: "success" | "neutral" | "warning" };

/** Errors need acknowledgment; routine confirmations can leave on their own. */
export function notificationDuration(tone: Notification["tone"]): number | undefined {
  return tone === "warning" ? undefined : 6_000;
}

/** Repeated status reads should update one notice instead of filling the workspace. */
export function addNotification(items: Notification[], next: Notification): Notification[] {
  return [next, ...items.filter((item) => item.label !== next.label || item.detail !== next.detail || item.tone !== next.tone)];
}
