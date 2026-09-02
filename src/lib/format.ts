/** Seconds to "M:SS" / "H:MM:SS". */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(secs).padStart(2, "0")}`;
}

/** Seconds to a compact human duration, e.g. "10m 14s". */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatNumber(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString();
}

export function formatScore(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(3);
}

/** "…/branch/file.json" -> "file.json"; falls back to the whole URL. */
export function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const name = new URL(url, window.location.href).pathname.split("/").pop();
    return name || fallback;
  } catch {
    return fallback;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Wraps every case-insensitive match of `query` in a <mark>. Escapes first. */
export function highlight(text: string, query: string): string {
  const escaped = escapeHtml(text);
  const needle = query.trim();
  if (!needle) return escaped;

  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return escaped.replace(pattern, (match) => `<mark>${match}</mark>`);
}

/** Stable-ish colour index for a speaker label, so S01 keeps its hue. */
export function speakerSlot(label: string, slots: number): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return hash % slots;
}
