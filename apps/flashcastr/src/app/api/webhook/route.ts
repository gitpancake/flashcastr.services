import { NextResponse, type NextRequest } from "next/server";
import {
  setNotificationToken,
  deleteNotificationToken,
} from "@/lib/notification-store";

interface WebhookEvent {
  event: string;
  fid: number;
  notificationDetails?: {
    token: string;
    url: string;
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: WebhookEvent = await request.json();
    const { event, fid, notificationDetails } = body;

    switch (event) {
      case "miniapp_added":
      case "notifications_enabled":
        if (notificationDetails) {
          setNotificationToken(fid, notificationDetails);
        }
        break;

      case "miniapp_removed":
      case "notifications_disabled":
        deleteNotificationToken(fid);
        break;
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
