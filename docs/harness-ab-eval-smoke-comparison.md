# Harness A/B Eval Smoke Test — Codex vs Claude 对比分析

**日期：** 2026-08-17
**Recipe：** `eval-instruction-ab-trial`
**矩阵：** 2 variants (`baseline` / `improved`) × 2 tasks (`fizzbuzz` / `slugify`) × 1 trial = 4 runs（smoke 模式）
**环境：** HoneyRail `http://127.0.0.1:4179`（本地实例，`~/.honeyrail`）

## 结果总览

| Agent | baseline pass rate | improved pass rate | baseline 平均耗时 | improved 平均耗时 |
|---|---|---|---|---|
| `codex` | 0% (0/2) | 50% (1/2) | 59.7s | 72.2s |
| `claude` | 100% (2/2) | 100% (2/2) | 60.8s | 43s |

Codex 报告：`harness-ab-report/comparison-report.md`
Claude 报告：`harness-ab-report-claude/comparison-report.md`

## 关键洞见

### 1. Codex 的失败不是 variant 差异，是环境噪声

三个"failed" trial（`baseline/fizzbuzz`、`baseline/slugify`、`improved/fizzbuzz`）的 evidence 显示，agent 实际上把任务做对了（pytest 全部通过：4/4、3/4、4/4），但 Codex 在收尾阶段弹出一个交互式提示：

```
Approaching rate limits
Switch to gpt-5.6-luna for lower credit usage?
Press enter to confirm or esc to go back
```

harness 的 `onBlocked: fail` 策略把这个无法自动应答的确认框判成了 gate failure。这跟 `baseline`/`improved` 指令文件本身无关——是账号限流触发的 CLI 交互提示，被当前 harness 无区分地记成了任务失败。如果只看表面 pass rate（0% vs 50%），会误判 improved 文件更优，但这是一次纯粹的操作性伪影（operational artifact），不是真实信号。

### 2. N=1 per cell，两次结果都不能用来下结论

两份报告都标注了：「With a single trial per cell no within-cell noise can be observed - treat the delta as unvalidated」。smoke 模式的目的本来就是验证 pipeline 能否端到端跑通（指令注入 → 执行 → re-verify → gate → evidence → report），两次跑都做到了：机制本身在两种 agent backend 下都正确工作。

### 3. Claude 跑出 4/4 全 pass，暴露了"天花板效应"风险

`fizzbuzz` / `slugify` 这两个 smoke 任务对 Claude 来说太简单，两个 variant 都轻松 100% pass，完全看不出 `baseline` vs `improved` 的差异。若正式 full matrix 仍只覆盖这类任务，无论指令文件写得好不好，可能都测不出真实差异——需要更高难度的任务才能让 variant 差异显形。

### 4. 耗时方向在两次跑中不一致，同样受 N 太小影响

Codex 组 improved 更慢（72.2s vs 59.7s），Claude 组 improved 更快（43s vs 60.8s）。`improved` 变体强调"test-first discipline、self-verification、no clarifying questions"——如果耗时确实更短，可能是减少了试探性提问/来回确认，而非代码质量差异，但目前样本量不足以下结论。

## 建议（对应 doc 中 "Operational notes" 一节应记录的内容）

1. **优先处理 Codex 的限速交互阻塞**：要么在 recipe/CLI 层面加非交互 flag 跳过模型切换确认，要么把"任务已完成但被无关提示 block"和真正的任务失败区分记录，否则任何一次账号限流都会污染整批评估数据。
2. **正式对比前先解决上面的 blocking 问题**，再用 full matrix（5 tasks × 3 trials = 30 runs）跑，且优先纳入不会被两个 variant 都轻松刷满分的任务，pass-rate delta 才有意义。
3. 目前两次 smoke 都只验证了"管道能跑通"，尚未干净地验证"baseline vs improved 谁更好"这个真正要回答的问题。

## 原始数据链接（本地实例，需在同机访问）

- Codex run 详情：`run_mswnfpca_gwqeh9`、`run_mswnh0it_k0afdj`、`run_mswnijbj_1ioov7`、`run_mswnk2z1_jkhrd9`
- Claude run 详情：`run_mswod4fl_qdzer5`、`run_mswoevko_881v1t`、`run_mswog07p_29i9tc`、`run_mswogpbw_09w4r7`
- 详细 evidence: `GET http://127.0.0.1:4179/api/runs/{runId}/evidence`（需 Bearer token 或已登录 session）
