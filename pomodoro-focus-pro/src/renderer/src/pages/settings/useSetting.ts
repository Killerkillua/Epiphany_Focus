import type { LocalForm, UpdateFn } from './types'

/**
 * 通用单设置项 hook：绑定表单快照中的某个字段。
 * 返回 [当前值, 写入函数]，写入即调用 update（保存 → 提示 → 自动刷新快照），
 * 消除各分组 "onChange → update({key: v}, tip)" 的重复样板。
 * tip 可为字符串或依据新值计算的函数（如“已开启/已关闭”类提示）。
 */
export function useSetting<T>(
  form: LocalForm,
  update: UpdateFn,
  key: keyof LocalForm,
  dottedKey: string,
  tip?: string | ((value: T) => string | undefined)
): [T, (value: T) => void] {
  const value = form[key] as unknown as T
  const setValue = (v: T): void => {
    const t = typeof tip === 'function' ? tip(v) : tip
    void update({ [dottedKey]: v }, t)
  }
  return [value, setValue]
}
