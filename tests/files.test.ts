import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBridge } from "../src/files.js";
import { Workspace } from "../src/workspace.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("FileBridge", () => {
  it("round-trips a workspace artifact through an MCP resource id", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-files-"));
    roots.push(root);

    fs.writeFileSync(path.join(root, "result.csv"), "a,b\n1,2\n");
    const files = new FileBridge(new Workspace(root), 1024, 1024);

    const exported = files.exportFile("result.csv");
    expect(exported.uri).toMatch(/^sandbox:\/\/artifact\//);
    expect(exported.mime_type).toBe("text/csv");

    const id = exported.uri.split("/").at(-1)!;
    const resource = files.readArtifact(id);
    expect(Buffer.from(resource.blob, "base64").toString("utf8")).toBe("a,b\n1,2\n");
  });

  it("enforces the export size limit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-files-"));
    roots.push(root);

    fs.writeFileSync(path.join(root, "large.bin"), Buffer.alloc(10));
    const files = new FileBridge(new Workspace(root), 1024, 5);
    expect(() => files.exportFile("large.bin")).toThrow(/CSB_MAX_EXPORT_BYTES/);
  });
});
