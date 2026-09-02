import type { VttCue } from "../types/media";

const BOM = /^﻿/;
const LINE_BREAKS = /\r\n|\r/g;
const BLANK_LINE = /\n{2,}/;
const TIMESTAMP = /^(\d{1,4}):(\d{2})(?::(\d{2}))?\.(\d{1,3})$/;
const VOICE_TAG = /^<v(?:\.[^\s>]+)*\s*([^>]*)>/;
const ANY_TAG = /<\/?[^>]*>/g;

/** Accepts both "HH:MM:SS.mmm" and "MM:SS.mmm". Returns seconds, or null. */
export function parseTimestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return null;

  const [, first, second, third, millis] = match;
  const hasHours = third !== undefined;
  const hours = hasHours ? Number(first) : 0;
  const minutes = Number(hasHours ? second : first);
  const seconds = Number(hasHours ? third : second);

  return hours * 3600 + minutes * 60 + seconds + Number(millis.padEnd(3, "0")) / 1000;
}

/**
 * Minimal but forgiving WebVTT reader: skips WEBVTT/NOTE/STYLE/REGION blocks,
 * tolerates optional cue identifiers and cue settings, and pulls the speaker
 * out of `<v S01>` voice spans (the new pipeline tags every cue that way).
 */
export function parseVtt(raw: string): VttCue[] {
  const normalized = raw.replace(BOM, "").replace(LINE_BREAKS, "\n");
  const cues: VttCue[] = [];

  for (const block of normalized.split(BLANK_LINE)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;

    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0].trim())) continue;

    const arrowIndex = lines.findIndex((line) => line.includes("-->"));
    if (arrowIndex === -1) continue;

    const [startPart, endPart = ""] = lines[arrowIndex].split("-->");
    const start = parseTimestamp(startPart);
    // Cue settings (align, line, position...) trail the end timestamp.
    const end = parseTimestamp(endPart.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null) continue;

    const body = lines.slice(arrowIndex + 1);
    if (body.length === 0) continue;

    let speaker: string | undefined;
    const voice = VOICE_TAG.exec(body[0]);
    if (voice && voice[1].trim()) speaker = voice[1].trim();

    // Cues are hard-wrapped mid-sentence, so join on spaces for readability.
    const text = body
      .join(" ")
      .replace(ANY_TAG, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;
    cues.push({ index: cues.length, start, end, speaker, text });
  }

  return cues;
}

/** Index of the last cue that has started at `time`, or -1 before the first cue. */
export function findActiveCue(cues: VttCue[], time: number): number {
  let candidate = -1;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].start > time) break;
    candidate = i;
  }
  return candidate;
}
