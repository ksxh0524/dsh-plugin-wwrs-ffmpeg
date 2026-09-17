# dsh-plugin-wwrs-ffmpeg

Local media processing DSH plugin (open source): probe, transcode, concat, slice, mux voice, and burn subtitles via local `ffmpeg`/`ffprobe`. Zero runtime dependencies.

## Status

W0 shell: mount layer (`src/cordis.ts`), guard shell, and standard gates are green. Tool implementations land in W1.

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

`media_probe` / `media_transcode` / `media_concat` / `media_slice` / `media_mux_voice` / `media_burn_subtitles`.

## License

MIT.
