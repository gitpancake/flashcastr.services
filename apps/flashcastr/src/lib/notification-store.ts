interface NotificationDetails {
  token: string;
  url: string;
}

// In-memory store — swap to Redis/Upstash by replacing this implementation
const store = new Map<number, NotificationDetails>();

export function getNotificationToken(fid: number): NotificationDetails | null {
  return store.get(fid) ?? null;
}

export function setNotificationToken(
  fid: number,
  details: NotificationDetails
): void {
  store.set(fid, details);
}

export function deleteNotificationToken(fid: number): void {
  store.delete(fid);
}
