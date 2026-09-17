/** errors.ts —— fail-loud 错误载荷（输入校验唯一出口）。
 *
 * 失败一次改对：所有输入校验错误抛 FailLoudError，四字段齐全
 * {error, param, expected, example}——调用方照 example 改 param 即过，不用来回试。
 * 执行期失败（ffmpeg 非零退出/超时/取消）抛普通 Error，消息带上下文 + stderr 截断；
 * 输入面问题（不可解码、无时长语义、非法区间）同样走 FailLoudError（param 点名）。
 */

export type FailLoudFields = {
  /** 发生了什么（含收到值与上下文，一行讲清）。 */
  error: string;
  /** 出问题的参数名。 */
  param: string;
  /** 期望的形状/约束。 */
  expected: string;
  /** 能直接照抄的改对例子。 */
  example: string;
};

export class FailLoudError extends Error {
  readonly param: string;
  readonly expected: string;
  readonly example: string;

  constructor(fields: FailLoudFields) {
    super(`${fields.error}（param=${fields.param}；expected=${fields.expected}；example=${fields.example}）`);
    this.name = "FailLoudError";
    this.param = fields.param;
    this.expected = fields.expected;
    this.example = fields.example;
  }

  toFields(): FailLoudFields {
    return { error: this.message, param: this.param, expected: this.expected, example: this.example };
  }
}
