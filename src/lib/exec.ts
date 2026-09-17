/** exec.ts —— 子进程执行面（包内单源；一律 execFile，禁 shell）。
 *
 * 铁律：argv 数组直传 execFile，永不拼 shell 字符串；exec.signal 逐调用钻到底层，
 * 超时分档由调用方定（probe 60s / 转码拼接 30min），本文件只做忠实透传与失败收口。
 * 失败一律 fail-loud：非零退出带上下文 + stderr 截断；超时点名预算；取消点名 signal。
 */

import { execFile } from "node:child_process";

export type ExecResult = { stdout: string; stderr: string };

export type RunBinOptions = {
  /** 超时预算毫秒（正数；probe 档 60s，转码拼接档 30min）。 */
  timeoutMs: number;
  /** 调用方取消信号（工具 execute 的 exec.signal 下钻）。 */
  signal?: AbortSignal;
  /** 失败文案的上下文前缀（如“transcode”，点名哪一步炸了）。 */
  context: string;
};

/** 可注入的执行函数形（测试注入假执行，覆盖参数组装与短路语义，不碰真二进制）。 */
export type ExecFn = (bin: string, args: readonly string[], opts: RunBinOptions) => Promise<ExecResult>;

type ExecFileError = Error & { code?: unknown; killed?: boolean; stdout?: unknown; stderr?: unknown };

/** execFile 直调（无 shell）：超时/取消/非零退出全部转成带上下文的 Error。 */
export async function runBin(bin: string, args: readonly string[], opts: RunBinOptions): Promise<ExecResult> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error(`${opts.context} 内部错误：timeoutMs 须为正数，收到 ${String(opts.timeoutMs)}`);
  }
  return new Promise<ExecResult>((resolve, reject) => {
    execFile(bin, [...args], { timeout: opts.timeoutMs, signal: opts.signal }, (err: ExecFileError | null, stdout: string, stderr: string) => {
      if (!err) {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        return;
      }
      const out = String(stdout ?? "");
      const serr = String(stderr ?? err.stderr ?? "");
      if (opts.signal?.aborted) {
        reject(new Error(`${opts.context} 已取消（exec.signal aborted）${serr ? `：\n${serr.slice(0, 500)}` : ""}`));
        return;
      }
      if (err.killed) {
        reject(
          new Error(
            `${opts.context} timed out after ${Math.round(opts.timeoutMs / 1000)}s（预算 ${opts.timeoutMs}ms 可调）${serr ? `\n${serr.slice(0, 300)}` : ""}`,
          ),
        );
        return;
      }
      reject(new Error(`${opts.context} 失败（exit=${String(err.code ?? "?")}）：\n${serr.slice(0, 500)}${out ? `\nstdout:\n${out.slice(0, 200)}` : ""}`));
    });
  });
}
