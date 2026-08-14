# Orchestration DAG Example

This example creates a real M2 Run through the REST API. It uses the existing Task/Session/Worktree lifecycle as the first step, then reuses the produced `worktreeId` in the check step, evaluates the check evidence, applies a quality gate, and finally blocks for operator approval.

Prerequisites:

- HoneyRail is running on the default port `4178`.
- A project is already registered in HoneyRail.
- The repository is a Git worktree. The example uses `git diff --check`, so it does not require dependencies to be installed in the isolated worktree.

Get a project ID:

```sh
curl -fsS http://127.0.0.1:4178/api/projects | jq -r '.projects[0].id'
```

Create the Run:

```sh
PROJECT_ID="$(curl -fsS http://127.0.0.1:4178/api/projects | jq -r '.projects[0].id')"

curl -fsS http://127.0.0.1:4178/api/runs \
  -H 'content-type: application/json' \
  -d @- <<JSON
{
  "projectId": "$PROJECT_ID",
  "goal": "Implement a small documentation improvement, verify it, then wait for approval",
  "steps": [
    {
      "id": "implement",
      "name": "Implement docs change",
      "executor": "agent-task",
      "input": {
        "agent": "codex",
        "title": "Document one missing operator workflow",
        "prompt": "Add or improve one concise operator-facing documentation note. Keep the change scoped and report the files changed when complete."
      }
    },
    {
      "id": "verify",
      "name": "Run project checks",
      "executor": "check",
      "dependsOn": ["implement"],
      "input": {
        "commands": [
          "git diff --check"
        ]
      },
      "qualityGate": {
        "evaluators": [
          { "type": "check" }
        ],
        "onFail": "fail"
      }
    },
    {
      "id": "operator_approval",
      "name": "Approve verified work",
      "executor": "approval",
      "dependsOn": ["verify"]
    }
  ]
}
JSON
```

The `verify` step does not need an explicit `worktreeId`. When `implement` succeeds, its executor output includes `worktreeId`; the scheduler copies dependency output into downstream step input when a key is not already set.

The `verify` step demonstrates the M2 verification loop:

- the `check` executor emits a log Artifact for `git diff --check`
- it records `check.command` Evidence with command status, exit code, and duration
- the `check` evaluator persists an Evaluation
- the quality gate lets `operator_approval` proceed only when the Evaluation passes

Inspect the Run:

```sh
RUN_ID="<run id from create response>"
curl -fsS "http://127.0.0.1:4178/api/runs/$RUN_ID" | jq
```

Inspect M2 verification data:

```sh
curl -fsS "http://127.0.0.1:4178/api/runs/$RUN_ID/artifacts?stepId=verify" | jq
curl -fsS "http://127.0.0.1:4178/api/runs/$RUN_ID/evidence?stepId=verify" | jq
curl -fsS "http://127.0.0.1:4178/api/runs/$RUN_ID/evaluations?stepId=verify" | jq
```

Approve the final barrier after reviewing the worktree and check output:

```sh
curl -fsS -X POST "http://127.0.0.1:4178/api/runs/$RUN_ID/steps/operator_approval/approve" | jq
```

Reject instead:

```sh
curl -fsS -X POST "http://127.0.0.1:4178/api/runs/$RUN_ID/steps/operator_approval/reject" \
  -H 'content-type: application/json' \
  -d '{"reason":"Needs another pass"}' | jq
```
