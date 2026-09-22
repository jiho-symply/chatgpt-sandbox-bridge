import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix = "csb-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("Workspace", () => {
  it("resolves paths inside the root", () => {
    const root = tempRoot();
    const workspace = new Workspace(root);
    expect(workspace.resolve("a/b")).toBe(path.join(root, "a", "b"));
  });

  it("rejects traversal and absolute paths", () => {
    const root = tempRoot();
    const workspace = new Workspace(root);
    expect(() => workspace.resolve("../outside")).toThrow();
    expect(() => workspace.resolve(path.resolve(root, "inside"))).toThrow();
  });

  it("rejects symlink traversal for reads and writes", () => {
    if (process.platform === "win32") return;

    const root = tempRoot();
    const outside = tempRoot("csb-outside-");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");

    const workspace = new Workspace(root);
    expect(() => workspace.resolveExistingFile("escape/secret.txt")).toThrow();
    expect(() => workspace.writeBinary("escape/new.txt", Buffer.from("x"))).toThrow();
  });

  it("reads bounded text with continuation metadata", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "x.txt"), "abcdef");
    const workspace = new Workspace(root);
    expect(workspace.readText("x.txt", 3, 0)).toMatchObject({
      text: "abc",
      bytes: 3,
      truncated: true
    });
    expect(workspace.readText("x.txt", 3, 3)).toMatchObject({
      text: "def",
      bytes: 3,
      truncated: false
    });
  });
});
