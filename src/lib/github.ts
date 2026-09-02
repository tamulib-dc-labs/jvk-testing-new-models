import type { BranchInfo, MediaFile, PullInfo, SiteInfo } from "../types/media";

/** Sentinel for "use the config.json shipped with this build". */
export const LOCAL_SOURCE = "__local__";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const CONFIG_PATH = "public/config.json";
const CACHE_KEY = "wtr:branches";
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface BranchLoad {
  files: MediaFile[];
  source: string;
}

let siteInfo: SiteInfo | null = null;

/** Reads site.json, written at build time by scripts/build-config.js. */
export async function loadSiteInfo(): Promise<SiteInfo> {
  if (siteInfo) return siteInfo;
  try {
    const response = await fetch("./site.json", { cache: "no-cache" });
    siteInfo = response.ok ? ((await response.json()) as SiteInfo) : {};
  } catch {
    siteInfo = {};
  }
  return siteInfo;
}

/**
 * "owner/repo" for the branch switcher: the build-time value wins, otherwise
 * we infer it from a github.io URL (`owner.github.io/repo/`).
 */
export function resolveRepository(info: SiteInfo): string | null {
  if (info.repository && info.repository.includes("/")) return info.repository;

  const { hostname, pathname } = window.location;
  const match = /^([\w-]+)\.github\.io$/.exec(hostname);
  if (!match) return null;

  const segment = pathname.split("/").filter(Boolean)[0];
  return segment ? `${match[1]}/${segment}` : null;
}

export function branchUrl(repo: string, branch: string): string {
  return `https://github.com/${repo}/tree/${encodeURIComponent(branch)}`;
}

export function rawConfigUrl(repo: string, branch: string): string {
  return `${RAW}/${repo}/${encodeURIComponent(branch)}/${CONFIG_PATH}`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) {
    const hint =
      response.status === 403
        ? " (GitHub API rate limit reached — try again in a few minutes)"
        : "";
    throw new Error(`${response.status} ${response.statusText}${hint}`);
  }
  return (await response.json()) as T;
}

interface ApiBranch {
  name: string;
}

interface ApiPull {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  head: { ref: string };
}

interface ApiRepo {
  default_branch: string;
}

/**
 * Every branch of the site repo, newest transcription run first, annotated with
 * the open PR that carries it. Cached in sessionStorage to stay under the
 * unauthenticated API rate limit.
 */
export async function listBranches(repo: string): Promise<BranchInfo[]> {
  const cached = readCache(repo);
  if (cached) return cached;

  const [branches, repoMeta] = await Promise.all([
    getJson<ApiBranch[]>(`${API}/repos/${repo}/branches?per_page=100`),
    getJson<ApiRepo>(`${API}/repos/${repo}`),
  ]);

  let pulls: ApiPull[] = [];
  try {
    pulls = await getJson<ApiPull[]>(`${API}/repos/${repo}/pulls?state=open&per_page=100`);
  } catch {
    // PR annotations are a nicety; branches alone are still usable.
  }

  const pullByBranch = new Map<string, PullInfo>();
  for (const pull of pulls) {
    pullByBranch.set(pull.head.ref, {
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      updatedAt: pull.updated_at,
    });
  }

  const result: BranchInfo[] = branches.map((branch) => ({
    name: branch.name,
    isDefault: branch.name === repoMeta.default_branch,
    pr: pullByBranch.get(branch.name),
  }));

  result.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return b.name.localeCompare(a.name);
  });

  writeCache(repo, result);
  return result;
}

/** Loads the media list for a branch, or the bundled config for LOCAL_SOURCE. */
export async function loadMediaConfig(repo: string | null, source: string): Promise<BranchLoad> {
  const url = source === LOCAL_SOURCE || !repo ? "./config.json" : rawConfigUrl(repo, source);
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Could not load config.json (${response.status} ${response.statusText})`);
  }

  const parsed: unknown = await response.json();
  if (!Array.isArray(parsed)) throw new Error("config.json is not a list of media files");

  return { files: parsed as MediaFile[], source };
}

export function clearBranchCache(repo: string): void {
  try {
    window.sessionStorage.removeItem(`${CACHE_KEY}:${repo}`);
  } catch {
    // Storage disabled; nothing cached to clear.
  }
}

function readCache(repo: string): BranchInfo[] | null {
  try {
    const raw = window.sessionStorage.getItem(`${CACHE_KEY}:${repo}`);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { at: number; branches: BranchInfo[] };
    if (Date.now() - entry.at > CACHE_TTL_MS) return null;
    return entry.branches;
  } catch {
    return null;
  }
}

function writeCache(repo: string, branches: BranchInfo[]): void {
  try {
    window.sessionStorage.setItem(
      `${CACHE_KEY}:${repo}`,
      JSON.stringify({ at: Date.now(), branches })
    );
  } catch {
    // Storage disabled or full; caching is optional.
  }
}
