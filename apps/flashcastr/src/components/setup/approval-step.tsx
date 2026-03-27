"use client";

import { QRCodeSVG } from "qrcode.react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ApprovalStepProps {
  approvalUrl: string;
  pollStatus: string;
}

export function ApprovalStep({ approvalUrl, pollStatus }: ApprovalStepProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Approve Connection</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4">
        <p className="text-xs text-muted-foreground text-center">
          Scan this QR code with your phone to approve the signer request
        </p>

        <div className="rounded-lg bg-white p-4">
          <QRCodeSVG value={approvalUrl} size={200} />
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {pollStatus === "PENDING_APPROVAL"
            ? "Waiting for approval..."
            : "Connecting..."}
        </div>
      </CardContent>
    </Card>
  );
}
