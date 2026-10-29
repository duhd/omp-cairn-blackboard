/**
 * Tells the user when a newer version of this plugin is on GitHub, and how to get it. Suggests only; never updates.
 *
 * The source is `package.json` on `main`, because that is the ref `omp plugin upgrade` re-resolves for a git
 * install: a release or tag would not change what the upgrade fetches. raw.githubusercontent.com needs no token
 * and is not subject to the 60/hour unauthenticated API limit. The result is cached in a file for a day so that
 * every session, subagent and module instance in every process shares one fetch.
 *
 * The remote version is untrusted text: it is only displayed, and only when it parses as plain semver. The
 * suggested commands are fixed strings.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REMOTE_PACKAGE_URL = "https://raw.githubusercontent.com/duhd/omp-cairn-blackboard/main/package.json";
export const CHANGELOG_URL = "https://github.com/duhd/omp-cairn-blackboard/blob/main/CHANGELOG.md";
const PLUGIN_NAME = "omp-cairn-blackboard";
/** omp's marketplace naming rule; the name read from a cache path is shown in a command, so it must match. */
const MARKETPLACE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,62}[A-Za-z0-9])?$/;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const PLUGIN_ROOT = join(import.meta.dir, "..");

interface Cache {
  checked_at: number;
  latest: string | null;
}

export type InstallKind = { kind: "marketplace"; marketplace: string } | { kind: "git-checkout" } | { kind: "package" };

export interface UpdateCheckOptions {
  /** The installed version. */
  current: string;
  /** Where the last result is kept between processes. */
  cachePath: string;
  /** Decides which update command is suggested. */
  install: InstallKind;
  now?: number;
  fetchImpl?: typeof fetch;
}

/** Negative, zero or positive like a comparator; null when either side is not plain semver. */
export function compareVersions(a: string, b: string): number | null {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}
/** A plain-semver `version` field of parsed JSON, or null. */
function versionOf(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("version" in value)) return null;
  return typeof value.version === "string" && SEMVER.test(value.version) ? value.version : null;
}

function readCache(path: string): Cache | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || !("checked_at" in value) || typeof value.checked_at !== "number") return null;
    return { checked_at: value.checked_at, latest: "latest" in value && typeof value.latest === "string" ? value.latest : null };
  } catch {
    return null;
  }
}

async function fetchLatest(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(REMOTE_PACKAGE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    return versionOf(await response.json());
  } catch {
    return null;
  }
}

/**
 * The message to show, or null when there is nothing to say. Never throws: offline, a timeout, a bad response or
 * an unwritable cache all mean "say nothing". A failed fetch is cached too, so an offline machine does not retry
 * on every session start.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<string | null> {
  const now = options.now ?? Date.now();
  let cache = readCache(options.cachePath);
  if (!cache || now - cache.checked_at >= CHECK_INTERVAL_MS || now < cache.checked_at) {
    cache = { checked_at: now, latest: await fetchLatest(options.fetchImpl ?? fetch) };
    try {
      writeFileSync(options.cachePath, JSON.stringify(cache));
    } catch {
      // the next session checks again
    }
  }
  if (!cache.latest) return null;
  const order = compareVersions(cache.latest, options.current);
  if (order === null || order <= 0) return null;
  const how =
    options.install.kind === "git-checkout"
      ? `run \`git pull\` in ${PLUGIN_ROOT}`
      : options.install.kind === "marketplace"
        ? `run \`omp plugin marketplace update ${options.install.marketplace}\` then \`omp plugin upgrade ${PLUGIN_NAME}@${options.install.marketplace}\``
        : `run \`omp plugin upgrade ${PLUGIN_NAME}\``;
  return `omp-cairn-blackboard ${cache.latest} is available (installed ${options.current}). To update, ${how}, then quit omp fully and start it again. Changes: ${CHANGELOG_URL}`;
}

/**
 * How this copy was installed, read from where it sits. A marketplace install lives in a cache directory named
 * `<marketplace>___<plugin>___<version>` and upgrades as `name@marketplace`; a linked git checkout cannot be
 * upgraded by omp and needs `git pull`; anything else is a `github:`/npm install that `omp plugin upgrade` handles.
 */
export function installKindOf(root: string, hasGit: boolean): InstallKind {
  const dir = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const marketplace = dir.split("___");
  if (marketplace.length === 3 && marketplace[1] === PLUGIN_NAME && MARKETPLACE_NAME.test(marketplace[0])) {
    return { kind: "marketplace", marketplace: marketplace[0] };
  }
  return hasGit ? { kind: "git-checkout" } : { kind: "package" };
}

/** The installed version and install kind, read from this plugin's own files. */
export function installedPlugin(): { current: string; install: InstallKind } | null {
  try {
    const current = versionOf(JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")));
    if (!current) return null;
    return { current, install: installKindOf(PLUGIN_ROOT, existsSync(join(PLUGIN_ROOT, ".git"))) };
  } catch {
    return null;
  }
}

/** The cache sits next to the boards: `dbPath` is the default board file. */
export function updateCachePath(dbPath: string): string {
  return join(dirname(dbPath), "omp-cairn-blackboard-update.json");
}
