# Paper outline

Working title:

> **From Change Context to Reproducers: Evaluating AI Database Test Engineers on Historical PostgreSQL Bugs**

Alternative:

> **Do Development Artifacts Help AI Database Test Engineers? An Empirical Study on Historical PostgreSQL Regressions**

## 1. Introduction

Motivation:
- AI coding capability does not imply AI software-testing capability.
- Database correctness testing requires converting requirements and implementation changes into invariants, discriminating experiments, and reproducible behavioral evidence.
- Binary success metrics can hide large differences in source-reading, localization, hypothesis formation, and reproducer construction.

Problem statement:
- What development context should an AI Database Test Engineer receive?
- Does more context improve verified bug rediscovery, or merely make reasoning more focused/plausible?
- When rediscovery fails, which testing stage is actually responsible?

Contributions to target:
1. **HistoricalChangeTask formulation**: contemporaneous requirement + introducing change-set + buggy PostgreSQL source/runtime, with future truth withheld and deterministic historical/reference grading.
2. **Controlled evaluation protocol**: preregistration, immutable experiment identity, restricted egress, all-attempt accounting, failure attribution, causal-family exposure discipline, and inspectable trajectories.
3. **Empirical observations across unrelated PostgreSQL bug families**: specification-only context shows no measured benefit in the current pilots; introducing diffs consistently focus investigation and improve efficiency, with stronger localization in one family; generic methodology adds cost without measured benefit in both families.
4. **Process-level capability analysis**: repeated evidence that plausible diagnosis does not guarantee grader-valid rediscovery because observable/reproducer construction remains a downstream bottleneck.

## 2. Background and related work

Cover:
- LLM/coding-agent software engineering benchmarks.
- Agent evaluation on repositories and issue resolution.
- Automated software testing and test-generation agents.
- Database testing: differential/metamorphic/oracle-based testing and PostgreSQL regression practices.
- Historical bug benchmarks and contamination/pretraining limitations.

Do not position HoneyRail as a generic agent framework paper.

## 3. HistoricalChangeTask

Define the task:

```text
contemporaneous SPEC
+ introducing implementation change-set
+ post-change historical PostgreSQL source/runtime
+ hidden future truth/reference
        -> AI Database Test Engineer
        -> finding + executable reproducer
```

Describe:
- historically consistent source/change-set pairing;
- contemporaneous-only requirement context;
- complete introducing diff rather than hindsight-narrowed patches;
- agent/private truth separation;
- historical/reference execution and deterministic attribution;
- why the task approximates a database test engineer working near feature introduction time.

## 4. Experimental methodology

### 4.1 Conditions
- E0: source + neutral prompt.
- E1: + contemporaneous SPEC.
- E2: + full introducing change-set.
- E3: + frozen generic Test-Engineer HarnessProfile.

### 4.2 Controls
- independent sessions;
- fixed model/backend/runtime per study;
- fixed timeout and execution order;
- restricted model egress;
- immutable task/environment hashes;
- explicit retry/all-attempt accounting;
- no mid-experiment tuning.

### 4.3 Primary outcomes
Authoritative grader classifications only.

### 4.4 Secondary process analysis
Stage chain:

```text
requirement/change understanding
-> source/change-impact localization
-> correctness-invariant formulation
-> discriminating-observable selection
-> historical/reference differential experiment
-> reproducer minimization
-> machine-checkable submission
```

### 4.5 Metrics
- End-to-End Budget Success.
- Eligible Sample Rate.
- Conditional Historical Bug Rediscovery.
- wall time, steps/turns, token/tool usage where available.
- stage-wise evidence-backed process classification.

## 5. Study subjects

### Study 1: postgres-change-001 / BUG #16867
- causal family: transaction chaining × SAVEPOINT / transaction state machine.
- introducing commit: `280a408b48d5ee42969f981bceb9e9426c3a344c`.
- grading protocol: `submitted-reproducer-structured-oracle-v1`.

### Study 2: postgres-change-002 / BUG #18574
- causal family: PL/pgSQL CALL cached-plan invalidation after DDL.
- introducing commit: `ee895a655ce4341546facd6f23e3e8f2931b96bf`.
- grading protocol: `submitted-reproducer-behavioral-oracle-v1`.

Explain why the two families are intentionally unrelated and why using two distinct oracle protocols is useful for interpreting recurring downstream failure patterns.

## 6. Results

Organize by research question rather than by bug.

### RQ1 — What does contemporaneous SPEC context add?
Current observation: no positive rediscovery/localization effect in either pilot; E1 costs more than E0 in both.

### RQ2 — What does the introducing change-set add?
Current observation: E2 reduces exploration cost in both studies; in Study 2 it also changes diagnosis from an adjacent non-target defect to the actual fixed function.

### RQ3 — Does generic test-engineering methodology add value beyond context?
Current observation: E3 increases wall/decode-token cost relative to E2 in both studies without measured outcome/localization gain.

### RQ4 — Why does verified rediscovery fail despite strong diagnosis?
Current observation: recurring downstream observable/reproducer-output-shape gap across two unrelated families and two grading protocols.

## 7. Cross-family analysis

Separate:
- replicated directional observations;
- one-study-only observations;
- primary grader outcome vs diagnostic process evidence;
- evidence supporting a reusable capability-gap hypothesis;
- evidence still requiring a third unrelated family.

## 8. Discussion

Topics:
- Development artifacts may improve focus before they improve success.
- More methodology text can increase inference cost without repairing the actual bottleneck.
- AI Test Engineer evaluation should score not only diagnosis but construction of externally observable, revision-discriminating evidence.
- Binary bug-discovery outcomes need trajectory/process attribution to diagnose capability.
- How PostgreSQL observations should pull narrowly scoped Capability Lab tasks.

## 9. Threats to validity

Include:
- `n=1` per condition;
- one model/backend;
- fixed execution order;
- public historical bugs may be present in pretraining;
- task-selection bias;
- historical-change approximation of real development workflows;
- oracle/construct validity;
- trajectory interpretation subjectivity;
- two families are transfer evidence but not broad population evidence.

## 10. Reproducibility and artifact

Describe three layers:
- immutable operator-held custodial raw evidence;
- sanitized public research evidence pack;
- reproducible software/environment definitions.

Provide hashes, manifests, rerun commands, exact refs, image identities, and a public artifact DOI/release when ready.

## 11. Conclusion

Keep claims narrow:
- current pilots do not establish rediscovery-rate improvement;
- they do show repeatable differences in investigation behavior/cost and a recurring downstream reproducer-construction gap;
- broader claims require additional unrelated-family and repeated-trial evidence.