import fs from "node:fs";
import path from "node:path";

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = fs.realpathSync(root);
  }

  resolve(relative = "."): string {
    return this.lexical(relative);
  }

  resolveExisting(relative = "."): string {
    const real = fs.realpathSync(this.lexical(relative));
    this.assertInside(real);
    return real;
  }

  resolveExistingDirectory(relative = "."): string {
    const real = this.resolveExisting(relative);
    if (!fs.statSync(real).isDirectory()) {
      throw new Error("cwd is not a directory");
    }
    return real;
  }

  resolveExistingFile(relative: string): string {
    const real = this.resolveExisting(relative);
    if (!fs.statSync(real).isFile()) {
      throw new Error("path is not a regular file");
    }
    return real;
  }

  ensureDirectory(relative: string): string {
    const target = this.lexical(relative);
    const rel = path.relative(this.root, target);
    const parts = rel === "" ? [] : rel.split(path.sep).filter(Boolean);
    let current = this.root;

    for (const part of parts) {
      const next = path.join(current, part);
      if (fs.existsSync(next)) {
        const stat = fs.lstatSync(next);
        if (stat.isSymbolicLink()) {
          throw new Error("symlinks are not allowed in writable workspace paths");
        }
        if (!stat.isDirectory()) {
          throw new Error("writable path component is not a directory");
        }
      } else {
        fs.mkdirSync(next, { mode: 0o755 });
      }
      current = next;
    }

    return current;
  }

  resolveForWrite(relative: string): string {
    const lexical = this.lexical(relative);
    const parentRelative = path.relative(this.root, path.dirname(lexical));
    const parent = this.ensureDirectory(parentRelative || ".");

    if (fs.existsSync(lexical)) {
      if (fs.lstatSync(lexical).isSymbolicLink()) {
        throw new Error("refusing to write through a symlink");
      }
      const real = fs.realpathSync(lexical);
      this.assertInside(real);
      return real;
    }

    const target = path.join(parent, path.basename(lexical));
    this.assertInside(target);
    return target;
  }

  exists(relative: string): boolean {
    return fs.existsSync(this.lexical(relative));
  }

  relative(absolute: string): string {
    const resolved = path.resolve(absolute);
    this.assertInside(resolved);
    return path.relative(this.root, resolved).split(path.sep).join("/");
  }

  writeBinary(relative: string, data: Buffer): void {
    fs.writeFileSync(this.resolveForWrite(relative), data, { mode: 0o644 });
  }

  readText(relative: string, maxBytes: number, offset = 0): {
    path: string;
    text: string;
    offset: number;
    bytes: number;
    truncated: boolean;
  } {
    const absolute = this.resolveExistingFile(relative);
    const stat = fs.statSync(absolute);

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
      path: this.relative(absolute),
      text: buffer.toString("utf8"),
      offset: safeOffset,
      bytes: length,
      truncated: safeOffset + length < stat.size
    };
  }

  private lexical(relative: string): string {
    if (path.isAbsolute(relative)) {
      throw new Error("cwd/path must be relative to the configured workspace root");
    }

    const candidate = path.resolve(this.root, relative);
    this.assertInside(candidate);
    return candidate;
  }

  private assertInside(candidate: string): void {
    const rel = path.relative(this.root, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("path escapes the configured workspace root");
    }
  }
}
