# Experiment report: `<title>`

Copy this template for an experiment record. Apply [evaluation-report-v1](../evaluation-protocol.md); all fields below are placeholders, not observed results. If the copy is stored under `docs/experiments/`, this relative protocol link remains valid. Keep grader truth and raw private telemetry outside the report. Complete the plan before formal trials and append results afterward without overwriting earlier decisions.

## Registration

- Status: planned / running / partial / completed / terminated / superseded
- Experiment ID, owner/custodian and registration timestamp:
- Issue/PR and implementation dependency evidence:
- Question and primary hypothesis:
- Deliverable: engineering validation / diagnostic pilot / reliability / independent transfer
- Acceptance target, stop conditions and non-goals:
- Amendments (timestamp, change, reason, new experiment/version if required):

## Identity and task exposure

- Repository commit; corpus ID/hash or separately versioned change-task manifest:
- Task, truth, grader and reporting versions/hashes (no private contents):
- Model/provider/version; agent/DSH version; resolved agent image; unknown fields:
- Effective profile hashes and context conditions:
- Build/runtime identity and isolation-policy evidence:
- Execution entry point and authoritative eligibility validation:
- Enforced budgets/limits versus observed-only targets:

| Task ID | Opaque causal family | Partition | Prior development exposure | Task/context hash | Evidence custodian reference |
|---|---|---|---|---|---|
| `<task>` | `<family>` | `<partition>` | `<history>` | `<hash>` | `<safe reference>` |

## Predeclared matrix and analysis

| Task | Condition/profile | Trial indices | Model | Wall/token/tool/resource limits | Order |
|---|---|---|---|---|---|
| `<task>` | `<condition>` | `<indices>` | `<model>` | `<limits>` | `<order>` |

- Independent-session and database/workspace reset policy:
- Retry policy (new attempt IDs; predecessors retained):
- Engineering smoke IDs excluded by prior designation:
- Planned counts, pairing, aggregation and uncertainty method:
- Metric definitions/version; cost source and missing-data policy:
- Artifact retention/publication plan:

## Attempt ledger

Append every formal attempt, including failures before agent startup. Retain original verdicts; supplemental cause labels do not change eligibility. If needed, link a sanitized ledger with these fields and its hash.

| Attempt / predecessor | Cell / trial index | Start/end | Raw status / grade | datasetEligible / officialScoredResult | Attributed cause and evidence | Time/cost coverage | Artifact reference |
|---|---|---|---|---|---|---|---|
| `<ID / none>` | `<cell>` | `<times>` | `<raw values>` | `<authoritative values>` | `<cause / unknown>` | `<values / missing>` | `<safe reference>` |

## Results

- Planned / started / pending / cancelled before start:
- Partial or terminated matrix: explain every unfinished cell and its effect on conclusions.

| Task/partition/condition | Attempts A | Eligible E | Discoveries D | End-to-end D/A | Conditional D/E | Eligible E/A | Total cost / coverage | Cost per discovery |
|---|---|---|---|---|---|---|---|---|
| `<group>` | `<count>` | `<count>` | `<count>` | `<rate or N/A>` | `<rate or N/A>` | `<rate or N/A>` | `<measured / incomplete>` | `<cost or no valid discovery>` |

- Counts/rates by original outcome and supplemental cause (including unknown):
- Time to first machine-confirmed valid candidate, if measured:
- Per-task comparisons and uncertainty; small-sample limitations:
- Missing artifacts/costs and any manually reviewed metric calculations:
- Unexpected findings retained for separate adjudication (no automatic target credit):

## Trajectory analysis and decision

- For every miss, timeout, invalid submission or excluded attempt: observations, evidence, likely cause and uncertainty.
- For any success: independent machine confirmation and discovery channel.
- What this experiment supports; what it cannot establish:
- Exposure/pretraining limitations and family/partition implications:
- Decision: retain / reject / inconclusive / further engineering required.
- Next smallest intervention, if justified; unrelated-family validation plan:

## Verification and closure

- Unit / configured historical-case / release-runtime / scripted-agent / real-model checks: list versions, actual results and skips separately.
- Failure signatures, reruns, fixes and residual follow-ups:
- Public-artifact sanitization review and reviewer/date:
- Acceptance checklist mapped to evidence:
- Issue disposition and unresolved work; README/ROADMAP status update if needed:
