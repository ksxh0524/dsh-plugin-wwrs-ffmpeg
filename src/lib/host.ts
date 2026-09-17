/** host.ts —— 宿主上下文最小结构类型（W1：工具注册 + 执行窄面）。
 *
 * 只声明本包实际触达的面（tools 注册 + logger + execute 的 signal/cwd），不复述宿主全量类型；
 * 服务端零依赖铁律：此处不得 import 任何宿主协议包（含类型 import，一律结构化手写）。
 */

export type ToolRecord = {
  name: string;
  [key: string]: unknown;
};

export type GuardFn = (execution: { name: string; arguments: unknown }) => string | undefined;

export type HostContext = {
  tools?: {
    register: (tool: ToolRecord) => unknown;
    guard?: (fn: GuardFn) => () => void;
  };
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
};

/** 工具 execute 的 exec 窄面（结构化声明，不 import 宿主协议包；cwd 供工作区锚探测）。 */
export type ToolExecLike = {
  signal?: AbortSignal;
  agent?: {
    session?: { meta?: { cwd?: string }; header?: { cwd?: string } };
    options?: { provider?: string; model?: string };
  };
  onProgress?: (update: { content: Array<{ type: string; text: string }> }) => void;
};
