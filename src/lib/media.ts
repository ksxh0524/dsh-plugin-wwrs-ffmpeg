/** media.ts —— 七媒体工具执行核（参数校验 + argv 组装 + overwrite 短路 + 真 exec）。
 *
 * 只认路径/字节/毫秒/编解码器：入参一律工作区相对路径（resolveInWorkspace 强收敛，
 * 绝对路径或越界直接抛）；写工具一律带 overwrite?: boolean（缺省 false，false 且
 * 产物存在 → 成功返回 {skipped:true} 不执行，绝不静默覆盖）。
 * argv 组装意图借 .pi generation-infra ffmpeg.ts（只读其意图，剔除其单机路径术）：
 * 探测走 ffprobe（静图无时长 → durationMs=null，不 400）；转码/切片重编 libx264+aac；
 * 拼接缺省 filter-complex 归一（重编关时走 concat demuxer）；混流缺省替换音轨，
 * 给 attenuationDb 时混入原音轨（衰减指定分贝）；烧字幕走 subtitles 滤镜；
 * 提音频走首个音频流重编。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FailLoudError } from "./errors.ts";
import { resolveInWorkspace } from "./workspace.ts";
import type { ExecFn } from "./exec.ts";

/** probe 档超时 60s；转码拼接档 30min（作业单分档，工具 timeoutMs 声明同值）。 */
export const PROBE_TIMEOUT_MS = 60_000;
export const MEDIA_TIMEOUT_MS = 30 * 60_000;

export type MediaDeps = {
  ffmpegBin: string;
  ffprobeBin: string;
  run: ExecFn;
  exists?: (p: string) => boolean;
};

export type Skipped = { out: string; skipped: true };
export type Wrote = { out: string; skipped: false };

function exists(deps: MediaDeps, p: string): boolean {
  return (deps.exists ?? existsSync)(p);
}

function fail(fields: { error: string; param: string; expected: string; example: string }): never {
  throw new FailLoudError(fields);
}

/** 非空字符串校验（fail-loud 四字段一次改对）。 */
function asPath(raw: unknown, param: string): string {
  const s = String(raw ?? "").trim();
  if (!s) {
    fail({ error: `[路径为空] ${param} 为空`, param, expected: "工作区相对路径", example: "media/in.mp4" });
  }
  return s;
}

/** 工作区落点解析（相对路径拼入，绝对/越界抛）。 */
function at(ws: string, raw: unknown, param: string): { rel: string; abs: string } {
  return resolveInWorkspace(ws, asPath(raw, param), param);
}

/** overwrite 显式语义：非布尔即抛，缺省 false。 */
function asOverwrite(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    fail({
      error: `[类型非法] overwrite 只收布尔，收到 ${String(raw)}`,
      param: "overwrite",
      expected: "true（覆盖）或 false（存在即跳过，缺省 false）",
      example: "overwrite=true",
    });
  }
  return raw;
}

/** 有限数校验。 */
function asFiniteNumber(raw: unknown, param: string, expected: string, example: string): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? ""));
  if (!Number.isFinite(n)) {
    fail({ error: `[数值非法] ${param} 须为有限数，收到 ${String(raw)}`, param, expected, example });
  }
  return n;
}

/** 写前短路：产物存在且 overwrite=false → 成功返回 {out,skipped:true} 不执行；否则建父目录放行。 */
function shortCircuit(deps: MediaDeps, out: { rel: string; abs: string }, overwrite: boolean): Skipped | null {
  if (exists(deps, out.abs) && !overwrite) return { out: out.rel, skipped: true };
  mkdirSync(dirname(out.abs), { recursive: true });
  return null;
}

/** ffprobe duration 输出解析（静图 "N/A"/空 → null，不 400）。 */
export function parseProbeDuration(stdout: string): number | null {
  const s = String(stdout ?? "").trim();
  if (!s || s === "N/A") return null;
  const sec = Number(s);
  if (!Number.isFinite(sec) || sec < 0) return null;
  return Math.round(sec * 1000);
}

/** ffprobe 尺寸输出解析（"640x480" → {width,height}；无视频流/解析失败 → null）。 */
export function parseProbeSize(stdout: string): { width: number; height: number } | null {
  const m = /(\d+)x(\d+)/.exec(String(stdout ?? "").trim());
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

// ---------- media_probe ----------

export type ProbeResult = { durationMs: number | null; width: number | null; height: number | null };

/** 探测：时长毫秒（静图 null）+ 宽高（无视频流 null）。输入不可解码（ffprobe 非零）才 fail-loud。 */
export async function probeMedia(deps: MediaDeps, ws: string, args: { path: unknown }): Promise<ProbeResult> {
  const src = at(ws, args.path, "path");
  let durOut: string;
  try {
    const r = await deps.run(deps.ffprobeBin, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src.abs], {
      timeoutMs: PROBE_TIMEOUT_MS,
      context: `probe时长(${src.rel})`,
    });
    durOut = r.stdout;
  } catch (e) {
    fail({
      error: `[不可解码] ffprobe 读 ${src.rel} 失败：${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
      param: "path",
      expected: "ffprobe 可读的媒体路径",
      example: "media/in.mp4",
    });
  }
  let sizeOut: string;
  try {
    const r = await deps.run(
      deps.ffprobeBin,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", src.abs],
      { timeoutMs: PROBE_TIMEOUT_MS, context: `probe尺寸(${src.rel})` },
    );
    sizeOut = r.stdout;
  } catch (e) {
    fail({
      error: `[不可解码] ffprobe 读 ${src.rel} 尺寸失败：${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
      param: "path",
      expected: "ffprobe 可读的媒体路径",
      example: "media/in.mp4",
    });
  }
  const size = parseProbeSize(sizeOut as string);
  return { durationMs: parseProbeDuration(durOut as string), width: size?.width ?? null, height: size?.height ?? null };
}

// ---------- media_transcode ----------

const PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "placebo"] as const;

export type TranscodeArgs = {
  src: unknown;
  out: unknown;
  videoCodec?: unknown;
  audioCodec?: unknown;
  crf?: unknown;
  preset?: unknown;
  /** 透传 argv（风险自负：只收非空字符串数组，原样拼在输出路径之前）。 */
  extraArgs?: unknown;
  overwrite?: unknown;
};

/** 转码 argv 纯组装（extraArgs 原样拼入，调用方风险自负）。 */
export function buildTranscodeArgs(
  srcAbs: string,
  outAbs: string,
  opts: { videoCodec: string; audioCodec: string; crf: number; preset: string; extraArgs: string[] },
): string[] {
  return [
    "-y",
    "-i",
    srcAbs,
    "-c:v",
    opts.videoCodec,
    "-preset",
    opts.preset,
    "-crf",
    String(opts.crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    opts.audioCodec,
    "-movflags",
    "+faststart",
    ...opts.extraArgs,
    outAbs,
  ];
}

function asExtraArgs(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !x.trim())) {
    fail({
      error: "[类型非法] extraArgs 只收非空字符串数组（原样拼 argv，风险自负）",
      param: "extraArgs",
      expected: 'string[]（如 ["-r","30"]）',
      example: 'extraArgs=["-r","30"]',
    });
  }
  return (raw as string[]).map(String);
}

/** 转码：重编输出（缺省 libx264 veryfast crf23 + aac，faststart）。 */
export async function transcodeMedia(deps: MediaDeps, ws: string, args: TranscodeArgs): Promise<Wrote | Skipped> {
  const src = at(ws, args.src, "src");
  const out = at(ws, args.out, "out");
  const overwrite = asOverwrite(args.overwrite);
  const videoCodec = args.videoCodec === undefined ? "libx264" : asPath(args.videoCodec, "videoCodec");
  const audioCodec = args.audioCodec === undefined ? "aac" : asPath(args.audioCodec, "audioCodec");
  const crf = args.crf === undefined ? 23 : asFiniteNumber(args.crf, "crf", "0~51（越小质量越高）", "crf=23");
  if (crf < 0 || crf > 51) {
    fail({ error: `[越界] crf=${crf} 不在 0~51 内`, param: "crf", expected: "0~51（越小质量越高）", example: "crf=23" });
  }
  const preset = args.preset === undefined ? "veryfast" : String(args.preset);
  if (!(PRESETS as readonly string[]).includes(preset)) {
    fail({ error: `[非法取值] preset=${preset} 不在白名单内`, param: "preset", expected: PRESETS.join("|"), example: "preset=veryfast" });
  }
  const extraArgs = asExtraArgs(args.extraArgs);
  const skip = shortCircuit(deps, out, overwrite);
  if (skip) return skip;
  await deps.run(deps.ffmpegBin, buildTranscodeArgs(src.abs, out.abs, { videoCodec, audioCodec, crf, preset, extraArgs }), {
    timeoutMs: MEDIA_TIMEOUT_MS,
    context: `transcode(${src.rel})`,
  });
  return { out: out.rel, skipped: false };
}

// ---------- media_concat ----------

export type ConcatArgs = { clips: unknown; out: unknown; options?: unknown; overwrite?: unknown };
export type ConcatOptions = { reencode: boolean; fps?: number; audioBitrate?: string };

/** 拼接 options 解析（reencode 缺省 true；fps 正数；audioBitrate 非空串）。 */
export function parseConcatOptions(raw: unknown): ConcatOptions {
  if (raw === undefined) return { reencode: true };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail({ error: "[类型非法] options 只收对象", param: "options", expected: "{reencode?,fps?,audioBitrate?}", example: 'options={"reencode":true}' });
  }
  const o = raw as Record<string, unknown>;
  let reencode = true;
  if (o.reencode !== undefined) {
    if (typeof o.reencode !== "boolean") {
      fail({
        error: `[类型非法] options.reencode 只收布尔，收到 ${String(o.reencode)}`,
        param: "options.reencode",
        expected: "true（重编归一，缺省）或 false（demuxer 直拷）",
        example: 'options={"reencode":false}',
      });
    }
    reencode = o.reencode as boolean;
  }
  const out: ConcatOptions = { reencode };
  if (o.fps !== undefined) {
    const fps = asFiniteNumber(o.fps, "options.fps", "正数帧率", 'options={"fps":30}');
    if (fps <= 0) fail({ error: `[越界] options.fps=${fps} 须为正数`, param: "options.fps", expected: "正数帧率", example: 'options={"fps":30}' });
    out.fps = fps;
  }
  if (o.audioBitrate !== undefined) {
    const b = String(o.audioBitrate).trim();
    if (!b)
      fail({
        error: "[取值非法] options.audioBitrate 为空",
        param: "options.audioBitrate",
        expected: "非空码率串",
        example: 'options={"audioBitrate":"192k"}',
      });
    out.audioBitrate = b;
  }
  return out;
}

function asClips(ws: string, raw: unknown): Array<{ rel: string; abs: string }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail({ error: "[取值非法] clips 至少含 1 个片段", param: "clips", expected: "非空的工作区相对路径数组", example: 'clips=["media/a.mp4","media/b.mp4"]' });
  }
  return (raw as unknown[]).map((c, i) => at(ws, c, `clips[${i}]`));
}

/** concat demuxer 清单内容（单引号转义后逐行 file '...'）。 */
export function buildConcatListContent(clipAbs: string[]): string {
  return `${clipAbs.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n")}\n`;
}

/** 拼接 argv 纯组装（重编归一：首个片段定画布 + 32k mono 音频；直拷走 demuxer）。 */
export function buildConcatReencodeArgs(
  clipAbs: string[],
  outAbs: string,
  opts: { width: number; height: number; fps?: number; audioBitrate: string },
): string[] {
  const inputs: string[] = [];
  for (const c of clipAbs) inputs.push("-i", c);
  const parts: string[] = [];
  for (let i = 0; i < clipAbs.length; i += 1) {
    const scale = `[${i}:v]scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
    parts.push(`${scale}${opts.fps ? `,fps=${opts.fps}` : ""}[v${i}]`);
    parts.push(`[${i}:a]aresample=32000,pan=mono|c0=0.5*c0+0.5*c1[a${i}]`);
  }
  const labels = clipAbs.map((_, i) => `[v${i}][a${i}]`).join("");
  const graph = `${parts.join(";")};${labels}concat=n=${clipAbs.length}:v=1:a=1[v][a]`;
  return [
    "-y",
    ...inputs,
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    opts.audioBitrate,
    "-movflags",
    "+faststart",
    outAbs,
  ];
}

/** 拼接：多片段归一重编（缺省）或 demuxer 直拷（options.reencode=false）；单片段即转码归一。 */
export async function concatMedia(deps: MediaDeps, ws: string, args: ConcatArgs): Promise<Wrote | Skipped> {
  const clips = asClips(ws, args.clips);
  const out = at(ws, args.out, "out");
  const overwrite = asOverwrite(args.overwrite);
  const opts = parseConcatOptions(args.options);
  const skip = shortCircuit(deps, out, overwrite);
  if (skip) return skip;
  if (clips.length === 1) {
    const only = clips[0] as { rel: string; abs: string };
    await deps.run(
      deps.ffmpegBin,
      buildTranscodeArgs(only.abs, out.abs, { videoCodec: "libx264", audioCodec: "aac", crf: 23, preset: "veryfast", extraArgs: [] }),
      {
        timeoutMs: MEDIA_TIMEOUT_MS,
        context: `concat单片段归一(${only.rel})`,
      },
    );
    return { out: out.rel, skipped: false };
  }
  if (opts.reencode === false) {
    const listFile = `${out.abs}.concat.txt`;
    writeFileSync(listFile, buildConcatListContent(clips.map((c) => c.abs)));
    try {
      await deps.run(deps.ffmpegBin, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", out.abs], {
        timeoutMs: MEDIA_TIMEOUT_MS,
        context: `concat直拷(${clips.length}段)`,
      });
    } finally {
      rmSync(listFile, { force: true });
    }
    return { out: out.rel, skipped: false };
  }
  const first = clips[0] as { rel: string; abs: string };
  let sizeOut: string;
  try {
    const r = await deps.run(
      deps.ffprobeBin,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", first.abs],
      { timeoutMs: PROBE_TIMEOUT_MS, context: `concat探画布(${first.rel})` },
    );
    sizeOut = r.stdout;
  } catch (e) {
    fail({
      error: `[不可解码] 探首个片段画布失败：${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
      param: "clips[0]",
      expected: "ffprobe 可读的视频路径",
      example: 'clips=["media/a.mp4"]',
    });
  }
  const size = parseProbeSize(sizeOut as string);
  if (!size) {
    fail({ error: "[不可解码] 首个片段无视频流，定不出归一画布", param: "clips[0]", expected: "含视频流的片段", example: 'clips=["media/a.mp4"]' });
  }
  await deps.run(
    deps.ffmpegBin,
    buildConcatReencodeArgs(
      clips.map((c) => c.abs),
      out.abs,
      {
        width: (size as { width: number; height: number }).width,
        height: (size as { width: number; height: number }).height,
        ...(opts.fps ? { fps: opts.fps } : {}),
        audioBitrate: opts.audioBitrate ?? "192k",
      },
    ),
    { timeoutMs: MEDIA_TIMEOUT_MS, context: `concat重编(${clips.length}段)` },
  );
  return { out: out.rel, skipped: false };
}

// ---------- media_slice ----------

export type SliceArgs = { src: unknown; startMs: unknown; endMs: unknown; out: unknown; overwrite?: unknown };

/** 切片区间校验（毫秒；endMs>startMs>=0，一次改对）。 */
export function parseSliceRange(startRaw: unknown, endRaw: unknown): { startMs: number; endMs: number } {
  const startMs = asFiniteNumber(startRaw, "startMs", ">=0 的毫秒", "startMs=1000");
  const endMs = asFiniteNumber(endRaw, "endMs", ">startMs 的毫秒", "endMs=5000");
  if (startMs < 0) {
    fail({ error: `[越界] startMs=${startMs} 须>=0`, param: "startMs", expected: ">=0 的毫秒", example: "startMs=1000" });
  }
  if (!(endMs > startMs)) {
    fail({ error: `[区间非法] endMs=${endMs} 须大于 startMs=${startMs}`, param: "endMs", expected: ">startMs 的毫秒", example: "endMs=5000" });
  }
  return { startMs, endMs };
}

/** 切片 argv 纯组装（-ss 起点 -t 时长，重编 libx264+aac，faststart）。 */
export function buildSliceArgs(srcAbs: string, outAbs: string, range: { startMs: number; endMs: number }): string[] {
  const startSec = (range.startMs / 1000).toFixed(3);
  const durSec = ((range.endMs - range.startMs) / 1000).toFixed(3);
  return [
    "-y",
    "-ss",
    startSec,
    "-t",
    durSec,
    "-i",
    srcAbs,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outAbs,
  ];
}

/** 切片：[startMs,endMs) 重编输出。 */
export async function sliceMedia(deps: MediaDeps, ws: string, args: SliceArgs): Promise<Wrote | Skipped> {
  const src = at(ws, args.src, "src");
  const out = at(ws, args.out, "out");
  const overwrite = asOverwrite(args.overwrite);
  const range = parseSliceRange(args.startMs, args.endMs);
  const skip = shortCircuit(deps, out, overwrite);
  if (skip) return skip;
  await deps.run(deps.ffmpegBin, buildSliceArgs(src.abs, out.abs, range), { timeoutMs: MEDIA_TIMEOUT_MS, context: `slice(${src.rel})` });
  return { out: out.rel, skipped: false };
}

// ---------- media_mux_voice ----------

export type MuxArgs = { video: unknown; voiceAudio: unknown; out: unknown; attenuationDb?: unknown; overwrite?: unknown };

/** 衰减分贝校验（缺省 undefined=替换模式；给定即混入模式，须为有限数）。 */
export function parseAttenuationDb(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const n = asFiniteNumber(raw, "attenuationDb", "有限数分贝（负值=压低原音轨，如 -10）", "attenuationDb=-10");
  if (n > 0) {
    fail({
      error: `[越界] attenuationDb=${n} 须<=0（只能压低原音轨，不能放大）`,
      param: "attenuationDb",
      expected: "<=0 的分贝",
      example: "attenuationDb=-10",
    });
  }
  return n;
}

/** 混流 argv 纯组装（替换：原音轨丢弃 + 配音补齐视频时长；混入：原音轨衰减后与配音 amix）。 */
export function buildMuxArgs(videoAbs: string, voiceAbs: string, outAbs: string, opts: { videoDurSec: string; attenuationDb?: number }): string[] {
  if (opts.attenuationDb === undefined) {
    return [
      "-y",
      "-i",
      videoAbs,
      "-i",
      voiceAbs,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-af",
      `apad=whole_dur=${opts.videoDurSec}`,
      "-t",
      opts.videoDurSec,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outAbs,
    ];
  }
  const graph = `[0:a]volume=${opts.attenuationDb}dB[bg];[bg][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]`;
  return [
    "-y",
    "-i",
    videoAbs,
    "-i",
    voiceAbs,
    "-filter_complex",
    graph,
    "-map",
    "0:v:0",
    "-map",
    "[a]",
    "-t",
    opts.videoDurSec,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outAbs,
  ];
}

/** 混流：配音轨压到视频上（缺省替换原音轨；给 attenuationDb 则混入衰减后的原音轨）。 */
export async function muxVoiceMedia(deps: MediaDeps, ws: string, args: MuxArgs): Promise<Wrote | Skipped> {
  const video = at(ws, args.video, "video");
  const voice = at(ws, args.voiceAudio, "voiceAudio");
  const out = at(ws, args.out, "out");
  const overwrite = asOverwrite(args.overwrite);
  const attenuationDb = parseAttenuationDb(args.attenuationDb);
  const skip = shortCircuit(deps, out, overwrite);
  if (skip) return skip;
  let durOut: string;
  try {
    const r = await deps.run(deps.ffprobeBin, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video.abs], {
      timeoutMs: PROBE_TIMEOUT_MS,
      context: `mux探视频时长(${video.rel})`,
    });
    durOut = r.stdout;
  } catch (e) {
    fail({
      error: `[不可解码] 探视频时长失败：${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
      param: "video",
      expected: "ffprobe 可读的视频路径",
      example: "media/v.mp4",
    });
  }
  const durMs = parseProbeDuration(durOut as string);
  if (durMs === null || durMs <= 0) {
    fail({ error: "[无时长语义] 视频探不出时长，对不齐配音", param: "video", expected: "含时长语义的视频", example: "media/v.mp4" });
  }
  const videoDurSec = ((durMs as number) / 1000).toFixed(3);
  await deps.run(deps.ffmpegBin, buildMuxArgs(video.abs, voice.abs, out.abs, attenuationDb === undefined ? { videoDurSec } : { videoDurSec, attenuationDb }), {
    timeoutMs: MEDIA_TIMEOUT_MS,
    context: `mux(${video.rel})`,
  });
  return { out: out.rel, skipped: false };
}

// ---------- media_burn_subtitles ----------

export type BurnArgs = { video: unknown; srt: unknown; output: unknown; options?: unknown; overwrite?: unknown };
export type BurnOptions = { forceStyle?: string; encoding?: string };

/** 烧字幕 options 解析（forceStyle/encoding 皆非空串才收）。 */
export function parseBurnOptions(raw: unknown): BurnOptions {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail({ error: "[类型非法] options 只收对象", param: "options", expected: "{forceStyle?,encoding?}", example: 'options={"forceStyle":"FontSize=16"}' });
  }
  const o = raw as Record<string, unknown>;
  const out: BurnOptions = {};
  if (o.forceStyle !== undefined) {
    const s = String(o.forceStyle).trim();
    if (!s)
      fail({
        error: "[取值非法] options.forceStyle 为空",
        param: "options.forceStyle",
        expected: "非空样式串",
        example: 'options={"forceStyle":"FontSize=16"}',
      });
    out.forceStyle = s;
  }
  if (o.encoding !== undefined) {
    const s = String(o.encoding).trim();
    if (!s) fail({ error: "[取值非法] options.encoding 为空", param: "options.encoding", expected: "非空编码名", example: 'options={"encoding":"utf-8"}' });
    out.encoding = s;
  }
  return out;
}

/** subtitles 滤镜路径转义（冒号/单引号/反斜杠按滤镜语法转义）。 */
export function escapeSubtitlesPath(abs: string): string {
  return abs.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** 烧字幕 argv 纯组装（-vf subtitles，视频重编 + 音轨直拷）。 */
export function buildBurnArgs(videoAbs: string, srtAbs: string, outAbs: string, opts: BurnOptions): string[] {
  let vf = `subtitles='${escapeSubtitlesPath(srtAbs)}'`;
  if (opts.encoding) vf += `:charenc=${opts.encoding}`;
  if (opts.forceStyle) vf += `:force_style='${opts.forceStyle.replace(/'/g, "\\'")}'`;
  return [
    "-y",
    "-i",
    videoAbs,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outAbs,
  ];
}

/** 烧字幕：字幕压入画面（视频重编，音轨直拷）。 */
export async function burnSubtitlesMedia(deps: MediaDeps, ws: string, args: BurnArgs): Promise<Wrote | Skipped> {
  const video = at(ws, args.video, "video");
  const srt = at(ws, args.srt, "srt");
  const out = at(ws, args.output, "output");
  const overwrite = asOverwrite(args.overwrite);
  const opts = parseBurnOptions(args.options);
  if (!srt.rel.toLowerCase().endsWith(".srt")) {
    fail({ error: `[格式非法] srt=${srt.rel} 须为 .srt 字幕路径`, param: "srt", expected: "工作区内 .srt 相对路径", example: "media/subs.srt" });
  }
  const skip = shortCircuit(deps, out, overwrite);
  if (skip) return skip;
  await deps.run(deps.ffmpegBin, buildBurnArgs(video.abs, srt.abs, out.abs, opts), { timeoutMs: MEDIA_TIMEOUT_MS, context: `burn(${video.rel})` });
  return { out: out.rel, skipped: false };
}

// ---------- media_extract_audio ----------

export type ExtractArgs = { src: unknown; out: unknown; overwrite?: unknown };

/** 提音频 argv 纯组装（首个音频流重编 aac 128k，去画面）。 */
export function buildExtractArgs(srcAbs: string, outAbs: string): string[] {
  return ["-y", "-i", srcAbs, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "128k", outAbs];
}

/** 提音频：取首个音频流输出。 */
export async function extractAudioMedia(deps: MediaDeps, ws: string, args: ExtractArgs): Promise<Wrote | Skipped> {
  const src = at(ws, args.src, "src");
  const out = at(ws, args.out, "out");
  const overwrite = asOverwrite(args.overwrite);
  const skip = shortCircuit(deps, out, overwrite);
  if (skip) return skip;
  try {
    await deps.run(deps.ffmpegBin, buildExtractArgs(src.abs, out.abs), { timeoutMs: MEDIA_TIMEOUT_MS, context: `extract(${src.rel})` });
  } catch (e) {
    fail({
      error: `[提音频失败] ${src.rel}：${e instanceof Error ? e.message.slice(0, 300) : String(e)}（源无音频流时亦报此错）`,
      param: "src",
      expected: "含音频流的媒体路径",
      example: "media/in.mp4",
    });
  }
  return { out: out.rel, skipped: false };
}
