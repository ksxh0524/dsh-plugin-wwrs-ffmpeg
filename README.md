# dsh-plugin-wwrs-ffmpeg

Local media processing DSH plugin (open source): probe, transcode, concat, slice, mux voice, and burn subtitles via local `ffmpeg`/`ffprobe`. Zero runtime dependencies.

## Status

W1 done: mount layer (`src/cordis.ts`), write guard, and all seven tools are live with real ffmpeg/ffprobe execution.

## Install

```json
{
  "dependencies": {
    "dsh-plugin-wwrs-ffmpeg": "link:/path/to/plugin-wwrs-ffmpeg"
  },
  "dsh": { "profile": { "bundles": ["dsh-plugin-wwrs-ffmpeg"] } }
}
```

## Config

| Key          | Meaning                            | Default                                                 |
| ------------ | ---------------------------------- | ------------------------------------------------------- |
| `workspace`  | Project root (absolute path)       | `WWRS_WORKSPACE` env, then neutral-anchor probe         |
| `ffmpegBin`  | ffmpeg executable (absolute path)  | `WWRS_FFMPEG_BIN` env, then package `.bin`, then `PATH` |
| `ffprobeBin` | ffprobe executable (absolute path) | Same levels as above                                    |

Missing binaries fail loud with three ways out; never silently degrade.

## Tools (W1)

`media_probe` / `media_transcode` / `media_concat` / `media_slice` / `media_mux_voice` / `media_burn_subtitles` / `media_extract_audio`.

All paths are workspace-relative (absolute or escaping paths fail loud). Every writing tool takes `overwrite?: boolean` (default false; false + existing output → success `{skipped:true}` without running, never silently overwritten). `media_transcode` accepts `extraArgs: string[]`, spliced verbatim into argv (caller beware: it can override any encoding switch). Timeouts: probe 60s, transcode-family 30min; caller cancellation (`exec.signal`) is forwarded to the child process.

## License

MIT.
