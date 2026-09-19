# dsh-plugin-wwrs-ffmpeg

[中文](./README.zh.md)

Local media processing DSH plugin (open source): probe, transcode, concat, slice, mux voice, and burn subtitles via local `ffmpeg`/`ffprobe`. Sole runtime dependency is @deepseek-ai/dsh-tools (defineTool DSL). W1 done: mount layer (`src/cordis.ts`), write guard, and all seven tools are live with real ffmpeg/ffprobe execution.

## Tools

All paths are workspace-relative (absolute or escaping paths fail loud). Every writing tool takes `overwrite?: boolean` (default false; false + existing output → success `{skipped:true}` without running, never silently overwritten).

| Tool                   | Params                                                                                    | Semantics                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media_probe`          | `path`                                                                                    | Duration ms + width/height via ffprobe; still images → `durationMs: null`, no error                                                                 |
| `media_transcode`      | `src`, `out`, `videoCodec?`, `audioCodec?`, `crf?`, `preset?`, `extraArgs?`, `overwrite?` | Re-encode (libx264+aac faststart by default); `extraArgs: string[]` spliced verbatim into argv (caller beware: it can override any encoding switch) |
| `media_concat`         | `clips[]` (≥1), `out`, `options?{reencode?=true, fps?, audioBitrate?}`, `overwrite?`      | Concat with filter-complex normalize re-encode by default (`reencode: false` = demuxer copy); a single clip normalizes via transcode                |
| `media_slice`          | `src`, `out`, `startMs`, `endMs` (`endMs>startMs>=0`), `overwrite?`                       | Slice `[startMs,endMs)`, re-encoded                                                                                                                 |
| `media_mux_voice`      | `video`, `voiceAudio`, `out`, `attenuationDb?`, `overwrite?`                              | Voice padded/trimmed to video duration; default replaces the original track, a given value mixes it attenuated                                      |
| `media_burn_subtitles` | `video`, `srt` (`.srt`), `output`, `options?{forceStyle?, encoding?}`, `overwrite?`       | Burn subtitles (video re-encoded, audio copied)                                                                                                     |
| `media_extract_audio`  | `src`, `out`, `overwrite?`                                                                | First audio stream to aac 128k, no video; a sourceless input fails loud                                                                             |

Timeouts: probe 60s, transcode-family 30min; caller cancellation (`exec.signal`) is forwarded to the child process.

## Contract

No Remote calls — execution is local `ffmpeg`/`ffprobe` child processes; binaries resolve via the injection surface in Config (`ffmpegBin`/`ffprobeBin` config keys or env, then package `.bin`, then `PATH`). Missing binaries fail loud with guidance; never silently degrade.

## Config

| Key          | Meaning                                                   | Default                                                 |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------- |
| `workspace`  | Project root (absolute path)                              | `WWRS_WORKSPACE` env, then neutral-anchor probe         |
| `ffmpegBin`  | ffmpeg executable (injection surface: config key or env)  | `WWRS_FFMPEG_BIN` env, then package `.bin`, then `PATH` |
| `ffprobeBin` | ffprobe executable (injection surface: config key or env) | Same levels as above                                    |

Workspace resolution: `config.workspace` > env `WWRS_WORKSPACE` > upward probe for `.wwrs/workspace.json` > fail loud. Missing values fail loud with guidance; never silently degrade.

## Install

```json
{
  "dependencies": {
    "dsh-plugin-wwrs-ffmpeg": "link:/path/to/plugin-wwrs-ffmpeg"
  },
  "dsh": { "profile": { "bundles": ["dsh-plugin-wwrs-ffmpeg"] } }
}
```

## Verify

Run `pnpm check` (`prettier --check` + `tsc --noEmit` + `node --test tests/*.test.ts`).

## No browser half

Server-side tools only — `pnpm check` is the full gate, no `check:browser` chain.

## Known limits

- Workspace-relative paths only — absolute or escaping paths fail loud.
- `overwrite: false` + existing output → success `{skipped:true}` without running; never silently overwritten.
- `extraArgs` is spliced verbatim into argv and can override any encoding switch (caller beware).
- Timeouts: probe 60s, transcode-family 30min; `exec.signal` cancellation is forwarded to the child process.

## License

MIT.
