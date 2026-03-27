import { NextResponse } from "next/server";

export async function GET() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const name = process.env.NEXT_PUBLIC_FRAME_NAME ?? "Flashcastr";

  return NextResponse.json({
    miniapp: {
      version: "1",
      name,
      homeUrl: appUrl,
      iconUrl: `${appUrl}/icon.png`,
      webhookUrl: `${appUrl}/api/webhook`,
    },
  });
}
