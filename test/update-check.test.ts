import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, compareVersions, installKindOf } from "../src/update-check";

const DAY = 24 * 60 * 60 * 1000;

function remote(version: unknown, status = 200): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ version }), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function cachePath(): string {
  return join(mkdtempSync(join(tmpdir(), "cairn-update-")), "update.json");
}

describe("update check", () => {
  test("semver ordering compares numerically and rejects anything else", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.3.1", "0.4.0")).toBeLessThan(0);
    expect(compareVersions("0.4.0-beta", "0.3.1")).toBeNull();
    expect(compareVersions("$(rm -rf ~)", "0.3.1")).toBeNull();
  });

  test("a newer remote suggests the command for the install kind", async () => {
    const { fetchImpl } = remote("0.4.0");
    const at = (install: Parameters<typeof checkForUpdate>[0]["install"]) => checkForUpdate({ current: "0.3.1", cachePath: cachePath(), install, fetchImpl });
    expect(await at({ kind: "package" })).toContain("0.4.0 is available (installed 0.3.1). To update, run `omp plugin upgrade omp-cairn-blackboard`,");
    expect(await at({ kind: "marketplace", marketplace: "duhd" })).toContain("`omp plugin marketplace update duhd` then `omp plugin upgrade omp-cairn-blackboard@duhd`");
    expect(await at({ kind: "git-checkout" })).toContain("run `git pull` in ");
  });

  test("same, older, malformed or failed remotes say nothing", async () => {
    for (const r of [remote("0.3.1"), remote("0.2.9"), remote("0.4.0; curl evil"), remote(7), remote("0.4.0", 404)]) {
      expect(await checkForUpdate({ current: "0.3.1", cachePath: cachePath(), install: { kind: "package" }, fetchImpl: r.fetchImpl })).toBeNull();
    }
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkForUpdate({ current: "0.3.1", cachePath: cachePath(), install: { kind: "package" }, fetchImpl: offline })).toBeNull();
  });

  test("one fetch per day, failures included, shared through the cache file", async () => {
    const path = cachePath();
    const failing = remote("x", 500);
    const base = { current: "0.3.1", cachePath: path, install: { kind: "package" } as const };
    await checkForUpdate({ ...base, now: 1000, fetchImpl: failing.fetchImpl });
    await checkForUpdate({ ...base, now: 1000 + DAY - 1, fetchImpl: failing.fetchImpl });
    expect(failing.calls()).toBe(1);

    const newer = remote("0.5.0");
    expect(await checkForUpdate({ ...base, now: 1000 + DAY, fetchImpl: newer.fetchImpl })).toContain("0.5.0 is available");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ checked_at: 1000 + DAY, latest: "0.5.0" });
    // Served from the cache, and silent once the installed copy catches up.
    expect(await checkForUpdate({ ...base, current: "0.5.0", now: 2000 + DAY, fetchImpl: newer.fetchImpl })).toBeNull();
    expect(newer.calls()).toBe(1);
  });

  test("a corrupt cache or a clock that moved backwards triggers a fresh look", async () => {
    const path = cachePath();
    writeFileSync(path, "{not json");
    const r = remote("0.4.0");
    await checkForUpdate({ current: "0.3.1", cachePath: path, install: { kind: "package" }, now: 5 * DAY, fetchImpl: r.fetchImpl });
    await checkForUpdate({ current: "0.3.1", cachePath: path, install: { kind: "package" }, now: 4 * DAY, fetchImpl: r.fetchImpl });
    expect(r.calls()).toBe(2);
  });

  test("the install kind comes from where the plugin sits", () => {
    expect(installKindOf("C:\\Users\\u\\.omp\\plugins\\cache\\plugins\\duhd___omp-cairn-blackboard___0.3.1", false)).toEqual({ kind: "marketplace", marketplace: "duhd" });
    expect(installKindOf("/home/u/.omp/plugins/cache/plugins/duhd___omp-cairn-blackboard___0.3.1/", true)).toEqual({ kind: "marketplace", marketplace: "duhd" });
    expect(installKindOf("/x/cache/plugins/bad name___omp-cairn-blackboard___0.3.1", false)).toEqual({ kind: "package" });
    expect(installKindOf("/x/cache/plugins/duhd___other-plugin___1.0.0", false)).toEqual({ kind: "package" });
    expect(installKindOf("/home/u/src/omp-cairn-blackboard", true)).toEqual({ kind: "git-checkout" });
    expect(installKindOf("/home/u/.omp/plugins/node_modules/omp-cairn-blackboard", false)).toEqual({ kind: "package" });
  });
});
