/** guard-predicate.ts —— 写保护守卫谓词真源（W1：产物落点相对性判定）。
 *
 * 独立零依赖文件：守卫寄居主管线模块会随其加载失败静默消失，故谓词永不 import 业务模块。
 * 单调只拒不放：返回 string = 拒绝并说明理由，undefined = 通过。
 * W1 判定：七工具的全部路径参数只收工作区相对路径——绝对路径或越界（.. 逃出）直接拒，
 * 与执行核 resolveInWorkspace 同口径（守卫早拦，执行核兜底）。
 */

const MEDIA_TOOLS = [
  "media_probe",
  "media_transcode",
  "media_concat",
  "media_slice",
  "media_mux_voice",
  "media_burn_subtitles",
  "media_extract_audio",
] as const;

const PATH_KEYS = ["path", "src", "out", "output", "video", "voiceAudio", "srt", "clips"] as const;

/** 相对性判定（绝对路径/盘符/.. 逃出/家目录缩写即越界）。 */
export function isOutOfWorkspacePath(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.startsWith("/") || s.startsWith("~")) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  const norm = s.replace(/\\/g, "/");
  if (norm === ".." || norm.startsWith("../") || norm.includes("/../") || norm.endsWith("/..")) return true;
  return false;
}

export function ffmpegGuardPredicate(execution: { name: string; arguments: unknown }): string | undefined {
  if (!(MEDIA_TOOLS as readonly string[]).includes(execution.name)) return undefined;
  const args = execution.arguments;
  if (typeof args !== "object" || args === null) return undefined;
  const rec = args as Record<string, unknown>;
  const bad: string[] = [];
  const check = (key: string, v: unknown): void => {
    if (typeof v === "string") {
      if (isOutOfWorkspacePath(v)) bad.push(`${key}=${v.trim()}`);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && isOutOfWorkspacePath(item)) bad.push(`${key}=${item.trim()}`);
      }
    }
  };
  for (const key of PATH_KEYS) {
    if (key in rec) check(key, rec[key]);
  }
  if (bad.length > 0) {
    return `[越界] ${execution.name} 只收工作区相对路径：${bad.join("；")}（改传工作区相对路径如 media/in.mp4）`;
  }
  return undefined;
}
