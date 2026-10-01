export interface Block {
  role: string;
  text: string;
}

export interface Verdict {
  keep: number | null;
  full: number | null;
  checks: Record<string, number>;
}

export interface Kept {
  i: number;
  text: string;
  kind: string;
  keep: number;
  full: number;
  pinned?: boolean;
  rescued?: boolean;
  escalated?: boolean;
}

export interface Row {
  checks: Record<string, number>;
  i: number;
  role: string;
  kind: string;
  chars: number;
  keep: number | null;
  full: number | null;
  verdict: string;
  ref: string;
}

export interface Stats {
  judged: number;
  rescued: number;
  pinned: number;
  kept: number;
  truncated: number;
  escalated: number;
  chars_before: number;
  chars_after: number;
  est_tokens_after: number;
  reduction: number;
  ms: number;
  rows: Row[];
}
