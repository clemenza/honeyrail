import { join } from "node:path";
import type { CheckRun, Project } from "./types.js";
import { branchTimestamp, runCommandSafe, slugify, type CommandOptions, type SafeCommandOutput } from "./utils.js";

type WorktreeError = Error & { code?: number | string; status?: number };
type SafeRunCommand = (cmd: string, args?: string[], options?: CommandOptions) => Promise<SafeCommandOutput>;

type WorktreeRef = {
    path: string;
    branch: string;
    baseRevision?: string;
};

const projectMergeLocks = new Map<string, Promise<void>>();

function nowIso() {
    return new Date().toISOString();
}

function normalizeShellCommand(command: unknown) {
    return String(command || "").trim();
}

export class WorktreeManager {
    private root: string;
    private run: SafeRunCommand;

    constructor({ root, run = runCommandSafe }: { root: string; run?: SafeRunCommand }) {
        this.root = root;
        this.run = run;
    }

    async checkedRun(cmd: string, args: string[], options?: CommandOptions) {
        const result = await this.run(cmd, args, options);
        if (!result.ok) {
            const error = new Error(result.stderr || result.stdout || `${cmd} ${args.join(" ")} failed`) as WorktreeError;
            error.code = result.code;
            throw error;
        }
        return result;
    }

    async create({ project, title, agent, baseBranch }: { project: Project; title: string; agent: string; baseBranch?: string }) {
        const slug = slugify(title);
        const base = baseBranch || project.defaultBranch;
        const branch = `${agent}/${slug}-${branchTimestamp()}`;
        const worktreePath = join(this.root, `${project.name}-${branch.replaceAll("/", "_")}`.slice(0, 100));
        const baseRevision = await this.checkedRun("git", ["rev-parse", base], { cwd: project.repoPath });

        await this.checkedRun("git", ["worktree", "add", "-b", branch, worktreePath, base], { cwd: project.repoPath });

        return {
            path: worktreePath,
            branch,
            projectId: project.id,
            baseBranch: base,
            baseRevision: baseRevision.stdout.trim(),
            title,
            agent
        };
    }

    async diff(worktreeInput: string | WorktreeRef) {
        const worktreePath = typeof worktreeInput === "string" ? worktreeInput : worktreeInput.path;
        const baseRevision = typeof worktreeInput === "string" ? "" : String(worktreeInput.baseRevision || "").trim();
        // A single-ref `git diff <baseRevision>` (no "..HEAD") compares that
        // revision against the working tree, so it includes uncommitted
        // changes - unlike `<baseRevision>..HEAD`, which only sees commits
        // and stays empty for the entire life of a task, since agents don't
        // commit on their own (they leave that to an explicit commit/merge
        // step). Using "..HEAD" here made this always report no diff for a
        // normal, still-uncommitted run.
        const diffArgs = baseRevision ? ["diff", baseRevision] : ["diff"];
        const diffStatArgs = baseRevision ? ["diff", "--stat", baseRevision] : ["diff", "--stat"];
        // Even the single-ref form above shows nothing for a brand-new,
        // never-`git add`ed file - `git diff` never includes untracked
        // paths. `git add -N` (intent-to-add) marks them tracked-but-empty
        // without staging content, which is enough for them to show up as
        // full additions in the diff; `git reset` afterward restores the
        // index to how it was, so calling diff() has no lasting side effect
        // on the worktree (a later `git add -A` + commit is unaffected
        // either way, since it always restages everything itself).
        await this.run("git", ["add", "-N", "-A"], { cwd: worktreePath });
        const diff = await this.checkedRun("git", diffArgs, { cwd: worktreePath });
        const diffStat = await this.checkedRun("git", diffStatArgs, { cwd: worktreePath });
        const status = await this.checkedRun("git", ["status", "--short"], { cwd: worktreePath });
        const commits = await this.run("git", ["log", "--oneline", "--decorate", "--max-count=20"], { cwd: worktreePath });
        await this.run("git", ["reset"], { cwd: worktreePath });
        return {
            diff: diff.stdout,
            diffStat: diffStat.stdout,
            status: status.stdout,
            commits: commits.ok ? commits.stdout : ""
        };
    }

    async commit({ worktree, message }: { worktree: WorktreeRef & { title?: string }; message?: string }) {
        const commitMessage = normalizeShellCommand(message) || `Complete ${worktree.title || worktree.branch || "agent task"}`;
        await this.checkedRun("git", ["add", "-A"], { cwd: worktree.path });
        const status = await this.checkedRun("git", ["status", "--porcelain"], { cwd: worktree.path });
        if (!status.stdout.trim()) {
            const error = new Error("Worktree has no changes to commit.") as WorktreeError;
            error.status = 409;
            throw error;
        }
        const commit = await this.checkedRun("git", ["commit", "-m", commitMessage], { cwd: worktree.path });
        const head = await this.checkedRun("git", ["rev-parse", "HEAD"], { cwd: worktree.path });
        return {
            message: commitMessage,
            headRevision: head.stdout.trim(),
            stdout: commit.stdout,
            stderr: commit.stderr
        };
    }

    async runChecks({ worktree, commands }: { worktree: WorktreeRef; commands: unknown[] }) {
        const normalized = (Array.isArray(commands) ? commands : [])
            .map(normalizeShellCommand)
            .filter(Boolean);
        const runs: CheckRun[] = [];
        for (const command of normalized) {
            const startedAt = nowIso();
            const result = await this.run("sh", ["-lc", command], { cwd: worktree.path, timeout: 1000 * 60 * 10, maxBuffer: 1024 * 1024 * 16 });
            runs.push({
                command,
                status: result.ok ? "passed" : "failed",
                exitCode: result.code ?? (result.ok ? 0 : 1),
                stdout: result.stdout,
                stderr: result.stderr,
                startedAt,
                finishedAt: nowIso()
            });
        }
        return {
            ok: runs.every((run) => run.status === "passed"),
            runs
        };
    }

    async discard({ project, worktree, force = false }: { project: Project; worktree: WorktreeRef; force?: boolean }) {
        const status = await this.run("git", ["status", "--porcelain"], { cwd: worktree.path });
        if (status.ok && status.stdout.trim() && !force) {
            const error = new Error("Worktree has uncommitted changes. Commit them or pass force=true before discarding.") as WorktreeError;
            error.status = 409;
            throw error;
        }

        const removeArgs = ["worktree", "remove"];
        if (force) removeArgs.push("--force");
        removeArgs.push(worktree.path);
        const remove = await this.checkedRun("git", removeArgs, { cwd: project.repoPath });

        let deleteBranch: SafeCommandOutput = { ok: true, stdout: "", stderr: "" };
        if (worktree.branch) {
            deleteBranch = await this.run("git", ["branch", force ? "-D" : "-d", worktree.branch], { cwd: project.repoPath });
        }

        return {
            path: worktree.path,
            branch: worktree.branch,
            removed: remove.stdout,
            branchDeleted: deleteBranch.ok,
            branchDeleteOutput: deleteBranch.stdout || deleteBranch.stderr
        };
    }

    async merge({ project, worktree, targetBranch }: { project: Project; worktree: WorktreeRef; targetBranch?: string }) {
        const previousLock = projectMergeLocks.get(project.repoPath) || Promise.resolve();
        let releaseLock: () => void = () => {};
        const currentLock = previousLock.then(() => new Promise<void>((resolve) => {
            releaseLock = resolve;
        }));
        projectMergeLocks.set(project.repoPath, currentLock);
        await previousLock;

        try {
            const projectStatus = await this.checkedRun("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: project.repoPath });
            if (projectStatus.stdout.trim()) {
                const error = new Error("Project repository has uncommitted changes. Commit or stash them before merging a worktree.") as WorktreeError;
                error.status = 409;
                throw error;
            }

            const worktreeStatus = await this.checkedRun("git", ["status", "--porcelain"], { cwd: worktree.path });
            if (worktreeStatus.stdout.trim()) {
                const error = new Error("Worktree has uncommitted changes. Commit them in the worktree before merging.") as WorktreeError;
                error.status = 409;
                throw error;
            }

            const originalBranch = (await this.checkedRun("git", ["branch", "--show-current"], { cwd: project.repoPath })).stdout.trim();
            const requestedTarget = String(targetBranch || "").trim();
            let mergeBranch = originalBranch;
            if (requestedTarget) {
                await this.checkedRun("git", ["checkout", requestedTarget], { cwd: project.repoPath });
                mergeBranch = requestedTarget;
            }

            const result = await this.run("git", ["merge", "--no-ff", "--no-edit", worktree.branch], { cwd: project.repoPath });
            if (!result.ok) {
                await this.run("git", ["merge", "--abort"], { cwd: project.repoPath });
                if (requestedTarget && originalBranch && originalBranch !== requestedTarget) {
                    await this.run("git", ["checkout", originalBranch], { cwd: project.repoPath });
                }
                const error = new Error(result.stderr || result.stdout || "Worktree merge failed.") as WorktreeError;
                error.status = 409;
                throw error;
            }

            return {
                branch: worktree.branch,
                targetBranch: mergeBranch,
                stdout: result.stdout,
                stderr: result.stderr
            };
        } finally {
            releaseLock();
            if (projectMergeLocks.get(project.repoPath) === currentLock) {
                projectMergeLocks.delete(project.repoPath);
            }
        }
    }
}
