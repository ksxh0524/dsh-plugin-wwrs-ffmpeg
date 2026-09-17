/** tools.ts —— dsh-plugin-wwrs-ffmpeg DSH 工具面（W1 七工具落地）。
 *
 * 注册面（cordis apply 一次性 register，行名=包名三处同步）：
 * - media_probe：只读探测（时长毫秒/宽高；静图时长 null）；
 * - media_transcode / media_concat / media_slice / media_mux_voice /
 *   media_burn_subtitles / media_extract_audio：写工具（一律 overwrite 显式语义）。
 * 形态照抄 autovideo/plugin-pipeline tools.ts（只读其 defineTool 写法）：
 * defineTool 全带 output.schema + output.render，timeoutMs 声明正数
 * （probe 60s，转码拼接 30min，与执行核分档同值）；exec.signal 逐调用钻进 execFile。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveFfmpegBin, resolveFfprobeBin } from "./lib/carrier.ts";
import { runBin } from "./lib/exec.ts";
import {
  MEDIA_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  burnSubtitlesMedia,
  concatMedia,
  extractAudioMedia,
  muxVoiceMedia,
  probeMedia,
  sliceMedia,
  transcodeMedia,
} from "./lib/media.ts";
import type { MediaDeps } from "./lib/media.ts";
import { resolveWwrsWorkspace } from "./lib/workspace.ts";
import type { HostContext, ToolExecLike, ToolRecord } from "./lib/host.ts";

export type FfmpegToolsConfig = {
  workspace?: string;
  ffmpegBin?: string;
  ffprobeBin?: string;
  ctx?: HostContext;
};

/** nullable number 输出节点（durationMs/width/height：无语义即 null，不 400）。 */
const NULLABLE_NUMBER = { oneOf: [{ type: "number" }, { type: "null" }] } as const;

const PROBE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    durationMs: { ...NULLABLE_NUMBER, description: "时长毫秒；静图等无时长语义返回 null" },
    width: { ...NULLABLE_NUMBER, description: "画面宽像素；无视频流返回 null" },
    height: { ...NULLABLE_NUMBER, description: "画面高像素；无视频流返回 null" },
  },
} as const;

const WRITE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    out: { type: "string", description: "产物路径（工作区相对路径原文）" },
    skipped: { type: "boolean", description: "true=产物已存在且 overwrite=false，未执行" },
  },
} as const;

const OVERWRITE_PARAM = {
  type: "boolean",
  description: "覆盖语义（缺省 false：false 且产物存在 → 成功返回 {skipped:true} 不执行；true=覆盖写）",
} as const;

/** 本次调用的工作区（config.workspace > env WWRS_WORKSPACE > 中性锚探测；cwd 取会话面）。 */
function resolveCallWorkspace(exec: unknown, config?: FfmpegToolsConfig): string {
  const like = exec as unknown as ToolExecLike;
  const cwd = String(like?.agent?.session?.meta?.cwd ?? like?.agent?.session?.header?.cwd ?? process.cwd());
  return resolveWwrsWorkspace(cwd, { configWorkspace: config?.workspace });
}

/** 本次调用的执行核依赖（载具四级解析 + signal 下钻；缺二进制即 fail-loud）。 */
function buildDeps(config: FfmpegToolsConfig | undefined, exec: unknown): MediaDeps {
  const like = exec as unknown as ToolExecLike;
  const signal = like?.signal;
  return {
    ffmpegBin: resolveFfmpegBin({ configBin: config?.ffmpegBin }).bin,
    ffprobeBin: resolveFfprobeBin({ configBin: config?.ffprobeBin }).bin,
    run: (bin, args, opts) => runBin(bin, args, signal ? { ...opts, signal } : opts),
  };
}

function renderWrite(tool: string, value: unknown): Array<{ type: "text"; text: string }> {
  const v = value as { out?: string; skipped?: boolean };
  const text = v?.skipped ? `[${tool}] 跳过：${v?.out ?? ""} 已存在（overwrite=false）` : `[${tool}] 输出：${v?.out ?? ""}`;
  return [{ type: "text", text }];
}

function makeProbeTool(config?: FfmpegToolsConfig): ToolRecord {
  return defineTool({
    name: "media_probe",
    description:
      "Probe a media file (ffprobe): duration milliseconds + width/height. Params: path（工作区相对路径）. Still images have no duration → durationMs=null（不报错）.",
    parameters: {
      path: { type: "string", required: true, description: "输入路径（工作区相对路径，如 media/in.mp4）" },
    },
    output: {
      schema: PROBE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => {
        const v = value as { durationMs?: number | null; width?: number | null; height?: number | null };
        return [{ type: "text", text: `[media_probe] durationMs=${String(v?.durationMs)} ${String(v?.width)}x${String(v?.height)}` }];
      },
    },
    timeoutMs: PROBE_TIMEOUT_MS,
    async execute(args, exec) {
      const ws = resolveCallWorkspace(exec, config);
      return probeMedia(buildDeps(config, exec), ws, args);
    },
  }) as unknown as ToolRecord;
}

function makeTranscodeTool(config?: FfmpegToolsConfig): ToolRecord {
  return defineTool({
    name: "media_transcode",
    description:
      "Re-encode src to out (libx264+aac faststart by default). Params: src/out（工作区相对路径）+ optional videoCodec/audioCodec/crf/preset/extraArgs + overwrite（缺省 false）. extraArgs 为 string[]，原样拼入 argv（风险自负：可覆盖任意编码开关）。",
    parameters: {
      src: { type: "string", required: true, description: "输入路径（工作区相对路径）" },
      out: { type: "string", required: true, description: "输出路径（工作区相对路径）" },
      videoCodec: { type: "string", description: "视频编码器（缺省 libx264）" },
      audioCodec: { type: "string", description: "音频编码器（缺省 aac）" },
      crf: { type: "number", description: "质量系数 0~51（缺省 23，越小质量越高）" },
      preset: { type: "string", description: "编码速度档（缺省 veryfast）" },
      extraArgs: { type: "array", items: { type: "string" }, description: "透传 argv（string[]，原样拼在输出路径之前，风险自负）" },
      overwrite: OVERWRITE_PARAM,
    },
    output: {
      schema: WRITE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => renderWrite("media_transcode", value),
    },
    timeoutMs: MEDIA_TIMEOUT_MS,
    async execute(args, exec) {
      const ws = resolveCallWorkspace(exec, config);
      return transcodeMedia(buildDeps(config, exec), ws, args);
    },
  }) as unknown as ToolRecord;
}

function makeConcatTool(config?: FfmpegToolsConfig): ToolRecord {
  return defineTool({
    name: "media_concat",
    description:
      "Concatenate clips to out. Params: clips（工作区相对路径数组，≥1）+ out + optional options{reencode（缺省 true：filter-complex 归一重编；false=demuxer 直拷）,fps,audioBitrate} + overwrite（缺省 false）. 单片段即转码归一。",
    parameters: {
      clips: { type: "array", items: { type: "string" }, required: true, description: "片段路径数组（工作区相对路径，≥1 个）" },
      out: { type: "string", required: true, description: "输出路径（工作区相对路径）" },
      options: {
        type: "object",
        additionalProperties: false,
        properties: {
          reencode: { type: "boolean", description: "true=归一重编（缺省）；false=demuxer 直拷" },
          fps: { type: "number", description: "输出帧率（仅重编）" },
          audioBitrate: { type: "string", description: "音频码率（缺省 192k）" },
        },
      },
      overwrite: OVERWRITE_PARAM,
    },
    output: {
      schema: WRITE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => renderWrite("media_concat", value),
    },
    timeoutMs: MEDIA_TIMEOUT_MS,
    async execute(args, exec) {
      const ws = resolveCallWorkspace(exec, config);
      return concatMedia(buildDeps(config, exec), ws, args);
    },
  }) as unknown as ToolRecord;
}

function makeSliceTool(config?: FfmpegToolsConfig): ToolRecord {
  return defineTool({
    name: "media_slice",
    description:
      "Slice [startMs,endMs) from src to out (re-encoded). Params: src/out（工作区相对路径）+ startMs/endMs（毫秒，须 endMs>startMs>=0）+ overwrite（缺省 false）.",
    parameters: {
      src: { type: "string", required: true, description: "输入路径（工作区相对路径）" },
      startMs: { type: "number", required: true, description: "起点毫秒（>=0）" },
      endMs: { type: "number", required: true, description: "终点毫秒（须大于 startMs）" },
      out: { type: "string", required: true, description: "输出路径（工作区相对路径）" },
      overwrite: OVERWRITE_PARAM,
    },
    output: {
      schema: WRITE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => renderWrite("media_slice", value),
    },
    timeoutMs: MEDIA_TIMEOUT_MS,
    async execute(args, exec) {
      const ws = resolveCallWorkspace(exec, config);
      return sliceMedia(buildDeps(config, exec), ws, args);
    },
  }) as unknown as ToolRecord;
}

function makeMuxTool(config?: FfmpegToolsConfig): ToolRecord {
  return defineTool({
    name: "media_mux_voice",
    description:
      "Mux voiceAudio onto video to out (audio padded/trimmed to video duration). Params: video/voiceAudio/out（工作区相对路径）+ optional attenuationDb（<=0 的分贝；缺省=替换原音轨，给定=原音轨衰减后混入）+ overwrite（缺省 false）.",
    parameters: {
      video: { type: "string", required: true, description: "画面输入路径（工作区相对路径）" },
      voiceAudio: { type: "string", required: true, description: "配音输入路径（工作区相对路径）" },
      out: { type: "string", required: true, description: "输出路径（工作区相对路径）" },
      attenuationDb: { type: "number", description: "原音轨衰减分贝（<=0，如 -10；缺省=替换原音轨）" },
      overwrite: OVERWRITE_PARAM,
    },
    output: {
      schema: WRITE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => renderWrite("media_mux_voice", value),
    },
    timeoutMs: MEDIA_TIMEOUT_MS,
    async execute(args, exec) {
      const ws = resolveCallWorkspace(exec, config);
      return muxVoiceMedia(buildDeps(config, exec), ws, args);
    },
  }) as unknown as ToolRecord;
}

function makeBurnTool(config?: FfmpegToolsConfig): ToolRecord {
  return defineTool({
    name: "media_burn_subtitles",
    description:
      "Burn srt subtitles into video to output (video re-encoded, audio copied). Params: video/srt/output（工作区相对路径，srt 须 .srt）+ optional options{forceStyle,encoding} + overwrite（缺省 false）.",
    parameters: {
      video: { type: "string", required: true, description: "输入视频路径（工作区相对路径）" },
      srt: { type: "string", required: true, description: "字幕路径（工作区相对路径，须 .srt）" },
      output: { type: "string", required: true, description: "输出路径（工作区相对路径）" },
      options: {
        type: "object",
        additionalProperties: false,
        properties: {
          forceStyle: { type: "string", description: "字幕样式覆盖（如 FontSize=16）" },
          encoding: { type: "string", description: "字幕字符编码（如 utf-8，走 charenc）" },
        },
      },
      overwrite: OVERWRITE_PARAM,
    },
    output: {
      schema: WRITE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => renderWrite("media_burn_subtitles", value),
    },
    timeoutMs: MEDIA_TIMEOUT_MS,
    async execute(args, exec) {
      const ws = resolveCallWorkspace(exec, config);
      return burnSubtitlesMedia(buildDeps(config, exec), ws, args);
    },
  }) as unknown as ToolRecord;
}

function makeExtractTool(config?: FfmpegToolsConfig): ToolRecord {
  return defineTool({
    name: "media_extract_audio",
    description:
      "Extract the first audio stream from src to out (aac 128k, no video). Params: src/out（工作区相对路径）+ overwrite（缺省 false）. 源无音频流即 fail-loud.",
    parameters: {
      src: { type: "string", required: true, description: "输入路径（工作区相对路径）" },
      out: { type: "string", required: true, description: "输出路径（工作区相对路径）" },
      overwrite: OVERWRITE_PARAM,
    },
    output: {
      schema: WRITE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => renderWrite("media_extract_audio", value),
    },
    timeoutMs: MEDIA_TIMEOUT_MS,
    async execute(args, exec) {
      const ws = resolveCallWorkspace(exec, config);
      return extractAudioMedia(buildDeps(config, exec), ws, args);
    },
  }) as unknown as ToolRecord;
}

/** 注册面工厂（cordis apply 消费；tests 直调验合同形状）。 */
export function createFfmpegTools(config?: FfmpegToolsConfig): ToolRecord[] {
  return [
    makeProbeTool(config),
    makeTranscodeTool(config),
    makeConcatTool(config),
    makeSliceTool(config),
    makeMuxTool(config),
    makeBurnTool(config),
    makeExtractTool(config),
  ];
}
