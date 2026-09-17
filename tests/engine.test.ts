/** engine.test.ts —— W1 执行核测试（纯逻辑 fixture 全覆盖 + 真 exec 门控）。
 *
 * 纯逻辑：参数校验 fail-loud 四字段、载具四级、overwrite 短路、argv 组装、守卫谓词——
 * 全部用 fixture/假执行覆盖，不碰真二进制。
 * 真 exec：门控于 ffmpeg/ffprobe 是否在 PATH 可解析——无即 skip（不删，红线）。
 * 有则在 os.tmpdir() 下建工作区现造 tiny 媒体（lavfi testsrc/sine），跑全七工具真链路。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FailLoudError } from "../src/lib/errors.ts";
import { resolveFfmpegBin, resolveFfprobeBin } from "../src/lib/carrier.ts";
import { runBin, type ExecFn, type ExecResult } from "../src/lib/exec.ts";
import { ffmpegGuardPredicate, isOutOfWorkspacePath } from "../src/lib/guard-predicate.ts";
import {
  buildBurnArgs,
  buildConcatListContent,
  buildConcatReencodeArgs,
  buildExtractArgs,
  buildMuxArgs,
  buildSliceArgs,
  buildTranscodeArgs,
  burnSubtitlesMedia,
  concatMedia,
  escapeSubtitlesPath,
  extractAudioMedia,
  muxVoiceMedia,
  parseAttenuationDb,
  parseBurnOptions,
  parseConcatOptions,
  parseProbeDuration,
  parseProbeSize,
  parseSliceRange,
  probeMedia,
  sliceMedia,
  transcodeMedia,
  type MediaDeps,
} from "../src/lib/media.ts";
import { createFfmpegTools } from "../src/tools.ts";
import { resolveInWorkspace, resolveWwrsWorkspace } from "../src/lib/workspace.ts";

// ---------- 小件 ----------

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), "wwrs-ffmpeg-"));
}

function fakeRun(handler: (bin: string, args: readonly string[]) => ExecResult): { calls: Array<{ bin: string; args: readonly string[] }>; run: ExecFn } {
  const calls: Array<{ bin: string; args: readonly string[] }> = [];
  return {
    calls,
    run: async (bin, args) => {
      calls.push({ bin, args });
      return handler(bin, args);
    },
  };
}

function fakeDeps(over: { run?: ExecFn; exists?: (p: string) => boolean } = {}): MediaDeps {
  const f = fakeRun(() => ({ stdout: "", stderr: "" }));
  return { ffmpegBin: "/fake/ffmpeg", ffprobeBin: "/fake/ffprobe", run: over.run ?? f.run, ...(over.exists ? { exists: over.exists } : {}) };
}

/** 断言 FailLoudError 四字段齐全（一次改对契约）。 */
function assertFailLoud(e: unknown, param: string): void {
  assert.ok(e instanceof FailLoudError, `期望 FailLoudError，收到 ${String(e)}`);
  assert.equal(e.param, param);
  assert.ok(e.expected.trim().length > 0, "expected 为空");
  assert.ok(e.example.trim().length > 0, "example 为空");
  assert.ok(e.message.includes(param), "message 未点名 param");
}

// ---------- 工具合同形状（defineTool 三件套） ----------

test("工具合同：7 工具齐名 + output.schema/render + 正数 timeoutMs", () => {
  const tools = createFfmpegTools({});
  assert.equal(tools.length, 7);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["media_burn_subtitles", "media_concat", "media_extract_audio", "media_mux_voice", "media_probe", "media_slice", "media_transcode"]);
  for (const t of tools) {
    const rec = t as unknown as Record<string, unknown>;
    const output = rec.output as Record<string, unknown>;
    assert.ok(output && typeof output === "object", `${t.name} 缺 output`);
    assert.ok("schema" in output, `${t.name} 缺 output.schema`);
    assert.equal(typeof output.render, "function", `${t.name} 缺 output.render`);
    assert.ok(typeof rec.timeoutMs === "number" && (rec.timeoutMs as number) > 0, `${t.name} 缺正数 timeoutMs`);
  }
  const timeouts = new Map(tools.map((t) => [t.name, (t as unknown as Record<string, unknown>).timeoutMs as number]));
  assert.equal(timeouts.get("media_probe"), 60_000);
  for (const n of ["media_transcode", "media_concat", "media_slice", "media_mux_voice", "media_burn_subtitles", "media_extract_audio"]) {
    assert.equal(timeouts.get(n), 30 * 60_000);
  }
});

// ---------- 载具四级 ----------

test("载具：config > env > 包内 .bin > PATH（命中即赢）", () => {
  const yes = ["/cfg/ffmpeg", "/env/ffmpeg"];
  const probe = (p: string): boolean => yes.includes(p);
  assert.equal(resolveFfmpegBin({ configBin: "/cfg/ffmpeg", env: { WWRS_FFMPEG_BIN: "/env/ffmpeg" }, probe }).source, "config");
  assert.equal(resolveFfmpegBin({ env: { WWRS_FFMPEG_BIN: "/env/ffmpeg" }, probe }).source, "env");
  assert.equal(resolveFfmpegBin({ env: {}, probe: (p) => p.includes("node_modules") && p.endsWith("ffmpeg") }).source, "package");
  assert.equal(resolveFfmpegBin({ env: { PATH: "/p" }, probe: (p) => p === "/p/ffmpeg" }).source, "path");
});

test("载具：四级皆空 fail-loud 点名三条出路", () => {
  assert.throws(
    () => resolveFfmpegBin({ env: {}, probe: () => false }),
    (e: unknown) => {
      const m = (e as Error).message;
      return m.includes("config.ffmpegBin") && m.includes("WWRS_FFMPEG_BIN") && m.includes("pnpm install");
    },
  );
  assert.throws(
    () => resolveFfprobeBin({ env: {}, probe: () => false }),
    (e: unknown) => (e as Error).message.includes("WWRS_FFPROBE_BIN"),
  );
});

test("载具：注入错位不跳级（config/env 指错即抛，不回落）", () => {
  assert.throws(
    () => resolveFfmpegBin({ configBin: "/nope", env: { WWRS_FFMPEG_BIN: "/env/ffmpeg" }, probe: (p) => p === "/env/ffmpeg" }),
    /config\.ffmpegBin/,
  );
  assert.throws(() => resolveFfmpegBin({ env: { WWRS_FFMPEG_BIN: "/nope", PATH: "/p" }, probe: (p) => p === "/p/ffmpeg" }), /WWRS_FFMPEG_BIN/);
});

// ---------- 执行面 ----------

test("执行面：execFile 成功回 stdout/stderr", async () => {
  const r = await runBin(process.execPath, ["-e", "process.stdout.write('hi');process.stderr.write('ee')"], { timeoutMs: 10_000, context: "ut" });
  assert.equal(r.stdout, "hi");
  assert.equal(r.stderr, "ee");
});

test("执行面：非零退出 fail-loud 带上下文与 stderr", async () => {
  await assert.rejects(
    runBin(process.execPath, ["-e", "console.error('boom-x');process.exit(3)"], { timeoutMs: 10_000, context: "ut-transcode" }),
    (e: unknown) => (e as Error).message.includes("ut-transcode") && (e as Error).message.includes("boom-x"),
  );
});

test("执行面：超时点名预算", async () => {
  await assert.rejects(
    runBin(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { timeoutMs: 200, context: "ut-timeout" }),
    (e: unknown) => (e as Error).message.includes("ut-timeout") && (e as Error).message.includes("200"),
  );
});

test("执行面：signal 中止点名取消", async () => {
  const c = new AbortController();
  const p = runBin(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { timeoutMs: 10_000, signal: c.signal, context: "ut-cancel" });
  c.abort();
  await assert.rejects(p, (e: unknown) => (e as Error).message.includes("ut-cancel") && (e as Error).message.includes("取消"));
});

test("执行面：timeoutMs 非正即内部错误", async () => {
  await assert.rejects(runBin(process.execPath, ["-e", "1"], { timeoutMs: 0, context: "ut" }), /timeoutMs/);
});

// ---------- 工作区 ----------

test("工作区：config > env > 中性锚 > fail-loud", () => {
  const ws = tmpWs();
  assert.equal(resolveWwrsWorkspace("/whatever", { configWorkspace: ws }), ws);
  assert.equal(resolveWwrsWorkspace("/whatever", { env: { WWRS_WORKSPACE: ws } }), ws);
  const deep = join(ws, "a", "b");
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(ws, ".wwrs"), { recursive: true });
  writeFileSync(join(ws, ".wwrs", "workspace.json"), "{}");
  assert.equal(resolveWwrsWorkspace(deep, { env: {} }), ws);
});

test("工作区：全 miss 点名 WWRS_WORKSPACE", () => {
  assert.throws(
    () => resolveWwrsWorkspace(tmpWs(), { env: {} }),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "workspace",
  );
});

test("落点：绝对/越界抛，相对拼入", () => {
  const ws = tmpWs();
  assert.throws(
    () => resolveInWorkspace(ws, "/abs/a.mp4", "src"),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "src",
  );
  assert.throws(
    () => resolveInWorkspace(ws, "../out.mp4", "out"),
    (e: unknown) => e instanceof FailLoudError,
  );
  assert.throws(
    () => resolveInWorkspace(ws, "  ", "out"),
    (e: unknown) => e instanceof FailLoudError,
  );
  assert.equal(resolveInWorkspace(ws, "media/a.mp4", "src").abs, join(ws, "media", "a.mp4"));
});

// ---------- 探测纯逻辑 ----------

test("探测解析：时长/尺寸纯函数", () => {
  assert.equal(parseProbeDuration("12.345\n"), 12345);
  assert.equal(parseProbeDuration("N/A\n"), null);
  assert.equal(parseProbeDuration(""), null);
  assert.equal(parseProbeDuration("abc"), null);
  assert.deepEqual(parseProbeSize("640x480"), { width: 640, height: 480 });
  assert.equal(parseProbeSize(""), null);
  assert.equal(parseProbeSize("N/A"), null);
});

test("探测：不可解码 fail-loud 点名 path", async () => {
  const f = fakeRun(() => {
    throw new Error("exit=1");
  });
  await probeMedia({ ...fakeDeps(), run: f.run }, tmpWs(), { path: "media/x.mp4" }).then(
    () => assert.fail("应抛"),
    (e: unknown) => assertFailLoud(e, "path"),
  );
});

// ---------- 转码纯逻辑 ----------

test("转码 argv：缺省编解码 + extraArgs 原样透传", () => {
  const a = buildTranscodeArgs("/w/in.mp4", "/w/out.mp4", { videoCodec: "libx264", audioCodec: "aac", crf: 23, preset: "veryfast", extraArgs: ["-r", "30"] });
  assert.ok(a.includes("libx264") && a.includes("aac") && a.includes("23") && a.includes("veryfast"));
  assert.deepEqual(a.slice(-3), ["-r", "30", "/w/out.mp4"]);
});

test("转码校验：crf/preset/extraArgs 非法一次改对", async () => {
  const ws = tmpWs();
  const d = fakeDeps();
  await transcodeMedia(d, ws, { src: "a.mp4", out: "b.mp4", crf: 99 }).then(
    () => assert.fail("应抛"),
    (e: unknown) => assertFailLoud(e, "crf"),
  );
  await transcodeMedia(d, ws, { src: "a.mp4", out: "b.mp4", preset: "turbo" }).then(
    () => assert.fail("应抛"),
    (e: unknown) => assertFailLoud(e, "preset"),
  );
  await transcodeMedia(d, ws, { src: "a.mp4", out: "b.mp4", extraArgs: "-r" }).then(
    () => assert.fail("应抛"),
    (e: unknown) => assertFailLoud(e, "extraArgs"),
  );
  await transcodeMedia(d, ws, { src: "/abs.mp4", out: "b.mp4" }).then(
    () => assert.fail("应抛"),
    (e: unknown) => assertFailLoud(e, "src"),
  );
});

// ---------- overwrite 短路 ----------

test("overwrite：false 且产物存在 → skipped 不执行；true 则执行", async () => {
  const ws = tmpWs();
  const f = fakeRun(() => ({ stdout: "", stderr: "" }));
  const d: MediaDeps = { ...fakeDeps(), run: f.run };
  writeFileSync(join(ws, "out.mp4"), "old");
  const skipped = await transcodeMedia(d, ws, { src: "in.mp4", out: "out.mp4" });
  assert.deepEqual(skipped, { out: "out.mp4", skipped: true });
  assert.equal(f.calls.length, 0);
  const wrote = await transcodeMedia(d, ws, { src: "in.mp4", out: "out.mp4", overwrite: true });
  assert.deepEqual(wrote, { out: "out.mp4", skipped: false });
  assert.equal(f.calls.length, 1);
  await transcodeMedia(d, ws, { src: "in.mp4", out: "o2.mp4", overwrite: "yes" }).then(
    () => assert.fail("应抛"),
    (e: unknown) => assertFailLoud(e, "overwrite"),
  );
});

// ---------- 拼接纯逻辑 ----------

test("拼接 options：缺省重编；非法一次改对", () => {
  assert.deepEqual(parseConcatOptions(undefined), { reencode: true });
  assert.deepEqual(parseConcatOptions({ reencode: false }), { reencode: false });
  assert.throws(
    () => parseConcatOptions([]),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "options",
  );
  assert.throws(
    () => parseConcatOptions({ fps: 0 }),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "options.fps",
  );
  assert.throws(
    () => parseConcatOptions({ audioBitrate: " " }),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "options.audioBitrate",
  );
});

test("拼接清单：单引号转义", () => {
  assert.equal(buildConcatListContent(["/w/a'b.mp4"]), "file '/w/a'\\''b.mp4'\n");
});

test("拼接重编 argv：画布归一 + n 段 concat", () => {
  const a = buildConcatReencodeArgs(["/w/a.mp4", "/w/b.mp4"], "/w/o.mp4", { width: 64, height: 64, audioBitrate: "192k" });
  const gi = a.indexOf("-filter_complex");
  assert.ok(gi >= 0 && (a[gi + 1] as string).includes("concat=n=2:v=1:a=1"));
  assert.ok((a[gi + 1] as string).includes("scale=64:64"));
});

test("拼接：空 clips fail-loud；单片段走转码归一", async () => {
  const ws = tmpWs();
  const d = fakeDeps();
  await concatMedia(d, ws, { clips: [], out: "o.mp4" }).then(
    () => assert.fail("应抛"),
    (e: unknown) => assertFailLoud(e, "clips"),
  );
  const f = fakeRun(() => ({ stdout: "", stderr: "" }));
  const r = await concatMedia({ ...fakeDeps(), run: f.run }, ws, { clips: ["a.mp4"], out: "o.mp4" });
  assert.deepEqual(r, { out: "o.mp4", skipped: false });
  assert.ok(f.calls[0]?.args.includes("libx264"));
});

// ---------- 切片纯逻辑 ----------

test("切片区间：非法一次改对；argv 秒换算", () => {
  assert.throws(
    () => parseSliceRange(5000, 1000),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "endMs",
  );
  assert.throws(
    () => parseSliceRange(-1, 1000),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "startMs",
  );
  assert.deepEqual(parseSliceRange(1000, 3500), { startMs: 1000, endMs: 3500 });
  const a = buildSliceArgs("/w/in.mp4", "/w/o.mp4", { startMs: 1000, endMs: 3500 });
  assert.ok(a.includes("1.000") && a.includes("2.500"));
});

test("切片：执行核拒绝非法区间", async () => {
  await sliceMedia(fakeDeps(), tmpWs(), { src: "a.mp4", startMs: 9, endMs: 9, out: "o.mp4" }).then(
    () => assert.fail("应抛"),
    (e: unknown) => assertFailLoud(e, "endMs"),
  );
});

// ---------- 混流纯逻辑 ----------

test("混流：attenuationDb 语义 + argv 双模式", () => {
  assert.equal(parseAttenuationDb(undefined), undefined);
  assert.equal(parseAttenuationDb(-10), -10);
  assert.throws(
    () => parseAttenuationDb(3),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "attenuationDb",
  );
  assert.throws(
    () => parseAttenuationDb(Number.NaN),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "attenuationDb",
  );
  const rep = buildMuxArgs("/w/v.mp4", "/w/n.mp3", "/w/o.mp4", { videoDurSec: "2.000" });
  assert.ok(rep.includes("0:v:0") && rep.join(" ").includes("apad=whole_dur=2.000"));
  const mix = buildMuxArgs("/w/v.mp4", "/w/n.mp3", "/w/o.mp4", { videoDurSec: "2.000", attenuationDb: -10 });
  assert.ok(mix.join(" ").includes("volume=-10dB") && mix.join(" ").includes("amix=inputs=2"));
});

test("混流：视频无时长 fail-loud 点名 video", async () => {
  const f = fakeRun(() => ({ stdout: "N/A\n", stderr: "" }));
  await muxVoiceMedia({ ...fakeDeps(), run: f.run }, tmpWs(), { video: "v.mp4", voiceAudio: "n.mp3", out: "o.mp4" }).then(
    () => assert.fail("应抛"),
    (e: unknown) => assertFailLoud(e, "video"),
  );
});

// ---------- 烧字幕纯逻辑 ----------

test("烧字幕 options + 滤镜转义 + argv", () => {
  assert.deepEqual(parseBurnOptions(undefined), {});
  assert.throws(
    () => parseBurnOptions("x"),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "options",
  );
  assert.throws(
    () => parseBurnOptions({ forceStyle: " " }),
    (e: unknown) => e instanceof FailLoudError && (e as FailLoudError).param === "options.forceStyle",
  );
  assert.ok(escapeSubtitlesPath("/w/a:b's.mp4").includes("\\:"));
  const a = buildBurnArgs("/w/v.mp4", "/w/s.srt", "/w/o.mp4", { forceStyle: "FontSize=16", encoding: "utf-8" });
  const vf = a[a.indexOf("-vf") + 1] as string;
  assert.ok(vf.includes("subtitles=") && vf.includes("force_style=") && vf.includes("charenc=utf-8"));
});

test("烧字幕：非 srt 拒绝点名 srt", async () => {
  await burnSubtitlesMedia(fakeDeps(), tmpWs(), { video: "v.mp4", srt: "s.txt", output: "o.mp4" }).then(
    () => assert.fail("应抛"),
    (e: unknown) => assertFailLoud(e, "srt"),
  );
});

// ---------- 提音频纯逻辑 ----------

test("提音频 argv：首流 + 去画面", () => {
  const a = buildExtractArgs("/w/in.mp4", "/w/o.m4a");
  assert.ok(a.includes("0:a:0") && a.includes("-vn") && a[a.length - 1] === "/w/o.m4a");
});

// ---------- 守卫谓词 ----------

test("守卫：绝对/越界拒，相对放，非本包工具放", () => {
  assert.ok(typeof ffmpegGuardPredicate({ name: "media_probe", arguments: { path: "/abs/a.mp4" } }) === "string");
  assert.ok((ffmpegGuardPredicate({ name: "media_probe", arguments: { path: "/abs/a.mp4" } }) as string).includes("media_probe"));
  assert.ok(typeof ffmpegGuardPredicate({ name: "media_concat", arguments: { clips: ["a.mp4", "../out.mp4"], out: "o.mp4" } }) === "string");
  assert.equal(ffmpegGuardPredicate({ name: "media_probe", arguments: { path: "media/a.mp4" } }), undefined);
  assert.equal(ffmpegGuardPredicate({ name: "other_tool", arguments: { path: "/abs" } }), undefined);
  assert.equal(isOutOfWorkspacePath("a/b.mp4"), false);
  assert.equal(isOutOfWorkspacePath("../x.mp4"), true);
  assert.equal(isOutOfWorkspacePath("C:\\w\\a.mp4"), true);
});

// ---------- 真 exec 门控（无二进制即 skip，不删） ----------

let HAVE_BINS = false;
let REAL_FFMPEG = "";
let REAL_FFPROBE = "";
try {
  REAL_FFMPEG = resolveFfmpegBin().bin;
  REAL_FFPROBE = resolveFfprobeBin().bin;
  HAVE_BINS = Boolean(REAL_FFMPEG && REAL_FFPROBE);
} catch {
  HAVE_BINS = false;
}

function realDeps(): MediaDeps {
  return { ffmpegBin: REAL_FFMPEG, ffprobeBin: REAL_FFPROBE, run: runBin };
}

/** 现造 tiny 带音视频（64x64 1s testsrc + sine）。 */
async function genAV(ws: string, rel: string, durSec = 1): Promise<string> {
  const abs = join(ws, rel);
  mkdirSync(join(ws, "media"), { recursive: true });
  await runBin(
    REAL_FFMPEG,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=64x64:rate=10:duration=${durSec}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${durSec}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      abs,
    ],
    {
      timeoutMs: 120_000,
      context: "ut-gen",
    },
  );
  return rel;
}

test("真链路：probe 视频时长与尺寸", { skip: !HAVE_BINS }, async () => {
  const ws = tmpWs();
  const rel = await genAV(ws, "media/a.mp4");
  const r = await probeMedia(realDeps(), ws, { path: rel });
  assert.ok(r.durationMs !== null && Math.abs(r.durationMs - 1000) < 300, `durationMs=${String(r.durationMs)}`);
  assert.deepEqual([r.width, r.height], [64, 64]);
});

test("真链路：probe 静图时长 null 不 400", { skip: !HAVE_BINS }, async () => {
  const ws = tmpWs();
  mkdirSync(join(ws, "media"), { recursive: true });
  await runBin(REAL_FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1", "-frames:v", "1", join(ws, "media/still.png")], {
    timeoutMs: 120_000,
    context: "ut-gen-still",
  });
  const r = await probeMedia(realDeps(), ws, { path: "media/still.png" });
  assert.equal(r.durationMs, null);
  assert.deepEqual([r.width, r.height], [64, 64]);
});

test("真链路：transcode + overwrite 短路", { skip: !HAVE_BINS }, async () => {
  const ws = tmpWs();
  const src = await genAV(ws, "media/in.mp4");
  const d = realDeps();
  const w = await transcodeMedia(d, ws, { src, out: "media/t.mp4" });
  assert.deepEqual(w, { out: "media/t.mp4", skipped: false });
  assert.ok(existsSync(join(ws, "media/t.mp4")));
  assert.deepEqual(await transcodeMedia(d, ws, { src, out: "media/t.mp4" }), { out: "media/t.mp4", skipped: true });
});

test("真链路：slice/extract/concat/mux/burn 全走通", { skip: !HAVE_BINS }, async () => {
  const ws = tmpWs();
  const d = realDeps();
  const a = await genAV(ws, "media/a.mp4");
  const b = await genAV(ws, "media/b.mp4");
  const sl = await sliceMedia(d, ws, { src: a, startMs: 0, endMs: 500, out: "media/sl.mp4" });
  assert.equal(sl.skipped, false);
  const ex = await extractAudioMedia(d, ws, { src: a, out: "media/au.m4a" });
  assert.equal(ex.skipped, false);
  const cc = await concatMedia(d, ws, { clips: [a, b], out: "media/cc.mp4" });
  assert.equal(cc.skipped, false);
  const cp = await concatMedia(d, ws, { clips: [a, b], out: "media/cp.mp4", options: { reencode: false } });
  assert.equal(cp.skipped, false);
  const mx = await muxVoiceMedia(d, ws, { video: a, voiceAudio: "media/au.m4a", out: "media/mx.mp4" });
  assert.equal(mx.skipped, false);
  const mm = await muxVoiceMedia(d, ws, { video: a, voiceAudio: "media/au.m4a", out: "media/mm.mp4", attenuationDb: -10 });
  assert.equal(mm.skipped, false);
  writeFileSync(join(ws, "media/subs.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHi\n");
  const bn = await burnSubtitlesMedia(d, ws, { video: a, srt: "media/subs.srt", output: "media/bn.mp4" });
  assert.equal(bn.skipped, false);
  for (const rel of ["media/sl.mp4", "media/au.m4a", "media/cc.mp4", "media/cp.mp4", "media/mx.mp4", "media/mm.mp4", "media/bn.mp4"]) {
    assert.ok(existsSync(join(ws, rel)), `${rel} 未产出`);
  }
  const probed = readFileSync(join(ws, "media/cc.mp4"));
  assert.ok(probed.length > 0);
});
