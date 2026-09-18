# dsh-plugin-wwrs-ffmpeg

本地媒体处理 DSH 插件（开源）：经本地 `ffmpeg`/`ffprobe` 做探测、转码、拼接、切片、配音混流与烧字幕。唯一运行时依赖是 @deepseek-ai/dsh-tools（defineTool DSL）。

## 状态

W1 完成：挂载层（`src/cordis.ts`）、写保护守卫与全部七个工具均已上线，经真实 ffmpeg/ffprobe 执行。

## 安装

```json
{
  "dependencies": {
    "dsh-plugin-wwrs-ffmpeg": "link:/path/to/plugin-wwrs-ffmpeg"
  },
  "dsh": { "profile": { "bundles": ["dsh-plugin-wwrs-ffmpeg"] } }
}
```

## 配置

| 键           | 含义                           | 缺省                                                 |
| ------------ | ------------------------------ | ---------------------------------------------------- |
| `workspace`  | 项目根（绝对路径）             | `WWRS_WORKSPACE` 环境变量，再中性锚探测              |
| `ffmpegBin`  | ffmpeg 可执行文件（绝对路径）  | `WWRS_FFMPEG_BIN` 环境变量，再包内 `.bin`，再 `PATH` |
| `ffprobeBin` | ffprobe 可执行文件（绝对路径） | 同上三级                                             |

二进制缺失即大声失败并给出路；绝不静默降级。

## 工具（W1）

`media_probe` / `media_transcode` / `media_concat` / `media_slice` / `media_mux_voice` / `media_burn_subtitles` / `media_extract_audio`。

所有路径只收工作区相对路径（绝对路径或越界即大声失败）。全部写工具带 `overwrite?: boolean`（缺省 false：false 且产物存在 → 成功返回 `{skipped:true}` 不执行，绝不静默覆盖）。`media_transcode` 收 `extraArgs: string[]`，原样拼入 argv（风险自负：可覆盖任意编码开关）。超时：探测 60s，转码系 30min；调用方取消（`exec.signal`）直达子进程。

## 验证

跑 `pnpm check`（prettier 检查 + `tsc --noEmit` + `node --test tests/*.test.ts`）。

## 许可

MIT.
