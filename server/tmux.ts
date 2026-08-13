import { runCommand, quoteShellArg, tailFile, makeId, type CommandOutput, type FileTail } from "./utils.js";

type RunCommand = (cmd: string, args?: string[], options?: Record<string, unknown>) => Promise<CommandOutput>;

export type TmuxSessionInfo = {
  name: string;
  windows: number;
  created: number;
  attached: number;
};

export class TmuxManager {
  private run: RunCommand;

  constructor(options: { run?: RunCommand } = {}) {
    this.run = options.run ?? runCommand;
  }

  async startSession({ name, cwd, command, logPath }: { name: string; cwd: string; command?: string; logPath?: string }) {
    await this.run("tmux", ["new-session", "-d", "-s", name, "-c", cwd, command ?? "$SHELL"]);
    if (logPath) {
      await this.run("tmux", ["pipe-pane", "-o", "-t", name, `cat >> ${quoteShellArg(logPath)}`]);
    }
  }

  async sendInput(target: string, text: string) {
    // Use a per-call named buffer (instead of the global tmux buffer) so
    // concurrent sendInput calls across sessions can never clobber one
    // another's payload between the set-buffer/paste-buffer/send-keys steps.
    const bufferName = makeId("agw_input");
    // "--" marks end-of-options so text beginning with "-" (e.g. a line
    // starting with a bullet dash) isn't parsed by tmux as a flag.
    await this.run("tmux", ["set-buffer", "-b", bufferName, "--", text]);
    try {
      // -d deletes the named buffer immediately after pasting so it doesn't
      // linger in the buffer list.
      await this.run("tmux", ["paste-buffer", "-b", bufferName, "-d", "-t", target]);
    } catch (error) {
      await this.run("tmux", ["delete-buffer", "-b", bufferName]).catch(() => {});
      throw error;
    }
    await this.run("tmux", ["send-keys", "-t", target, "Enter"]);
  }

  async sendLiteral(target: string, text: string) {
    await this.run("tmux", ["send-keys", "-t", target, "-l", "--", text]);
  }

  async sendKey(target: string, key: string) {
    await this.run("tmux", ["send-keys", "-t", target, key]);
  }

  async capture(target: string, lines = 200) {
    const result = await this.run("tmux", ["capture-pane", "-t", target, "-p", "-S", `-${lines}`]);
    return result.stdout;
  }

  /**
   * Streams live output for a session by following its on-disk log file
   * (written by the `pipe-pane -o` call in startSession) rather than issuing
   * another `tmux pipe-pane` command. Calling pipe-pane again on the same
   * target replaces whatever pipe is already active, which previously meant
   * every WebSocket connection silently killed session logging. Tailing the
   * log file leaves that pipe untouched no matter how many viewers
   * attach/detach.
   */
  stream(logPath: string): FileTail {
    return tailFile(logPath);
  }

  async killSession(target: string) {
    await this.run("tmux", ["kill-session", "-t", target]);
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    try {
      const result = await this.run("tmux", ["list-sessions", "-F", "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}"]);
      return result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, windows, created, attached] = line.split("|");
          return { name: name ?? "", windows: Number(windows), created: Number(created), attached: Number(attached) };
        });
    } catch {
      return [];
    }
  }
}
