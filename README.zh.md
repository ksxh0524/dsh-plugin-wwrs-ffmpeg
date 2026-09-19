# dsh-plugin-wwrs-ffmpeg

[English](./README.md)

本地媒体处理 DSH 插件（开源）：经本地 `ffmpeg`/`ffprobe` 做探测、转码、拼接、切片、配音混流与烧字幕。唯一运行时依赖是 @deepseek-ai/dsh-tools（defineTool DSL）。W1 完成：挂载层（`src/cordis.ts`）、写保护守卫与全部七个工具均已上线，经真实 ffmpeg/ffprobe 执行。

## 工具

所有路径只收工作区相对路径（绝对路径或越界即大声失败）。全部写工具带 `overwrite?: boolean`（缺省 false：false 且产物存在 → 成功返回 `{skipped:true}` 不执行，绝不静默覆盖）。

| 工具                   | 参数                                                                                      | 语义                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `media_probe`          | `path`                                                                                    | 经 ffprobe 取时长毫秒 + 宽高；静图无时长 → `durationMs: null`，不报错                                     |
| `media_transcode`      | `src`、`out`、`videoCodec?`、`audioCodec?`、`crf?`、`preset?`、`extraArgs?`、`overwrite?` | 重编码（缺省 libx264+aac faststart）；`extraArgs: string[]` 原样拼入 argv（风险自负：可覆盖任意编码开关） |
| `media_concat`         | `clips[]`（≥1）、`out`、`options?{reencode?=true, fps?, audioBitrate?}`、`overwrite?`     | 缺省 filter-complex 归一重编拼接（`reencode: false` = demuxer 直拷）；单片段即转码归一                    |
| `media_slice`          | `src`、`out`、`startMs`、`endMs`（须 `endMs>startMs>=0`）、`overwrite?`                   | 切 `[startMs,endMs)`，重编码                                                                              |
| `media_mux_voice`      | `video`、`voiceAudio`、`out`、`attenuationDb?`、`overwrite?`                              | 配音按视频时长补齐/截断；缺省替换原音轨，给定分贝值则衰减后混入                                           |
| `media_burn_subtitles` | `video`、`srt`（须 `.srt`）、`output`、`options?{forceStyle?, encoding?}`、`overwrite?`   | 烧字幕（视频重编，音频直拷）                                                                              |
| `media_extract_audio`  | `src`、`out`、`overwrite?`                                                                | 首个音频流提为 aac 128k（无视频）；源无音频流即大声失败                                                   |

超时：探测 60s，转码系 30min；调用方取消（`exec.signal`）直达子进程。

## 合同

无远端调用——执行面是本地 `ffmpeg`/`ffprobe` 子进程；二进制经配置节注入面解析（`ffmpegBin`/`ffprobeBin` 配置键或环境变量，再包内 `.bin`，再 `PATH`）。二进制缺失即大声失败并给出路；绝不静默降级。

## 配置

| 键           | 含义                                           | 缺省                                                 |
| ------------ | ---------------------------------------------- | ---------------------------------------------------- |
| `workspace`  | 项目根（绝对路径）                             | `WWRS_WORKSPACE` 环境变量，再中性锚探测              |
| `ffmpegBin`  | ffmpeg 可执行文件（注入面：配置键或环境变量）  | `WWRS_FFMPEG_BIN` 环境变量，再包内 `.bin`，再 `PATH` |
| `ffprobeBin` | ffprobe 可执行文件（注入面：配置键或环境变量） | 同上三级                                             |

工作区解析：`config.workspace` > 环境变量 `WWRS_WORKSPACE` > 向上探测 `.wwrs/workspace.json` > 大声失败。缺失即大声失败并给出路；绝不静默降级。

## 安装

```json
{
  "dependencies": {
    "dsh-plugin-wwrs-ffmpeg": "link:/path/to/plugin-wwrs-ffmpeg"
  },
  "dsh": { "profile": { "bundles": ["dsh-plugin-wwrs-ffmpeg"] } }
}
```

## 验证

跑 `pnpm check`（prettier 检查 + `tsc --noEmit` + `node --test tests/*.test.ts`）。

## 无浏览器半

纯服务端工具——`pnpm check` 即全部门，无 `check:browser` 链。

## 已知边界

- 只收工作区相对路径——绝对路径或越界即大声失败。
- `overwrite: false` 且产物存在 → 成功返回 `{skipped:true}` 不执行，绝不静默覆盖。
- `extraArgs` 原样拼入 argv，可覆盖任意编码开关（风险自负）。
- 超时：探测 60s，转码系 30min；调用方取消（`exec.signal`）直达子进程。

## 许可

MIT.
