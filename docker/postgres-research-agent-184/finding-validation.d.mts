export type SubmitFindingArgs = {
  status?: unknown;
  summary?: unknown;
  reproducer_filename?: unknown;
  reproducer_sql?: unknown;
};

export type SubmitFindingValidation =
  | { ok: true; finding: { status: "not-reproduced"; summary: string } | { status: "reproduced"; summary: string; reproducer: string }; reproducerFile?: { filename: string; sql: string } }
  | { ok: false; error: string };

export function validateSubmitFindingArgs(args: SubmitFindingArgs | undefined): SubmitFindingValidation;
