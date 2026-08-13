import type { ImageAttachmentLocal, SummaryBlock } from "./types.js";

export function sessionTone(status: string) {
  if (status === "running" || status === "completed") return "good";
  if (status === "killed" || status === "failed") return "bad";
  return "warn";
}

export function formatClock(input: string | undefined) {
  if (!input) return "";
  return new Date(input).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function imageFileToAttachment(file: File): Promise<ImageAttachmentLocal> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name || "pasted-image",
        type: file.type || "image/png",
        size: file.size,
        dataUrl: reader.result as string
      });
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

export function fileToAttachment(file: File): Promise<ImageAttachmentLocal> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name || "attachment",
        type: file.type || "application/octet-stream",
        size: file.size,
        dataUrl: reader.result as string
      });
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value)) return "";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function summaryBlocks(text: string): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  let listItems: string[] = [];
  let paragraphLines: string[] = [];

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push({ type: "list", items: listItems });
    listItems = [];
  };

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
    paragraphLines = [];
  };

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      flushParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushList();
      flushParagraph();
      blocks.push({ type: "heading", text: heading[2].trim() });
      continue;
    }

    const listItem = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      listItems.push(listItem[1].trim());
      continue;
    }

    const section = line.match(/^([^:：]{2,28})[:：]\s*(.+)$/);
    if (section) {
      flushList();
      flushParagraph();
      blocks.push({ type: "section", title: section[1].trim(), text: section[2].trim() });
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushList();
  flushParagraph();
  return blocks;
}
