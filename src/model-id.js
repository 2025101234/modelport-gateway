/**
 * 模型 id 与工具名的通用规整。
 *
 * 这些原本住在 `src/upstream.js` 里，和免费车道的请求指纹混在一起。免费车道
 * （以及它依赖的上游指纹）已经移除，只剩下这两件与车道无关的小事，所以单独成文。
 *
 * @module src/model-id.js
 */

/**
 * A model id with any trailing parenthesised label stripped.
 *
 * Callers spell a model as `"deepseek-v4.1-flash-free (Fast)"` when they echo a
 * display name; the wire wants the bare id. The label is presentation only, so
 * it is removed rather than rejected.
 */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

/**
 * The longest tool name the wire accepts.
 *
 * Tool names are caller-defined; this is the cap every encoder in this project
 * applies when it writes one out, so the truncation is at least consistent
 * between the Chat, Responses and Messages wires.
 */
export const MAX_TOOL_NAME_LEN = 128