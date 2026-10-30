/**
 * 子路径导出的薄壳：`cordis.patch.yml` 里三个子插件行的 `name` 都指向这里
 * （`yintxplugins/open-folder`、`yintxplugins/preset-bridge`、`yintxplugins/link-install`）。
 *
 * 官方插件列表把 `name` 里的子路径显示成独立一行，所以每个子插件在设置里能单独开关；
 * 真正的装载逻辑全在 `../shell.js`（一份代码服务三行，与 `@linxin666/dsh-web-all`
 * 用 `lib/shells/shell.js` 服务多行的做法一致）。
 */
export { name, inject, apply, loadImpl, pluginShapeOf, implConfigOf } from '../shell.js'
