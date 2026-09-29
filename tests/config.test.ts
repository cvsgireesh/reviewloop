import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleConfig, loadConfig } from "../src/config.js";

test("configuration rejects insecure remote endpoints, embedded secrets and unsupported policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "reviewloop-config-"));
  const file = join(dir, "config.json");
  const read = (edit: (c: ReturnType<typeof exampleConfig>) => void) => {
    const c = exampleConfig();
    edit(c);
    writeFileSync(file, JSON.stringify(c));
    return loadConfig(file);
  };
  try {
    assert.throws(
      () =>
        read((c) => {
          c.github.apiUrl = "http://example.com";
        }),
      /HTTPS/,
    );
    assert.throws(
      () =>
        read((c) => {
          c.github.apiUrl = "https://user:secret@example.com";
        }),
      /credentials/,
    );
    assert.throws(
      () =>
        read((c) => {
          c.model.provider = "openai-compatible";
        }),
      /baseUrl/,
    );
    assert.throws(
      () =>
        read((c) => {
          c.runtime.maxCostUsd = 5;
        }),
      /prices/,
    );
    assert.throws(
      () =>
        read((c) => {
          c.github.repositories.push({ ...c.github.repositories[0]! });
        }),
      /Duplicate/,
    );
    const config = read((c) => {
      c.model.provider = "openai-compatible";
      c.model.baseUrl = "http://127.0.0.1:1234/v1";
      c.runtime.maxCostUsd = 5;
      c.model.inputPricePerMillion = 1;
      c.model.outputPricePerMillion = 2;
    });
    assert.equal(config.runtime.maxCostUsd, 5);
    assert.ok(config.runtime.stateDir.startsWith("/"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
