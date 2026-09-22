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

describe("Workspace", () => {
  it("resolves paths inside the root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-"));
    roots.push(root);
    const workspace = new Workspace(root);
    expect(workspace.resolve("a/b")).toBe(path.join(root, "a", "b"));
  });

  it("rejects traversal and absolute paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-"));
    roots.push(root);
    const workspace = new Workspace(root);
    expect(() => workspace.resolve("../outside")).toThrow();
    expect(() => workspace.resolve(path.resolve(root, "inside"))).toThrow();
  });

  it("reads bounded text with continuation metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-"));
    roots.push(root);
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
