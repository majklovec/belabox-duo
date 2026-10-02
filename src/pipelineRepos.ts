/*
 * Pipeline repositories: GitHub repos whose `pipeline/` directory is mirrored into
 * PIPELINES_DIR/<owner>/<repo> (settings page → pipelines.repositories.*).
 */
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { REPO_RE } from "./validate";

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const DEFAULT_BRANCH_FALLBACK = "main";
const SOURCE_DIR = "pipeline";
const DOWNLOAD_CONCURRENCY = 8;

export interface PipelineSyncResult {
  repository: string;
  directory: string;
  files: number;
  bytes: number;
}

interface RepoFile {
  path: string;   // repo-relative, under SOURCE_DIR
  url: string;    // raw download URL
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "bun-pipeline-helper",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseRepository(authorRepo: string): [string, string] {
  if (!REPO_RE.test(authorRepo)) throw new Error('Repository must be in "author/repository" format');
  return authorRepo.split("/") as [string, string];
}

/** PIPELINES_DIR/<owner>/<repo>, refusing anything that would escape the pipelines root. */
function repositoryDir(authorRepo: string, pipelinesDir: string): { root: string; target: string } {
  const [owner, repo] = parseRepository(authorRepo);
  const root = resolve(pipelinesDir);
  const target = resolve(root, owner, repo);
  if (!target.startsWith(root + sep)) throw new Error(`Invalid pipeline destination for ${authorRepo}`);
  return { root, target };
}

async function getJson<T>(url: string, token: string | undefined, what: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`${what}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** All files under the repository's pipeline directory (one recursive Git Trees API call). */
async function listRepoFiles(authorRepo: string, token?: string): Promise<RepoFile[]> {
  const [owner, repo] = parseRepository(authorRepo);
  const info = await getJson<{ default_branch?: string }>(
    `${GITHUB_API}/repos/${owner}/${repo}`, token, "Failed to fetch repo info");
  const ref = info.default_branch || DEFAULT_BRANCH_FALLBACK;
  const data = await getJson<{ tree: { path: string; type: string }[]; truncated?: boolean }>(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, token, "GitHub API error");
  if (data.truncated) throw new Error(`Repository tree is too large to read recursively: ${authorRepo}`);
  return data.tree
    .filter((item) => item.type === "blob" && item.path.startsWith(`${SOURCE_DIR}/`))
    .map((item) => ({ path: item.path, url: `${RAW_BASE}/${owner}/${repo}/${ref}/${item.path}` }));
}

/** Run `fn` over `items` with at most `limit` in flight; stops at the first failure and
 *  rethrows it once every running call has settled. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      try {
        await fn(items[next++]);
      } catch (error: unknown) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}

/** Download the repository's pipelines into a staging dir, then swap it in atomically. */
export async function syncPipelineRepository(
  authorRepo: string,
  pipelinesDir: string,
  token?: string,
): Promise<PipelineSyncResult> {
  const { root, target } = repositoryDir(authorRepo, pipelinesDir);
  const files = await listRepoFiles(authorRepo, token);
  if (!files.length) throw new Error(`${authorRepo} does not contain any files in "${SOURCE_DIR}"`);

  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".pipeline-sync-"));
  let bytes = 0;
  try {
    await eachLimited(files, DOWNLOAD_CONCURRENCY, async (file) => {
      const destination = resolve(staging, file.path.slice(SOURCE_DIR.length + 1));
      if (!destination.startsWith(staging + sep) || relative(staging, destination).startsWith("..")) {
        throw new Error(`Invalid pipeline path from ${authorRepo}: ${file.path}`);
      }
      const response = await fetch(file.url, { headers: authHeaders(token) });
      if (!response.ok) {
        throw new Error(`Failed to download "${file.path}": ${response.status} ${response.statusText}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      const written = await Bun.write(destination, response);
      bytes += written;
    });
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { repository: authorRepo, directory: target, files: files.length, bytes };
}

export async function removePipelineRepository(authorRepo: string, pipelinesDir: string): Promise<void> {
  await rm(repositoryDir(authorRepo, pipelinesDir).target, { recursive: true, force: true });
}
