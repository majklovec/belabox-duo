import { join, basename } from "node:path";
import { mkdir } from "node:fs/promises";

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const DEFAULT_BRANCH_FALLBACK = "main";

// ------------------------------------------------------------
//  Types
// ------------------------------------------------------------

interface PipelineFile {
  name: string;
  path: string;
  size: number;
  sha: string;
  download_url: string;
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

  const [owner, repo] = authorRepo.split("/");
  if (!owner || !repo) {
    throw new Error('Parameter must be in "author/repo" format');
  }

  const ref = branch || (await getDefaultBranch(owner, repo, token));

  // Git Trees API with ?recursive=1 returns the entire tree in one request.
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const res = await fetch(url, { headers: authHeaders(token) });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    tree: Array<{ path: string; type: string; sha: string; size?: number }>;
  };

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

  const [owner, repo] = authorRepo.split("/");
  if (!owner || !repo) {
    throw new Error('Parameter must be in "author/repo" format');
  }

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