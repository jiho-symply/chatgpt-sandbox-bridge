import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";

export interface OpenAIFileParam {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

const MIME: Record<string, string> = {
  ".csv": "text/csv",
  ".json": "application/json",
  ".jsonl": "application/jsonl",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".sol": "text/plain",
  ".lp": "text/plain",
  ".mps": "text/plain"
};

function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function safeName(value: string): string {
  const base = path.basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return (base || "upload.bin").slice(0, 180);
}

export class FileBridge {
  constructor(
    private readonly workspace: Workspace,
    private readonly maxImportBytes: number,
    private readonly maxExportBytes: number
  ) {}

  async importFiles(
    files: OpenAIFileParam[],
    destinationDir = "imports"
  ): Promise<Array<{
    file_id: string;
    path: string;
    bytes: number;
    mime_type: string;
  }>> {
    this.workspace.ensureDirectory(destinationDir);
    const imported = [];

    for (const file of files) {
      const url = new URL(file.download_url);
      if (url.protocol !== "https:") {
        throw new Error("ChatGPT file download_url must use HTTPS");
      }

      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`file download failed: HTTP ${response.status}`);
      }

      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > this.maxImportBytes) {
        throw new Error(
          `file exceeds CSB_MAX_IMPORT_BYTES (${declared} > ${this.maxImportBytes})`
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > this.maxImportBytes) {
        throw new Error(
          `file exceeds CSB_MAX_IMPORT_BYTES (${buffer.length} > ${this.maxImportBytes})`
        );
      }

      const requestedName = safeName(file.file_name ?? `${file.file_id}.bin`);
      let relative = path.posix.join(destinationDir.replace(/\\/g, "/"), requestedName);
      let n = 1;
      while (this.workspace.exists(relative)) {
        const ext = path.extname(requestedName);
        const stem = requestedName.slice(0, requestedName.length - ext.length);
        relative = path.posix.join(
          destinationDir.replace(/\\/g, "/"),
          `${stem}-${n++}${ext}`
        );
      }

      this.workspace.writeBinary(relative, buffer);
      imported.push({
        file_id: file.file_id,
        path: relative,
        bytes: buffer.length,
        mime_type: file.mime_type ?? mimeFor(relative)
      });
    }

    return imported;
  }

  exportFile(relative: string) {
    const absolute = this.workspace.resolveExistingFile(relative);
    const stat = fs.statSync(absolute);
    if (stat.size > this.maxExportBytes) {
      throw new Error(
        `file exceeds CSB_MAX_EXPORT_BYTES (${stat.size} > ${this.maxExportBytes})`
      );
    }

    const normalized = this.workspace.relative(absolute);
    const id = Buffer.from(normalized, "utf8").toString("base64url");
    return {
      path: normalized,
      name: path.basename(normalized),
      mime_type: mimeFor(normalized),
      size: stat.size,
      uri: `sandbox://artifact/${id}`
    };
  }

  readArtifact(id: string) {
    let relative: string;
    try {
      relative = Buffer.from(id, "base64url").toString("utf8");
    } catch {
      throw new Error("invalid artifact id");
    }

    const absolute = this.workspace.resolveExistingFile(relative);
    const stat = fs.statSync(absolute);
    if (stat.size > this.maxExportBytes) {
      throw new Error("artifact exceeds export limit");
    }

    return {
      path: this.workspace.relative(absolute),
      name: path.basename(absolute),
      mime_type: mimeFor(absolute),
      size: stat.size,
      blob: fs.readFileSync(absolute).toString("base64")
    };
  }
}
