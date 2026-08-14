import { readFile, writeFile } from "node:fs/promises";
import type { Artifact, Evaluation, EventInput, Evidence, GatewayEvent, Project, QualityGateDecision, Run, Session, Step, Store, Task, Worktree } from "./types.js";
import { makeId } from "./utils.js";

type StoreData = {
    settings: Record<string, unknown>;
    projects: Project[];
    runs: Run[];
    steps: Step[];
    artifacts: Artifact[];
    evidence: Evidence[];
    evaluations: Evaluation[];
    qualityGateDecisions: QualityGateDecision[];
    sessions: Session[];
    tasks: Task[];
    worktrees: Worktree[];
    events: GatewayEvent[];
};

export class JsonStore implements Store {
    private filePath: string;
    private data: StoreData;

    constructor(filePath: string) {
        this.filePath = filePath;
        this.data = { settings: {}, projects: [], runs: [], steps: [], artifacts: [], evidence: [], evaluations: [], qualityGateDecisions: [], sessions: [], tasks: [], worktrees: [], events: [] };
        this._load();
    }

    async _load() {
        try {
            const content = await readFile(this.filePath, "utf-8");
            this.data = {
                settings: {},
                projects: [],
                runs: [],
                steps: [],
                artifacts: [],
                evidence: [],
                evaluations: [],
                qualityGateDecisions: [],
                sessions: [],
                tasks: [],
                worktrees: [],
                events: [],
                ...JSON.parse(content)
            };
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                console.error("Failed to load JSON store:", error);
            }
        }
    }

    async getSettings(): Promise<Record<string, unknown>> {
        return this.data.settings || {};
    }

    async updateSettings(updates: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.data.settings = { ...(this.data.settings || {}), ...updates };
        await this._save();
        return this.data.settings;
    }

    async _save() {
        await writeFile(this.filePath, JSON.stringify(this.data, null, 2));
    }

    async listProjects(): Promise<Project[]> {
        return this.data.projects || [];
    }

    async createProject(input: Partial<Project> & Pick<Project, "name" | "repoPath">): Promise<Project> {
        const project = { id: makeId("proj"), ...input } as Project;
        this.data.projects.push(project);
        await this._save();
        return project;
    }

    async getProject(id: string): Promise<Project | undefined> {
        return this.data.projects.find(p => p.id === id);
    }

    async deleteProject(id: string): Promise<Project | null> {
        const index = this.data.projects.findIndex(p => p.id === id);
        if (index === -1) return null;
        const [project] = this.data.projects.splice(index, 1);
        await this._save();
        return project;
    }

    async listRuns(projectId?: string): Promise<Run[]> {
        const runs = this.data.runs || [];
        return projectId ? runs.filter((run) => run.projectId === projectId) : runs;
    }

    async createRun(input: Partial<Run> & Pick<Run, "projectId" | "goal">): Promise<Run> {
        const run = {
            id: input.id || makeId("run"),
            status: "pending",
            createdAt: new Date().toISOString(),
            ...input
        } as Run;
        this.data.runs = this.data.runs || [];
        this.data.runs.push(run);
        await this._save();
        return run;
    }

    async getRun(id: string): Promise<Run | undefined> {
        return (this.data.runs || []).find((run) => run.id === id);
    }

    async updateRun(id: string, updates: Partial<Run>): Promise<Run | undefined> {
        const run = await this.getRun(id);
        if (run) {
            Object.assign(run, updates);
            await this._save();
        }
        return run;
    }

    async createStep(input: Partial<Step> & Pick<Step, "id" | "runId" | "name" | "executor">): Promise<Step> {
        const step = {
            input: {},
            dependsOn: [],
            status: "pending",
            attempt: 0,
            maxAttempts: 1,
            createdAt: new Date().toISOString(),
            ...input
        } as Step;
        this.data.steps = this.data.steps || [];
        this.data.steps.push(step);
        await this._save();
        return step;
    }

    async listSteps(runId: string): Promise<Step[]> {
        return (this.data.steps || []).filter((step) => step.runId === runId);
    }

    async getStep(runId: string, stepId: string): Promise<Step | undefined> {
        return (this.data.steps || []).find((step) => step.runId === runId && step.id === stepId);
    }

    async updateStep(runId: string, stepId: string, updates: Partial<Step>): Promise<Step | undefined> {
        const step = await this.getStep(runId, stepId);
        if (step) {
            Object.assign(step, updates);
            await this._save();
        }
        return step;
    }

    async createArtifact(input: Partial<Artifact> & Pick<Artifact, "runId" | "kind" | "name">): Promise<Artifact> {
        const artifact = { id: input.id || makeId("art"), createdAt: new Date().toISOString(), ...input } as Artifact;
        this.data.artifacts = this.data.artifacts || [];
        this.data.artifacts.push(artifact);
        await this._save();
        return artifact;
    }

    async listArtifacts(runId: string, stepId?: string): Promise<Artifact[]> {
        const artifacts = (this.data.artifacts || []).filter((artifact) => artifact.runId === runId);
        return stepId ? artifacts.filter((artifact) => artifact.stepId === stepId) : artifacts;
    }

    async getArtifact(id: string): Promise<Artifact | undefined> {
        return (this.data.artifacts || []).find((artifact) => artifact.id === id);
    }

    async createEvidence(input: Partial<Evidence> & Pick<Evidence, "runId" | "kind">): Promise<Evidence> {
        const evidence = { id: input.id || makeId("evd"), createdAt: new Date().toISOString(), ...input } as Evidence;
        this.data.evidence = this.data.evidence || [];
        this.data.evidence.push(evidence);
        await this._save();
        return evidence;
    }

    async listEvidence(runId: string, stepId?: string): Promise<Evidence[]> {
        const evidence = (this.data.evidence || []).filter((item) => item.runId === runId);
        return stepId ? evidence.filter((item) => item.stepId === stepId) : evidence;
    }

    async createEvaluation(input: Partial<Evaluation> & Pick<Evaluation, "runId" | "evaluator" | "status">): Promise<Evaluation> {
        const evaluation = { id: input.id || makeId("eval"), createdAt: new Date().toISOString(), ...input } as Evaluation;
        this.data.evaluations = this.data.evaluations || [];
        this.data.evaluations.push(evaluation);
        await this._save();
        return evaluation;
    }

    async listEvaluations(runId: string, stepId?: string): Promise<Evaluation[]> {
        const evaluations = (this.data.evaluations || []).filter((item) => item.runId === runId);
        return stepId ? evaluations.filter((item) => item.stepId === stepId) : evaluations;
    }

    async createQualityGateDecision(input: Partial<QualityGateDecision> & Pick<QualityGateDecision, "runId" | "stepId" | "attempt" | "status" | "evaluationIds" | "decidedBy">): Promise<QualityGateDecision> {
        const decision = { id: input.id || makeId("qgd"), createdAt: new Date().toISOString(), reason: undefined, ...input } as QualityGateDecision;
        this.data.qualityGateDecisions = this.data.qualityGateDecisions || [];
        this.data.qualityGateDecisions.push(decision);
        await this._save();
        return decision;
    }

    async listQualityGateDecisions(runId: string, stepId?: string): Promise<QualityGateDecision[]> {
        const decisions = (this.data.qualityGateDecisions || []).filter((item) => item.runId === runId);
        return stepId ? decisions.filter((item) => item.stepId === stepId) : decisions;
    }

    async listSessions(): Promise<Session[]> {
        return this.data.sessions || [];
    }

    async createSession(input: Partial<Session> & { id?: string }): Promise<Session> {
        const session = { id: makeId("sess"), createdAt: new Date().toISOString(), ...input } as Session;
        this.data.sessions.push(session);
        await this._save();
        return session;
    }

    async getSession(id: string): Promise<Session | undefined> {
        return this.data.sessions.find(s => s.id === id);
    }

    async updateSession(id: string, updates: Partial<Session>): Promise<Session | undefined> {
        const session = await this.getSession(id);
        if (session) {
            Object.assign(session, updates);
            await this._save();
        }
        return session;
    }

    async deleteSession(id: string): Promise<Session | null> {
        const index = this.data.sessions.findIndex(s => s.id === id);
        if (index === -1) return null;
        const [session] = this.data.sessions.splice(index, 1);
        await this._save();
        return session;
    }

    async listTasks(): Promise<Task[]> {
        return this.data.tasks || [];
    }

    async createTask(input: Partial<Task> & { id?: string }): Promise<Task> {
        const task = { id: makeId("task"), createdAt: new Date().toISOString(), ...input } as Task;
        this.data.tasks.push(task);
        await this._save();
        return task;
    }

    async getTask(id: string): Promise<Task | undefined> {
        return (this.data.tasks || []).find(t => t.id === id);
    }

    async updateTask(id: string, updates: Partial<Task>): Promise<Task | undefined> {
        const task = this.data.tasks.find(t => t.id === id);
        if (task) {
            Object.assign(task, updates);
            await this._save();
        }
        return task;
    }

    async listWorktrees(projectId?: string): Promise<Worktree[]> {
        const worktrees = this.data.worktrees || [];
        if (!projectId) return worktrees;
        return worktrees.filter(w => w.projectId === projectId);
    }

    async createWorktree(input: Partial<Worktree> & { id?: string; project_id?: string }): Promise<Worktree> {
        const { project_id, ...rest } = input;
        const worktree = {
            id: makeId("wt"),
            createdAt: new Date().toISOString(),
            status: "created" as const,
            ...rest,
            projectId: rest.projectId || project_id
        } as Worktree;
        this.data.worktrees = this.data.worktrees || [];
        this.data.worktrees.push(worktree);
        await this._save();
        return worktree;
    }

    async getWorktree(id: string): Promise<Worktree | undefined> {
        return (this.data.worktrees || []).find(w => w.id === id);
    }

    async updateWorktree(id: string, updates: Partial<Worktree>): Promise<Worktree | undefined> {
        const worktree = await this.getWorktree(id);
        if (worktree) {
            Object.assign(worktree, updates);
            await this._save();
        }
        return worktree;
    }

    async appendEvent(input: EventInput): Promise<GatewayEvent> {
        const event = { id: makeId("evt"), createdAt: new Date().toISOString(), payload: {}, ...input } as GatewayEvent;
        this.data.events.push(event);
        if (this.data.events.length > 200) {
            this.data.events.splice(0, this.data.events.length - 200);
        }
        await this._save();
        return event;
    }

    async listEvents(limit = 50): Promise<GatewayEvent[]> {
        return (this.data.events || []).slice(-limit);
    }
}
