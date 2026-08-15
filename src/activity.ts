type EventWithPayload = {
  payload?: { preview?: string };
};

type SessionInfo = {
  agent: string;
  status: string;
};

export function stripAnsi(value: string) {
  return String(value || "").replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function cleanAgentOutput(output: string, userEvents: EventWithPayload[]) {
  let value = stripAnsi(output)
    .replace(/\r/g, "\n")
    .replace(/\n?Attached (?:image )?file paths:\n(?:\d+\.\s+.*(?:\n|$))+/g, "\n")
    .replace(/^.*\d+\.\s+.*(?:attachments|agent-gateway|honeyrail).*$/gm, "")
    .replace(/^.*command not found: (?:Attached|\d+\.|describe|inspect|look).*$/gm, "")
    .replace(/^diff --git .*$/gm, "")
    .replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/gm, "")
    .replace(/^@@.*$/gm, "")
    .replace(/^[+-](?![+-]).*$/gm, "")
    .replace(/^.*\b(Ran|Viewed|Tool|tool call|code file|file change|transcript)\b.*$/gim, "")
    .replace(/^.*\b(npm run build|git diff --check|git status --short)\b.*$/gim, "")
    .replace(/^.*\b(?:src\/|server\/|dist\/).*$/gim, "")
    .replace(/^\[dev:server\].*$/gm, "")
    .replace(/^NotFoundError: Not Found[\s\S]*?(?=\n\S|$)/gm, "")
    .replace(/^\s+at .+$/gm, "")
    .replace(/^\S+@\S+:[^$#%]*[#$%⇥].*$/gm, "")
    .replace(/^\s*$/gm, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  for (const event of userEvents) {
    const preview = event.payload?.preview?.trim();
    if (preview) {
      value = value.replaceAll(preview, "").trim();
    }
  }

  const lowSignal = [
    "$",
    "%",
    "zsh",
    "bash",
    "Last login:"
  ];
  if (lowSignal.some((item) => value === item || value.endsWith(`\n${item}`))) return "";
  return value;
}

export function cleanRuntimeOutput(output: string) {
  return stripAnsi(output)
    .replace(/\n?Attached (?:image )?file paths:\n(?:\d+\.\s+.*(?:\n|$))+/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[\s─-╿]*Worked for\s+(.+?)\s*[─-╿\s]*$/u, "Worked for $1").trimEnd())
    .filter((line) => !/^[\s\-=_⋮─-╿⎺-⎽—―⸏⎯⎼⎽␥　]*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function agentActivityText({ selected, selectedIsRunning, output, userPrompts }: {
  selected: SessionInfo | null | undefined;
  selectedIsRunning: boolean;
  output: string;
  userPrompts: EventWithPayload[];
}) {
  if (!selected) return null;
  const cleaned = cleanAgentOutput(cleanRuntimeOutput(output), userPrompts);
  if (cleaned) return cleaned;
  if (selected.agent === "shell") {
    return selectedIsRunning ? null : `Shell session is ${selected.status}.`;
  }
  if (!userPrompts.length) return "Ready. Send a message or attach an image to start.";
  if (selectedIsRunning) return "Message delivered. Waiting for the agent response.";
  return `Session is ${selected.status}.`;
}
