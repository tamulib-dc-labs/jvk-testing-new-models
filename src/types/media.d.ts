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
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface TranscriptJSON {
  word_score_buckets?: WordScoreBuckets;
  segments: Segment[];
}

export interface MediaFile {
  audio: string;
  url: string;
  vtt?: string;
  name?: string;
}