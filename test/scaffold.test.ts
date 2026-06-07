import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scaffoldFeatureMap,
  defaultProjectConfig,
  skillPath,
  mcpConfigPath,
} from "../src/config/project.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fmap-scaffold-"));
}

test("scaffolds the agent skill + .mcp.json by default", () => {
  const dir = tmp();
  try {
    scaffoldFeatureMap(defaultProjectConfig(), dir);
    assert.ok(fs.existsSync(skillPath(dir)), "SKILL.md");
    assert.ok(fs.existsSync(mcpConfigPath(dir)), ".mcp.json");
    const mcp = JSON.parse(fs.readFileSync(mcpConfigPath(dir), "utf8"));
    assert.deepEqual(mcp.mcpServers.fmap, { command: "npx", args: ["-y", "@rrr1223/fmap", "query", "--serve"] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-scaffold never clobbers a human-edited SKILL.md or an existing .mcp.json", () => {
  const dir = tmp();
  try {
    scaffoldFeatureMap(defaultProjectConfig(), dir);
    fs.writeFileSync(skillPath(dir), "HUMAN EDITED");
    fs.writeFileSync(mcpConfigPath(dir), '{"mcpServers":{"other":{}}}');
    scaffoldFeatureMap(defaultProjectConfig(), dir); // second run
    assert.equal(fs.readFileSync(skillPath(dir), "utf8"), "HUMAN EDITED");
    assert.equal(fs.readFileSync(mcpConfigPath(dir), "utf8"), '{"mcpServers":{"other":{}}}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agentFiles:false skips the skill + .mcp.json", () => {
  const dir = tmp();
  try {
    scaffoldFeatureMap(defaultProjectConfig(), dir, { agentFiles: false });
    assert.equal(fs.existsSync(skillPath(dir)), false);
    assert.equal(fs.existsSync(mcpConfigPath(dir)), false);
    assert.ok(fs.existsSync(path.join(dir, "feature-map", "feature-map.config.yaml")), "still scaffolds the map");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
