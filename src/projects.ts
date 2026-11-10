// A request's session id is Claude Code's session id, which names its transcript: the transcript's cwd gives the project.
import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, sep } from "node:path";

const HOME = homedir();
const TRANSCRIPTS = process.env.PROXDASH_TRANSCRIPTS ?? `${HOME}/.claude-hub/projects`;
const known = new Map<string, string>();

export async function projectOf(sessionId: string): Promise<string | null> {
  const hit = known.get(sessionId);
  if (hit) return hit;
  for await (const path of new Glob(`*/${sessionId}.jsonl`).scan(TRANSCRIPTS)) {
    const cwd = await cwdOf(`${TRANSCRIPTS}/${path}`);
    if (!cwd) return null;
    const name = project(cwd);
    known.set(sessionId, name);
    return name;
  }
  return null;
}

/** Reads until the first line carrying a cwd: lines before it (titles, queued prompts with pasted images) can weigh megabytes. */
async function cwdOf(path: string) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of Bun.file(path).stream()) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop()!;
    for (const line of lines) {
      const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse(`"${m[1]}"`) as string;
    }
  }
  return null;
}

/** The git repository holding cwd (a worktree counts as its main repository), else a name for the folder. */
export function project(cwd: string): string {
  for (let folder = cwd; ; folder = dirname(folder)) {
    const git = `${folder}/.git`;
    if (existsSync(git)) {
      if (statSync(git).isDirectory()) return basename(folder);
      const gitdir = readFileSync(git, "utf8").replace(/^gitdir:/, "").trim();
      return gitdir.includes("/.git/worktrees/") ? basename(gitdir.split("/.git/worktrees/")[0]!) : basename(folder);
    }
    if (folder === HOME || folder === dirname(folder)) break;
  }
  const rel = relative(HOME, cwd);
  if (rel.startsWith("..")) return basename(cwd) || "/";
  const parts = rel ? rel.split(sep) : [];
  if (parts.length === 0) return "home";
  if (parts[0] === ".t3" && parts[1] === "worktrees" && parts[2]) return parts[2];
  if (parts[0] === ".t3" && parts[1] === "scratch") return "scratch";
  return basename(cwd);
}
