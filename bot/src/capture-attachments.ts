export interface CaptureAttachment {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export function captureAttachmentSnapshot(attachments: CaptureAttachment[] = []): string {
  return JSON.stringify({ version: 1, attachments });
}

export function retainedCaptureAttachments(snapshot: string | null | undefined): CaptureAttachment[] {
  if (!snapshot) return [];
  const value = JSON.parse(snapshot);
  if (value?.version !== 1 || !Array.isArray(value.attachments)) {
    throw new Error("Unsupported capture attachment snapshot.");
  }
  return value.attachments;
}
