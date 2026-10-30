/** 故意在 apply 里抛错：用来验证外壳把「启动失败」记成降级而不是整组回滚。 */
export const name = 'yintx-test-boom'

export function apply() {
  throw new Error('故意抛错：yintxplugins 自测用的坏子插件')
}
