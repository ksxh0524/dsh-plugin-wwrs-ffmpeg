/** carrier.ts —— ffmpeg/ffprobe 载具四级解析（包内单源；零业务名词，只认路径）。
 *
 * 解析顺序（第一命中即赢，禁绝对路径缺省）：
 * ① 调用方 config 注入（宿主 profile patch 行 config.ffmpegBin / config.ffprobeBin）；
 * ② env WWRS_FFMPEG_BIN / WWRS_FFPROBE_BIN；
 * ③ 包内 node_modules/.bin/ffmpeg（相对本文件锚定包根，link: 挂载落点自动成立）；
 * ④ PATH 扫描。
 * 四级皆空 = fail-loud：抛文案给足三条出路（注入键 / env 名 / pnpm install），绝不静默降级。
 * 注入值（①②）指向不存在文件时也 fail-loud——错位的注入比缺失更难查，静默跳级会让
 * “配了没生效”骗过所有人（与 HyperFrames bin.ts 同口径，只读其分级意图）。
 */

import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FFMPEG_BIN_ENV = "WWRS_FFMPEG_BIN";
export const FFPROBE_BIN_ENV = "WWRS_FFPROBE_BIN";
export const FFMPEG_BASENAME = "ffmpeg";
export const FFPROBE_BASENAME = "ffprobe";

export type CarrierSource = "config" | "env" | "package" | "path";
export type ResolvedCarrier = { bin: string; source: CarrierSource };
/** 存在性探针（测试注入假文件系统视图用；缺省 = existsSync + 可执行位）。 */
export type CarrierProbe = (p: string) => boolean;

function defaultProbe(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    // 平台无 X_OK 语义时回落到“存在即可”。
    return true;
  }
}

/** 包内 bin 目录（相对本文件锚定：src/lib → 包根）。 */
function pkgBinDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".bin");
}

/** 找不到可执行时的统一文案（三条出路齐全，测试锁死）。 */
function unresolvableText(basename: string, configKey: string, envName: string): string {
  return (
    `${basename} 可执行未解析（config.${configKey} / env ${envName} / 包内 node_modules/.bin/${basename} / PATH 四级皆空）。` +
    `三条出路：① 宿主 profile patch 行 config.${configKey} 注入 ${basename} 可执行文件绝对路径；` +
    `② 设环境变量 ${envName}=<绝对路径>；` +
    `③ 跑 pnpm install（装完包内 node_modules/.bin/${basename} 就位，或确认 ${basename} 在 PATH 中）。`
  );
}

export type ResolveCarrierOpts = {
  configBin?: string;
  env?: Record<string, string | undefined>;
  probe?: CarrierProbe;
};

/** 通用四级解析（ffmpeg/ffprobe 共用；basename/configKey/envName 三元点名，错位报错不串味）。 */
export function resolveCarrier(basename: string, configKey: string, envName: string, opts: ResolveCarrierOpts = {}): ResolvedCarrier {
  const probe = opts.probe ?? defaultProbe;
  const env = opts.env ?? process.env;
  const cfg = String(opts.configBin ?? "").trim();
  if (cfg) {
    if (!probe(cfg)) throw new Error(`config.${configKey} 指向不存在的可执行文件：${cfg}（改对注入值，或清空以回落后续解析级）`);
    return { bin: cfg, source: "config" };
  }
  const ev = String(env[envName] ?? "").trim();
  if (ev) {
    if (!probe(ev)) throw new Error(`env ${envName} 指向不存在的可执行文件：${ev}（改对环境变量值，或清空以回落后续解析级）`);
    return { bin: ev, source: "env" };
  }
  const inPkg = join(pkgBinDir(), basename);
  if (probe(inPkg)) return { bin: inPkg, source: "package" };
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, basename);
    if (probe(cand)) return { bin: cand, source: "path" };
  }
  throw new Error(unresolvableText(basename, configKey, envName));
}

/** ffmpeg 四级：config.ffmpegBin > env WWRS_FFMPEG_BIN > 包内 .bin > PATH。 */
export function resolveFfmpegBin(opts: ResolveCarrierOpts = {}): ResolvedCarrier {
  return resolveCarrier(FFMPEG_BASENAME, "ffmpegBin", FFMPEG_BIN_ENV, opts);
}

/** ffprobe 四级：config.ffprobeBin > env WWRS_FFPROBE_BIN > 包内 .bin > PATH。 */
export function resolveFfprobeBin(opts: ResolveCarrierOpts = {}): ResolvedCarrier {
  return resolveCarrier(FFPROBE_BASENAME, "ffprobeBin", FFPROBE_BIN_ENV, opts);
}
