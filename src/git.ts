import { join, basename, dirname, relative, resolve, sep } from "node:path";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { REPO_RE } from "./validate";

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const DEFAULT_BRANCH_FALLBACK = "main";

// ------------------------------------------------------------
//  Types
// ------------------------------------------------------------

export interface PipelineFile {
  name: string;
  path: string;
  size: number;
  sha: string;
  download_url: string;
}

export interface PipelineSyncResult {
  repository: string;
  directory: string;
  files: number;
  bytes: number;
}

interface ListOptions {
  path?: string;        // root folder to list (default: "pipeline")
  branch?: string;      // branch/tag/commit (default: repo default branch)
  fullPath?: boolean;   // full repo-relative path (default: true)
  token?: string;       // GitHub token for private repos / higher rate limits
}

interface DownloadOptions {
  branch?: string;
  token?: string;
  outDir?: string;      // directory to write into (default: ".")
}

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "bun-pipeline-helper",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseRepository(authorRepo: string): [string, string] {
  if (!REPO_RE.test(authorRepo)) {
    throw new Error('Repository must be in "author/repository" format');
  }
  return authorRepo.split("/") as [string, string];
}

async function getDefaultBranch(
  owner: string,
  repo: string,
  token?: string,
): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch repo info: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { default_branch?: string };
  return data.default_branch || DEFAULT_BRANCH_FALLBACK;
}

// ------------------------------------------------------------
//  List pipelines (recursive, single API call)
// ------------------------------------------------------------

export async function listPipelines(
  authorRepo: string,
  options: ListOptions = {},
): Promise<PipelineFile[]> {
  const { path = "pipeline", branch, fullPath = true, token } = options;

  const [owner, repo] = parseRepository(authorRepo);

  const ref = branch || (await getDefaultBranch(owner, repo, token));

  // Git Trees API with ?recursive=1 returns the entire tree in one request.
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const res = await fetch(url, { headers: authHeaders(token) });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    tree: Array<{ path: string; type: string; sha: string; size?: number }>;
    truncated?: boolean;
  };
  if (data.truncated) throw new Error(`Repository tree is too large to read recursively: ${authorRepo}`);

  const base = path.replace(/^\/+|\/+$/g, "");

  const files = data.tree
    .filter((item) => item.type === "blob")
    .filter((item) => item.path === base || item.path.startsWith(base + "/"));

  return files.map((item) => ({
    name: item.path.split("/").pop()!,
    path: fullPath ? item.path : item.path.slice(base.length + 1),
    size: item.size ?? 0,
    sha: item.sha,
    download_url: `${RAW_BASE}/${owner}/${repo}/${ref}/${item.path}`,
  }));
}

// ------------------------------------------------------------
//  Download a single pipeline
// ------------------------------------------------------------

export async function downloadPipeline(
  authorRepo: string,
  filePath: string,
  options: DownloadOptions = {},
): Promise<string> {
  const { branch, token, outDir = "." } = options;

  const [owner, repo] = parseRepository(authorRepo);

  const ref = branch || (await getDefaultBranch(owner, repo, token));

  const url = `${RAW_BASE}/${owner}/${repo}/${ref}/${filePath}`;
  const res = await fetch(url, { headers: token ? authHeaders(token) : {} });

  if (!res.ok) {
    throw new Error(`Failed to download "${filePath}": ${res.status} ${res.statusText}`);
  }

  // Bun.write() accepts a Response directly — it streams the body to disk.
  // This works for both text and binary files without Base64 decoding.
  await mkdir(outDir, { recursive: true });
  const dest = join(outDir, basename(filePath));
  const bytesWritten = await Bun.write(dest, res);

  console.log(`✔ Saved ${dest} (${bytesWritten} bytes)`);
  return dest;
}

// ------------------------------------------------------------
//  Synchronize a repository's pipeline directory
// ------------------------------------------------------------

export async function syncPipelineRepository(
  authorRepo: string,
  pipelinesDir: string,
  token?: string,
): Promise<PipelineSyncResult> {
  const [owner, repo] = parseRepository(authorRepo);
  const files = await listPipelines(authorRepo, { path: "pipeline", token });
  if (!files.length) throw new Error(`${authorRepo} does not contain any files in "pipeline"`);

  const root = resolve(pipelinesDir);
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".pipeline-sync-"));
  const target = resolve(root, owner, repo);
  if (!target.startsWith(root + sep)) throw new Error(`Invalid pipeline destination for ${authorRepo}`);

  let bytes = 0;
  try {
    for (const file of files) {
      const outputPath = file.path.slice("pipeline/".length);
      const destination = resolve(staging, outputPath);
      if (!destination.startsWith(staging + sep) || relative(staging, destination).startsWith("..")) {
        throw new Error(`Invalid pipeline path from ${authorRepo}: ${file.path}`);
      }
      const response = await fetch(file.download_url, { headers: authHeaders(token) });
      if (!response.ok) {
        throw new Error(`Failed to download "${file.path}": ${response.status} ${response.statusText}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      bytes += await Bun.write(destination, response);
    }

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
  const [owner, repo] = parseRepository(authorRepo);
  const root = resolve(pipelinesDir);
  const target = resolve(root, owner, repo);
  if (!target.startsWith(root + sep)) throw new Error(`Invalid pipeline destination for ${authorRepo}`);
  await rm(target, { recursive: true, force: true });
}