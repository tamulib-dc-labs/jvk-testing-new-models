export interface WordScoreBuckets {
  Good: number;
  Neutral: number;
  Bad: number;
}

export interface Word {
  word: string;
  start: number;
  end: number;
  score?: number;
  probability?: number;
  /** Diarized speaker label, e.g. "S01" (new pipeline). */
  speaker?: string;
  /** How the timing was derived, e.g. "measured" (new pipeline). */
  source?: string;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  words: Word[];
  speaker?: string;
}

/** Forced-alignment summary emitted by the new pipeline. */
export interface AlignmentStats {
  total_segments?: number;
  successful_alignments?: number;
  failed_alignments?: number;
  success_rate?: number;
  total_words?: number;
  words_with_measured_timings?: number;
}

/** Per-stage wall clock, e.g. { ingest: 0.7, models: 614.1, fuse: 0.01, reflow: 0.03 }. */
export interface StageSeconds {
  [stage: string]: number;
}

/** Provenance for a single pipeline run. */
export interface RunInfo {
  audio?: string;
  audio_seconds?: number;
  first_word_at?: number;
  last_word_at?: number;
  diarization?: string | null;
  stage_seconds?: StageSeconds;
}

export interface TranscriptJSON {
  word_score_buckets?: WordScoreBuckets;
  segments: Segment[];
  language?: string;
  speakers?: string[];
  asr_model?: string;
  alignment_stats?: AlignmentStats;
  run?: RunInfo;
}

export interface MediaFile {
  audio: string;
  url: string;
  vtt?: string;
  name?: string;
}

/** A single cue parsed out of a WebVTT file. */
export interface VttCue {
  index: number;
  start: number;
  end: number;
  speaker?: string;
  text: string;
}

/** A branch of the site repo; each transcription-update-* branch is one pipeline run. */
export interface BranchInfo {
  name: string;
  isDefault: boolean;
  pr?: PullInfo;
}

export interface PullInfo {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
}

/** Written by scripts/build-config.js so the browser knows which repo to query. */
export interface SiteInfo {
  repository?: string | null;
  title?: string;
  subtitle?: string;
  footer_text?: string;
  theme?: string;
  base_path?: string;
  generated_at?: string;
}
