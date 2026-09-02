import "./style.css";
import "whisper-transcript-sticky";

import {
  LOCAL_SOURCE,
  branchUrl,
  clearBranchCache,
  listBranches,
  loadMediaConfig,
  loadSiteInfo,
  resolveRepository,
} from "./lib/github";
import { findActiveCue, parseVtt } from "./lib/vtt";
import {
  escapeHtml,
  fileNameFromUrl,
  formatClock,
  formatDuration,
  formatNumber,
  formatScore,
  highlight,
  speakerSlot,
} from "./lib/format";
import type {
  BranchInfo,
  MediaFile,
  TranscriptJSON,
  VttCue,
  Word,
  WordScoreBuckets,
} from "./types/media";

const CUSTOM_SOURCE = "__custom__";
const STORAGE_SOURCE = "wtr:source";
const DEFAULT_STATIC: WordScoreBuckets = { Good: 0.8, Neutral: 0.5, Bad: 0.2 };
const RAW_JSON_LIMIT = 300_000;
const SPEAKER_SLOTS = 8;
const WORDS_BEFORE = 3;
const WORDS_AFTER = 3;

/** Everything fetched for the recording currently on screen. */
interface LoadedItem {
  file: MediaFile;
  transcript: TranscriptJSON | null;
  transcriptError: string | null;
  vttText: string | null;
  vttCues: VttCue[];
  vttError: string | null;
}

const state = {
  repository: null as string | null,
  branches: [] as BranchInfo[],
  source: LOCAL_SOURCE,
  files: [] as MediaFile[],
  filter: "",
  selectedIndex: -1,
  item: null as LoadedItem | null,
  loadToken: 0,
  words: [] as Word[],
  originalBuckets: null as WordScoreBuckets | null,
  activeBuckets: null as WordScoreBuckets | null,
  staticEditing: false,
  vttQuery: "",
  vttSpeaker: "",
  vttFollow: true,
  vttRaw: false,
  activeCue: -1,
};

let transcriptBlobUrl: string | null = null;
let audioElement: HTMLMediaElement | null = null;
let audioPollTimer: number | undefined;
let toastTimer: number | undefined;

/* ── DOM handles ─────────────────────────────────────────────────────────── */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const dom = {
  branchSelect: el<HTMLSelectElement>("branch-select"),
  branchRefresh: el<HTMLButtonElement>("branch-refresh"),
  branchStatus: el<HTMLParagraphElement>("branch-status"),
  branchLink: el<HTMLAnchorElement>("branch-link"),
  fileSearch: el<HTMLInputElement>("file-search"),
  fileList: el<HTMLUListElement>("file-list"),
  fileCount: el<HTMLSpanElement>("file-count"),
  currentTitle: el<HTMLHeadingElement>("current-title"),
  currentMeta: el<HTMLParagraphElement>("current-meta"),
  assetActions: el<HTMLDivElement>("asset-actions"),
  detailsToggle: el<HTMLButtonElement>("details-toggle"),
  scoringClose: el<HTMLButtonElement>("scoring-close"),
  transcriptContainer: el<HTMLDivElement>("transcript-container"),
  timelineWords: el<HTMLDivElement>("timeline-words"),
  scoreDisplay: el<HTMLSpanElement>("score-display"),
  vttBody: el<HTMLDivElement>("vtt-body"),
  vttBadge: el<HTMLSpanElement>("vtt-badge"),
  vttSearch: el<HTMLInputElement>("vtt-search"),
  vttSpeaker: el<HTMLSelectElement>("vtt-speaker"),
  vttFollow: el<HTMLInputElement>("vtt-follow"),
  vttRawToggle: el<HTMLInputElement>("vtt-raw-toggle"),
  jsonBody: el<HTMLDivElement>("json-body"),
  toast: el<HTMLDivElement>("toast"),
};

/* ── Boot ────────────────────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  void boot();
});

async function boot(): Promise<void> {
  const info = await loadSiteInfo();
  state.repository = resolveRepository(info);
  state.source = readStoredSource();

  renderBranchOptions();
  await Promise.all([refreshBranches(false), selectSource(state.source)]);
}

function readStoredSource(): string {
  try {
    return window.localStorage.getItem(STORAGE_SOURCE) ?? LOCAL_SOURCE;
  } catch {
    return LOCAL_SOURCE;
  }
}

function storeSource(source: string): void {
  try {
    window.localStorage.setItem(STORAGE_SOURCE, source);
  } catch {
    // Storage disabled; the choice just will not persist.
  }
}

/* ── Branch switcher ─────────────────────────────────────────────────────── */

async function refreshBranches(force: boolean): Promise<void> {
  if (!state.repository) {
    setBranchStatus("Branch switching is off — no repository configured in config.yml.", "warn");
    return;
  }
  if (force) clearBranchCache(state.repository);

  dom.branchRefresh.disabled = true;
  try {
    state.branches = await listBranches(state.repository);
    renderBranchOptions();
    updateBranchLink(); // PR annotations arrive after the first config load.
  } catch (error) {
    setBranchStatus(`Could not list branches: ${message(error)}`, "warn");
  } finally {
    dom.branchRefresh.disabled = false;
  }
}

function renderBranchOptions(): void {
  const select = dom.branchSelect;
  select.innerHTML = "";

  const local = document.createElement("optgroup");
  local.label = "This site";
  local.appendChild(option(LOCAL_SOURCE, "This build (bundled config)"));
  select.appendChild(local);

  if (state.branches.length > 0) {
    const runs = document.createElement("optgroup");
    runs.label = state.repository ? state.repository : "Branches";
    for (const branch of state.branches) {
      let label = branch.name;
      if (branch.isDefault) label += "  (default)";
      if (branch.pr) label += `  · PR #${branch.pr.number}`;
      runs.appendChild(option(branch.name, label));
    }
    select.appendChild(runs);
  }

  if (state.source !== LOCAL_SOURCE && !state.branches.some((b) => b.name === state.source)) {
    const custom = document.createElement("optgroup");
    custom.label = "Current";
    custom.appendChild(option(state.source, state.source));
    select.appendChild(custom);
  }

  if (state.repository) {
    select.appendChild(option(CUSTOM_SOURCE, "Other branch\u2026"));
  }

  select.value = state.source;
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

async function selectSource(source: string): Promise<void> {
  state.source = source;
  storeSource(source);
  dom.branchSelect.value = source;
  setBranchStatus("Loading\u2026", "info");
  updateBranchLink();

  try {
    const load = await loadMediaConfig(state.repository, source);
    state.files = load.files.filter((file) => typeof file.name === "string" && file.name !== "");
    state.files.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

    const withJson = state.files.filter((file) => Boolean(file.url)).length;
    const withVtt = state.files.filter((file) => Boolean(file.vtt)).length;
    setBranchStatus(
      `${state.files.length} recording${state.files.length === 1 ? "" : "s"} · ${withJson} JSON · ${withVtt} VTT`,
      "info"
    );

    renderFileList();
    if (state.files.length > 0) void selectFile(0);
    else clearWorkspace("This branch has no named recordings in public/config.json.");
  } catch (error) {
    state.files = [];
    renderFileList();
    clearWorkspace(`Could not load this branch: ${message(error)}`);
    setBranchStatus(message(error), "warn");
  }
}

function updateBranchLink(): void {
  const { repository, source } = state;
  if (!repository || source === LOCAL_SOURCE) {
    dom.branchLink.hidden = true;
    return;
  }

  const branch = state.branches.find((b) => b.name === source);
  dom.branchLink.hidden = false;
  if (branch?.pr) {
    dom.branchLink.href = branch.pr.url;
    dom.branchLink.textContent = `PR #${branch.pr.number}: ${branch.pr.title} \u2197`;
  } else {
    dom.branchLink.href = branchUrl(repository, source);
    dom.branchLink.textContent = "View branch on GitHub \u2197";
  }
}

function setBranchStatus(text: string, tone: "info" | "warn"): void {
  dom.branchStatus.textContent = text;
  dom.branchStatus.classList.toggle("is-warn", tone === "warn");
}

/* ── Recording list ──────────────────────────────────────────────────────── */

function visibleFiles(): Array<{ file: MediaFile; index: number }> {
  const needle = state.filter.trim().toLowerCase();
  return state.files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => !needle || (file.name ?? "").toLowerCase().includes(needle));
}

function renderFileList(): void {
  const items = visibleFiles();
  dom.fileCount.textContent = String(state.files.length);

  if (items.length === 0) {
    dom.fileList.innerHTML = `<li class="empty-state">${
      state.files.length === 0 ? "Nothing to review here." : "No recording matches that filter."
    }</li>`;
    return;
  }

  dom.fileList.innerHTML = items
    .map(({ file, index }) => {
      const name = file.name ?? "Untitled";
      return `
        <li>
          <button class="file-item${index === state.selectedIndex ? " is-active" : ""}"
                  type="button" data-index="${index}">
            <span class="file-item__name">${highlight(name, state.filter)}</span>
            <span class="file-item__tags">
              <span class="tag${file.url ? " tag--json" : " tag--off"}">JSON</span>
              <span class="tag${file.vtt ? " tag--vtt" : " tag--off"}">VTT</span>
            </span>
          </button>
        </li>`;
    })
    .join("");
}

/* ── Loading one recording ───────────────────────────────────────────────── */

async function selectFile(index: number): Promise<void> {
  const file = state.files[index];
  if (!file) return;

  state.selectedIndex = index;
  renderFileList();

  const token = ++state.loadToken;
  detachAudio();
  state.words = [];
  state.activeCue = -1;
  resetTimeline();

  dom.currentTitle.textContent = file.name ?? "Untitled";
  dom.currentMeta.textContent = "Loading transcript\u2026";
  dom.transcriptContainer.innerHTML = `<p class="empty-state">Loading\u2026</p>`;
  dom.vttBody.innerHTML = `<p class="empty-state">Loading\u2026</p>`;
  dom.jsonBody.innerHTML = `<p class="empty-state">Loading\u2026</p>`;

  const [transcriptResult, vttResult] = await Promise.all([
    file.url ? fetchJson(file.url) : Promise.resolve({ ok: false as const, error: "No JSON in config" }),
    file.vtt ? fetchText(file.vtt) : Promise.resolve({ ok: false as const, error: "No VTT in config" }),
  ]);

  if (token !== state.loadToken) return; // A newer selection won.

  const item: LoadedItem = {
    file,
    transcript: transcriptResult.ok ? (transcriptResult.value as TranscriptJSON) : null,
    transcriptError: transcriptResult.ok ? null : transcriptResult.error,
    vttText: vttResult.ok ? vttResult.value : null,
    vttCues: vttResult.ok ? parseVtt(vttResult.value) : [],
    vttError: vttResult.ok ? null : vttResult.error,
  };
  state.item = item;

  applyBucketsFromTranscript(item.transcript);
  collectWords(item.transcript);

  renderAssetActions(item);
  renderHeadline(item);
  renderTranscript(item);
  renderVttTab(item);
  renderJsonTab(item);
}

type FetchResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function fetchJson(url: string): Promise<FetchResult<unknown>> {
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` };
    return { ok: true, value: await response.json() };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

async function fetchText(url: string): Promise<FetchResult<string>> {
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` };
    return { ok: true, value: await response.text() };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

function clearWorkspace(reason: string): void {
  state.selectedIndex = -1;
  state.item = null;
  state.words = [];
  detachAudio();
  dom.currentTitle.textContent = "No recording selected";
  dom.currentMeta.textContent = reason;
  dom.assetActions.innerHTML = "";
  dom.transcriptContainer.innerHTML = `<p class="empty-state">${escapeHtml(reason)}</p>`;
  dom.vttBody.innerHTML = `<p class="empty-state">No VTT loaded.</p>`;
  dom.jsonBody.innerHTML = `<p class="empty-state">No JSON loaded.</p>`;
  dom.vttBadge.hidden = true;
  resetTimeline();
}

function renderHeadline(item: LoadedItem): void {
  const bits: string[] = [];
  const transcript = item.transcript;

  if (transcript?.asr_model) bits.push(transcript.asr_model);
  if (transcript?.language) bits.push(transcript.language.toUpperCase());
  if (transcript?.run?.audio_seconds) bits.push(formatDuration(transcript.run.audio_seconds));
  if (transcript?.segments) bits.push(`${formatNumber(transcript.segments.length)} segments`);
  if (item.vttCues.length > 0) bits.push(`${formatNumber(item.vttCues.length)} cues`);
  if (item.transcriptError) bits.push(`JSON unavailable (${item.transcriptError})`);

  dom.currentMeta.textContent = bits.length > 0 ? bits.join("  ·  ") : "No metadata available.";
}

/* ── Asset buttons: open / download / copy for JSON and VTT ──────────────── */

function renderAssetActions(item: LoadedItem): void {
  dom.assetActions.innerHTML = "";
  dom.assetActions.appendChild(
    assetGroup("JSON", item.file.url, () => (item.transcript ? JSON.stringify(item.transcript, null, 2) : null), "application/json", "json")
  );
  dom.assetActions.appendChild(
    assetGroup("VTT", item.file.vtt ?? "", () => item.vttText, "text/vtt", "vtt")
  );
}

function assetGroup(
  label: string,
  url: string,
  content: () => string | null,
  mime: string,
  extension: string
): HTMLElement {
  const group = document.createElement("div");
  group.className = `asset-group asset-group--${extension}`;

  const title = document.createElement("span");
  title.className = "asset-group__label";
  title.textContent = label;
  group.appendChild(title);

  if (!url) {
    const missing = document.createElement("span");
    missing.className = "asset-group__missing";
    missing.textContent = "not in config";
    group.appendChild(missing);
    return group;
  }

  const open = document.createElement("a");
  open.className = "asset-btn";
  open.href = url;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = "Open";
  open.title = url;
  group.appendChild(open);

  const download = document.createElement("button");
  download.className = "asset-btn";
  download.type = "button";
  download.textContent = "Download";
  download.addEventListener("click", () => {
    const text = content();
    if (text === null) {
      window.open(url, "_blank", "noopener");
      return;
    }
    downloadText(text, fileNameFromUrl(url, `transcript.${extension}`), mime);
  });
  group.appendChild(download);

  const copy = document.createElement("button");
  copy.className = "asset-btn";
  copy.type = "button";
  copy.textContent = "Copy link";
  copy.addEventListener("click", () => void copyToClipboard(url, `${label} link copied`));
  group.appendChild(copy);

  return group;
}

function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  toast(`Saved ${filename}`);
}

async function copyToClipboard(text: string, note: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(note);
  } catch {
    toast("Copy failed — your browser blocked clipboard access");
  }
}

/* ── Transcript tab ──────────────────────────────────────────────────────── */

function renderTranscript(item: LoadedItem, buckets?: WordScoreBuckets): void {
  detachAudio();

  if (!item.transcript) {
    dom.transcriptContainer.innerHTML = `<p class="empty-state">${escapeHtml(
      item.transcriptError ?? "No transcript JSON for this recording."
    )}</p>`;
    return;
  }

  const payload: TranscriptJSON = buckets
    ? { ...item.transcript, word_score_buckets: buckets }
    : item.transcript;

  if (transcriptBlobUrl) URL.revokeObjectURL(transcriptBlobUrl);
  transcriptBlobUrl = URL.createObjectURL(
    new Blob([JSON.stringify(payload)], { type: "application/json" })
  );

  const node = document.createElement("whisper-transcript");
  node.setAttribute("audio", item.file.audio);
  node.setAttribute("url", transcriptBlobUrl);

  dom.transcriptContainer.innerHTML = "";
  dom.transcriptContainer.appendChild(node);
  attachAudio();
}

/** The player lives two shadow roots down and renders asynchronously. */
function findAudioElement(): HTMLMediaElement | null {
  const host = document.querySelector("whisper-transcript");
  const media = host?.shadowRoot?.querySelector("whisper-media");
  const inner = media?.shadowRoot?.querySelector("audio, video");
  return (inner as HTMLMediaElement | null) ?? null;
}

function attachAudio(attempt = 0): void {
  window.clearTimeout(audioPollTimer);

  const found = findAudioElement();
  if (found) {
    if (found !== audioElement) {
      audioElement = found;
      found.addEventListener("timeupdate", onTimeUpdate);
      found.addEventListener("seeked", onTimeUpdate);
    }
    return;
  }

  if (attempt >= 30) return;
  audioPollTimer = window.setTimeout(() => attachAudio(attempt + 1), 200);
}

function detachAudio(): void {
  window.clearTimeout(audioPollTimer);
  if (audioElement) {
    audioElement.removeEventListener("timeupdate", onTimeUpdate);
    audioElement.removeEventListener("seeked", onTimeUpdate);
  }
  audioElement = null;
}

function seekTo(seconds: number): void {
  if (!audioElement) attachAudio();
  if (!audioElement) {
    toast("Player is still loading — try again in a moment");
    return;
  }
  audioElement.currentTime = seconds;
  void audioElement.play().catch(() => undefined);
}

function onTimeUpdate(): void {
  const time = audioElement?.currentTime ?? 0;
  updateWordTimeline(time);
  updateActiveCue(time);
}

/* ── Word timeline strip ─────────────────────────────────────────────────── */

function collectWords(transcript: TranscriptJSON | null): void {
  state.words = [];
  for (const segment of transcript?.segments ?? []) {
    for (const word of segment.words ?? []) {
      state.words.push({
        ...word,
        score: word.score ?? word.probability ?? 0,
        speaker: word.speaker ?? segment.speaker,
      });
    }
  }
}

function resetTimeline(): void {
  dom.timelineWords.innerHTML = `<span class="timeline-word placeholder">Play the audio to follow along\u2026</span>`;
  dom.scoreDisplay.textContent = "--";
  dom.scoreDisplay.className = "score-display";
}

function currentWordIndex(time: number): number {
  const words = state.words;
  let candidate = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start > time) break;
    candidate = i;
  }
  return candidate;
}

function updateWordTimeline(time: number): void {
  if (state.words.length === 0) return;

  const index = currentWordIndex(time);
  if (index === -1) return;

  const from = Math.max(0, index - WORDS_BEFORE);
  const to = Math.min(state.words.length - 1, index + WORDS_AFTER);

  let html = "";
  for (let i = from; i <= to; i++) {
    const position = i < index ? "before" : i > index ? "after" : "current";
    html += `<span class="timeline-word ${position}">${escapeHtml(state.words[i].word)}</span>`;
  }
  dom.timelineWords.innerHTML = html;

  const score = state.words[index].score ?? 0;
  dom.scoreDisplay.textContent = formatScore(score);
  dom.scoreDisplay.className = `score-display ${scoreClass(score)}`;
}

function scoreClass(score: number): string {
  const buckets = state.activeBuckets;
  if (!buckets) return "";
  if (score < buckets.Bad) return "terrible";
  if (score < buckets.Neutral) return "poor";
  if (score < buckets.Good) return "mediocre";
  return "";
}

/* ── VTT tab ─────────────────────────────────────────────────────────────── */

function renderVttTab(item: LoadedItem): void {
  const cues = item.vttCues;
  dom.vttBadge.hidden = cues.length === 0;
  dom.vttBadge.textContent = String(cues.length);

  const speakers = [...new Set(cues.map((cue) => cue.speaker).filter(Boolean))] as string[];
  speakers.sort();
  dom.vttSpeaker.innerHTML =
    `<option value="">All speakers</option>` +
    speakers.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  dom.vttSpeaker.disabled = state.vttRaw || speakers.length === 0;
  dom.vttSearch.disabled = state.vttRaw;
  if (state.vttSpeaker && !speakers.includes(state.vttSpeaker)) state.vttSpeaker = "";
  dom.vttSpeaker.value = state.vttSpeaker;

  renderVttBody(item);
}

function renderVttBody(item: LoadedItem): void {
  if (item.vttError && item.vttCues.length === 0) {
    dom.vttBody.innerHTML = `<p class="empty-state">${escapeHtml(item.vttError)}</p>`;
    return;
  }

  if (state.vttRaw) {
    dom.vttBody.innerHTML = `<pre class="code-block">${escapeHtml(item.vttText ?? "")}</pre>`;
    return;
  }

  const needle = state.vttQuery.trim().toLowerCase();
  const matches = item.vttCues.filter((cue) => {
    if (state.vttSpeaker && cue.speaker !== state.vttSpeaker) return false;
    return !needle || cue.text.toLowerCase().includes(needle);
  });

  if (matches.length === 0) {
    dom.vttBody.innerHTML = `<p class="empty-state">No cue matches those filters.</p>`;
    return;
  }

  dom.vttBody.innerHTML = `
    <ol class="cue-list">
      ${matches.map((cue) => cueMarkup(cue)).join("")}
    </ol>`;
}

function cueMarkup(cue: VttCue): string {
  const speaker = cue.speaker
    ? `<span class="speaker speaker--${speakerSlot(cue.speaker, SPEAKER_SLOTS)}">${escapeHtml(cue.speaker)}</span>`
    : "";
  return `
    <li class="cue" data-cue="${cue.index}" data-start="${cue.start}">
      <button class="cue__seek" type="button" title="Play from ${formatClock(cue.start)}">
        ${formatClock(cue.start)}
      </button>
      <div class="cue__body">
        ${speaker}
        <p class="cue__text">${highlight(cue.text, state.vttQuery)}</p>
      </div>
    </li>`;
}

function updateActiveCue(time: number): void {
  const item = state.item;
  if (!item || state.vttRaw || item.vttCues.length === 0) return;

  const index = findActiveCue(item.vttCues, time);
  if (index === state.activeCue) return;
  state.activeCue = index;

  const previous = dom.vttBody.querySelector(".cue.is-active");
  previous?.classList.remove("is-active");

  const node = dom.vttBody.querySelector<HTMLLIElement>(`.cue[data-cue="${index}"]`);
  if (!node) return;
  node.classList.add("is-active");
  if (state.vttFollow) node.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ── JSON tab ────────────────────────────────────────────────────────────── */

function renderJsonTab(item: LoadedItem): void {
  const transcript = item.transcript;
  if (!transcript) {
    dom.jsonBody.innerHTML = `<p class="empty-state">${escapeHtml(
      item.transcriptError ?? "No transcript JSON for this recording."
    )}</p>`;
    return;
  }

  const stats = transcript.alignment_stats;
  const run = transcript.run;
  const processing = run?.stage_seconds
    ? Object.values(run.stage_seconds).reduce((sum, value) => sum + value, 0)
    : undefined;
  const realtime =
    processing !== undefined && run?.audio_seconds ? run.audio_seconds / processing : undefined;

  const tiles = [
    tile("ASR model", transcript.asr_model ?? "—", "wide"),
    tile("Language", transcript.language ? transcript.language.toUpperCase() : "—"),
    tile("Speakers", transcript.speakers?.length ? String(transcript.speakers.length) : "—",
      undefined, transcript.speakers?.join(", ")),
    tile("Segments", formatNumber(stats?.total_segments ?? transcript.segments?.length)),
    tile("Words", formatNumber(stats?.total_words ?? state.words.length)),
    tile("Alignment", stats?.success_rate !== undefined ? `${stats.success_rate.toFixed(1)}%` : "—",
      undefined, stats ? `${formatNumber(stats.failed_alignments)} failed` : undefined),
    tile("Audio length", formatDuration(run?.audio_seconds)),
    tile("Processing", formatDuration(processing),
      undefined, realtime ? `${realtime.toFixed(1)}× realtime` : undefined),
  ].join("");

  dom.jsonBody.innerHTML = `
    <div class="metric-grid">${tiles}</div>
    ${bucketsMarkup(transcript.word_score_buckets)}
    ${distributionMarkup()}
    ${stagesMarkup(run?.stage_seconds)}
    ${speakersMarkup(transcript.speakers)}
    <details class="raw-details" id="json-raw-details">
      <summary>Raw JSON</summary>
      <div class="raw-details__body"><p class="empty-state">Expand to render&hellip;</p></div>
    </details>`;

  wireRawJson(item);
}

function tile(label: string, value: string, modifier?: string, hint?: string): string {
  return `
    <div class="metric${modifier ? ` metric--${modifier}` : ""}">
      <span class="metric__label">${escapeHtml(label)}</span>
      <span class="metric__value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
      ${hint ? `<span class="metric__hint">${escapeHtml(hint)}</span>` : ""}
    </div>`;
}

function bucketsMarkup(buckets: WordScoreBuckets | undefined): string {
  if (!buckets) {
    return `<section class="data-card">
      <h3 class="data-card__title">Word score buckets</h3>
      <p class="data-card__note">Not present in this JSON — static thresholds are in use.</p>
    </section>`;
  }

  const rows = (["Good", "Neutral", "Bad"] as const)
    .map(
      (key) => `
        <div class="threshold threshold--${key.toLowerCase()}">
          <span class="threshold__label">${key}</span>
          <span class="threshold__value">${formatScore(buckets[key])}</span>
        </div>`
    )
    .join("");

  return `<section class="data-card">
    <h3 class="data-card__title">Word score buckets</h3>
    <div class="threshold-row">${rows}</div>
  </section>`;
}

function distributionMarkup(): string {
  const buckets = state.activeBuckets;
  const words = state.words;
  if (!buckets || words.length === 0) return "";

  const counts = { good: 0, neutral: 0, bad: 0, below: 0 };
  for (const word of words) {
    const score = word.score ?? 0;
    if (score < buckets.Bad) counts.below++;
    else if (score < buckets.Neutral) counts.bad++;
    else if (score < buckets.Good) counts.neutral++;
    else counts.good++;
  }

  const total = words.length;
  const segments: Array<[string, number, string]> = [
    ["good", counts.good, "Good"],
    ["neutral", counts.neutral, "Neutral"],
    ["bad", counts.bad, "Bad"],
    ["below", counts.below, "Below"],
  ];

  const bars = segments
    .filter(([, count]) => count > 0)
    .map(
      ([key, count, label]) =>
        `<span class="dist__part dist__part--${key}" style="flex:${count}"
               title="${label}: ${formatNumber(count)} words"></span>`
    )
    .join("");

  const legend = segments
    .map(
      ([key, count, label]) =>
        `<span class="dist__key"><i class="dist__swatch dist__swatch--${key}"></i>${label}
          <b>${((count / total) * 100).toFixed(1)}%</b></span>`
    )
    .join("");

  return `<section class="data-card">
    <h3 class="data-card__title">Word confidence spread</h3>
    <div class="dist">${bars}</div>
    <div class="dist__legend">${legend}</div>
    <p class="data-card__note">${formatNumber(total)} words measured against the active thresholds.</p>
  </section>`;
}

function stagesMarkup(stages: Record<string, number> | undefined): string {
  if (!stages || Object.keys(stages).length === 0) return "";

  const entries = Object.entries(stages).sort((a, b) => b[1] - a[1]);
  const max = entries[0][1] || 1;

  const rows = entries
    .map(
      ([name, seconds]) => `
        <div class="stage">
          <span class="stage__name">${escapeHtml(name)}</span>
          <span class="stage__track"><span class="stage__bar" style="width:${Math.max(
            2,
            (seconds / max) * 100
          ).toFixed(1)}%"></span></span>
          <span class="stage__value">${formatDuration(seconds)}</span>
        </div>`
    )
    .join("");

  return `<section class="data-card">
    <h3 class="data-card__title">Pipeline stages</h3>
    <div class="stage-list">${rows}</div>
  </section>`;
}

function speakersMarkup(speakers: string[] | undefined): string {
  if (!speakers || speakers.length === 0) return "";
  const chips = speakers
    .map(
      (name) =>
        `<span class="speaker speaker--${speakerSlot(name, SPEAKER_SLOTS)}">${escapeHtml(name)}</span>`
    )
    .join("");
  return `<section class="data-card">
    <h3 class="data-card__title">Speakers</h3>
    <div class="speaker-row">${chips}</div>
  </section>`;
}

/** Pretty-printing 700 KB is slow, so only do it when the section is opened. */
function wireRawJson(item: LoadedItem): void {
  const details = document.getElementById("json-raw-details") as HTMLDetailsElement | null;
  const body = details?.querySelector<HTMLDivElement>(".raw-details__body");
  if (!details || !body) return;

  let rendered = false;
  details.addEventListener("toggle", () => {
    if (!details.open || rendered || !item.transcript) return;
    rendered = true;

    const text = JSON.stringify(item.transcript, null, 2);
    const clipped = text.length > RAW_JSON_LIMIT;
    const shown = clipped ? text.slice(0, RAW_JSON_LIMIT) : text;

    body.innerHTML = `
      ${
        clipped
          ? `<p class="data-card__note">Showing the first ${formatNumber(
              RAW_JSON_LIMIT
            )} of ${formatNumber(text.length)} characters — download the file for the rest.</p>`
          : ""
      }
      <pre class="code-block">${highlightJson(shown)}</pre>`;
  });
}

const JSON_TOKENS = /("(?:\\.|[^"\\])*"\s*:?)|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlightJson(text: string): string {
  let out = "";
  let last = 0;

  JSON_TOKENS.lastIndex = 0;
  for (let match = JSON_TOKENS.exec(text); match; match = JSON_TOKENS.exec(text)) {
    out += escapeHtml(text.slice(last, match.index));

    const token = match[0];
    let cls = "j-num";
    if (match[1]) cls = token.trimEnd().endsWith(":") ? "j-key" : "j-str";
    else if (match[2]) cls = token === "null" ? "j-null" : "j-bool";

    out += `<span class="${cls}">${escapeHtml(token)}</span>`;
    last = match.index + token.length;
  }

  return out + escapeHtml(text.slice(last));
}

/* ── Scoring panel ───────────────────────────────────────────────────────── */

function applyBucketsFromTranscript(transcript: TranscriptJSON | null): void {
  const buckets = transcript?.word_score_buckets;

  if (buckets) {
    state.originalBuckets = { ...buckets };
    state.activeBuckets = { ...buckets };
    renderDynamicScores(buckets);
    setActiveIndicator("dynamic");
    el<HTMLButtonElement>("apply-dynamic").disabled = false;
  } else {
    state.originalBuckets = null;
    state.activeBuckets = { ...DEFAULT_STATIC };
    renderDynamicScores(null);
    setActiveIndicator("static");
    el<HTMLButtonElement>("apply-dynamic").disabled = true;
  }
}

function renderDynamicScores(buckets: WordScoreBuckets | null): void {
  el("dynamic-good").textContent = buckets ? formatScore(buckets.Good) : "—";
  el("dynamic-neutral").textContent = buckets ? formatScore(buckets.Neutral) : "—";
  el("dynamic-bad").textContent = buckets ? formatScore(buckets.Bad) : "—";
}

function setActiveIndicator(kind: "dynamic" | "static"): void {
  el("dynamic-active-label").style.display = kind === "dynamic" ? "inline" : "none";
  el("static-active-label").style.display = kind === "static" ? "inline" : "none";
}

function setScoringVisible(visible: boolean): void {
  document.body.classList.toggle("scoring-open", visible);
  dom.detailsToggle.textContent = visible ? "Hide scoring" : "Scoring";
  dom.detailsToggle.setAttribute("aria-expanded", String(visible));
}

/* ── Tabs ────────────────────────────────────────────────────────────────── */

function showTab(name: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".view-tab")) {
    const isActive = button.dataset.tab === name;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".tab-panel")) {
    panel.hidden = panel.id !== `panel-${name}`;
  }
}

/* ── Events ──────────────────────────────────────────────────────────────── */

function wireEvents(): void {
  dom.branchSelect.addEventListener("change", () => {
    const value = dom.branchSelect.value;
    if (value !== CUSTOM_SOURCE) {
      void selectSource(value);
      return;
    }

    const entered = window.prompt("Branch name to load public/config.json from:", state.source);
    dom.branchSelect.value = state.source;
    if (entered && entered.trim()) {
      state.source = entered.trim();
      renderBranchOptions();
      void selectSource(state.source);
    }
  });

  dom.branchRefresh.addEventListener("click", () => void refreshBranches(true));

  dom.fileSearch.addEventListener("input", () => {
    state.filter = dom.fileSearch.value;
    renderFileList();
  });

  dom.fileList.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".file-item");
    if (!button?.dataset.index) return;
    void selectFile(Number(button.dataset.index));
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>(".view-tab")) {
    button.addEventListener("click", () => showTab(button.dataset.tab ?? "transcript"));
  }

  dom.vttSearch.addEventListener("input", () => {
    state.vttQuery = dom.vttSearch.value;
    state.activeCue = -1;
    if (state.item) renderVttBody(state.item);
  });

  dom.vttSpeaker.addEventListener("change", () => {
    state.vttSpeaker = dom.vttSpeaker.value;
    state.activeCue = -1;
    if (state.item) renderVttBody(state.item);
  });

  dom.vttFollow.addEventListener("change", () => {
    state.vttFollow = dom.vttFollow.checked;
  });

  dom.vttRawToggle.addEventListener("change", () => {
    state.vttRaw = dom.vttRawToggle.checked;
    dom.vttSearch.disabled = state.vttRaw;
    dom.vttSpeaker.disabled = state.vttRaw;
    state.activeCue = -1;
    if (state.item) renderVttBody(state.item);
  });

  dom.vttBody.addEventListener("click", (event) => {
    const cue = (event.target as HTMLElement).closest<HTMLLIElement>(".cue");
    if (!cue?.dataset.start) return;
    seekTo(Number(cue.dataset.start));
  });

  dom.detailsToggle.addEventListener("click", () => {
    setScoringVisible(!document.body.classList.contains("scoring-open"));
  });
  dom.scoringClose.addEventListener("click", () => setScoringVisible(false));

  el("apply-dynamic").addEventListener("click", () => {
    if (!state.item || !state.originalBuckets) return;
    state.activeBuckets = { ...state.originalBuckets };
    renderTranscript(state.item, state.originalBuckets);
    setActiveIndicator("dynamic");
    renderJsonTab(state.item);
    toast("Dynamic thresholds applied");
  });

  el("edit-static").addEventListener("click", () => {
    state.staticEditing = !state.staticEditing;
    for (const input of document.querySelectorAll<HTMLInputElement>("#static-scores input")) {
      input.disabled = !state.staticEditing;
    }
    el("edit-static").textContent = state.staticEditing ? "Done" : "Edit";
  });

  el("apply-static").addEventListener("click", () => {
    if (!state.item) return;
    const buckets: WordScoreBuckets = {
      Good: readThreshold("static-good", DEFAULT_STATIC.Good),
      Neutral: readThreshold("static-neutral", DEFAULT_STATIC.Neutral),
      Bad: readThreshold("static-bad", DEFAULT_STATIC.Bad),
    };
    state.activeBuckets = buckets;
    renderTranscript(state.item, buckets);
    setActiveIndicator("static");
    renderJsonTab(state.item);
    toast("Static thresholds applied");
  });
}

function readThreshold(id: string, fallback: number): number {
  const value = Number.parseFloat(el<HTMLInputElement>(id).value);
  return Number.isFinite(value) ? value : fallback;
}

/* ── Misc ────────────────────────────────────────────────────────────────── */

function toast(text: string): void {
  dom.toast.textContent = text;
  dom.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.hidden = true;
  }, 2600);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
