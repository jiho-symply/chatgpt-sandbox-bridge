import fs from "node:fs";
import path from "node:path";

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = fs.realpathSync(root);
  }

  resolve(relative = "."): string {
    if (path.isAbsolute(relative)) {
      throw new Error("cwd/path must be relative to the configured workspace root");
    }

    const candidate = path.resolve(this.root, relative);
    const rel = path.relative(this.root, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("path escapes the configured workspace root");
    }
    return candidate;
  }

  readText(relative: string, maxBytes: number, offset = 0): {
    path: string;
    text: string;
    offset: number;
    bytes: number;
    truncated: boolean;
  } {
    const absolute = this.resolve(relative);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error("path is not a regular file");

    const safeOffset = Math.max(0, Math.min(offset, stat.size));
    const length = Math.min(maxBytes, stat.size - safeOffset);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(absolute, "r");
    try {
      fs.readSync(fd, buffer, 0, length, safeOffset);
    } finally {
      fs.closeSync(fd);
    }

    return {
      path: relative,
      text: buffer.toString("utf8"),
      offset: safeOffset,
      bytes: length,
      truncated: safeOffset + length < stat.size
    };
  }
}
