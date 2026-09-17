# dsh-plugin-wwrs-ffmpeg

本地媒体处理 DSH 插件（开源）：经本地 `ffmpeg`/`ffprobe` 做探测、转码、拼接、切片、配音混流与烧字幕。零运行时依赖。

## 状态

W0 空壳：挂载层（`src/cordis.ts`）、守卫壳与标准门已绿。工具实现在 W1 落地。

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

`media_probe` / `media_transcode` / `media_concat` / `media_slice` / `media_mux_voice` / `media_burn_subtitles`。

## 许可

MIT.
