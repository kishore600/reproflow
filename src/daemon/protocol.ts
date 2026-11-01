import type { Candidate } from '../engine/candidates.js';
import type { NormalizedStep } from '../engine/steps.js';
import type { ErrorInfo } from '../errors.js';
import type { EvidenceSummary } from '../evidence/digest.js';
import type { LocatorSpec } from '../flows/schema.js';

export interface PageInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface DaemonInfo {
  pid: number;
  profile: string;
  headed: boolean;
  startedAt: string;
  project: string;
}

export interface DaemonStatus extends DaemonInfo {
  pages: PageInfo[];
}

export interface DoParams {
  /** CLI action name as logged, e.g. "scroll-to". */
  action: string;
  step: NormalizedStep;
  /** Secret values to mask in everything that leaves the daemon. */
  secrets?: string[];
  /** What to write to session.jsonl instead of the real value (an env template, or "***"). */
  logValue?: string | null;
}

export interface MiniDigest {
  ok: boolean;
  action: string;
  url: string;
  title: string;
  error?: ErrorInfo;
  /** Only for locator_not_found. */
  candidates?: Candidate[];
  /** A bundle summary for failures, or just the file for `screenshot`. */
  evidence?: EvidenceSummary | { screenshot: string };
  truncated?: boolean;
}

export interface CaptureParams {
  fullPage?: boolean;
  /** Also crop element.png to this element. */
  locator?: LocatorSpec;
}
