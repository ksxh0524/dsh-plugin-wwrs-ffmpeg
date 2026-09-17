/** cordis.ts —— dsh-plugin-wwrs-ffmpeg 挂载适配层（W0 空壳；官方插件形：default={name,inject,apply} 对象）。
 *
 * 注册面（W1 落地）：media_probe / media_transcode / media_concat / media_slice / media_mux_voice /
 * media_burn_subtitles → ctx.tools.register；写保护守卫 → ctx.tools.guard（谓词真源见 lib/guard-predicate.ts）。
 * 行名与包名对齐（dsh-plugin-wwrs-ffmpeg）；改名必同步 package.json 与 cordis.patch.yml。
 */

import { registerFfmpegGuard } from "./guard.ts";
import type { HostContext } from "./lib/host.ts";

export const name = "dsh-plugin-wwrs-ffmpeg";
export const inject: string[] = ["tools"];

export type CordisConfig = {
  /** 工作区根（profile patch 行 config.workspace=<绝对路径>；缺省 env WWRS_WORKSPACE，再缺省中性锚探测）。 */
  workspace?: string;
  /** ffmpeg 可执行绝对路径（缺省 env WWRS_FFMPEG_BIN > 包内 .bin > PATH）。 */
  ffmpegBin?: string;
  /** ffprobe 可执行绝对路径（同上分级）。 */
  ffprobeBin?: string;
};

export function apply(ctx: HostContext, config?: CordisConfig) {
  const unregister = registerFfmpegGuard(ctx);
  ctx.logger?.info?.(
    `[dsh-plugin-wwrs-ffmpeg] shell on（workspace=${config?.workspace ?? "(env WWRS_WORKSPACE/中性锚探测)"} guard=${typeof unregister === "function" ? "on" : "no-hook"}；工具在 W1 落地）`,
  );
  return { unregister };
}

export default { name, inject, apply };
