/**
 * dsh-plugin-open-folder —— 客户端半（浏览器）。
 *
 * 目录在「设置 → 插件 → 某个插件的详情页」的页头控件区加一个「打开目录」按钮，
 * 点了就在系统文件管理器里打开该插件在磁盘上的真实目录。
 *
 * 席位：官方插件页声明的 `plugins.detail.actions`（list / scope root / owner `PluginDetailProps`），
 * 位置：页头控件区、在页面自己的开关与「卸载」之前（页面按 `order` 升序排）。
 *
 * 与宿主半的约定（本插件只调这两个路由，不依赖任何官方客户端 store）：
 *   POST /plugin-open-folder/open     body {"name":"<包名>"}          → 解析路径并打开
 *   GET  /plugin-open-folder/resolve?name=<包名>                       → 只解析不打开
 *   成功：200 {"ok":true,"path":"…","source":"link|file|node_modules|plugins","opened":true}
 *   失败：{"ok":false,"message":"…"}（400 包名不合法 / 404 找不到目录 / 405 方法不对）
 *
 * 只 require 允许的模块：react 与 @deepseek-ai/dsh-client-ui-primitives。
 * 手写 CJS bundle，无构建步骤：改完本文件刷新页面即可（no-cache，按请求读取）。
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-open-folder',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		let react = require('react');
		let primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		// ── 常量 ────────────────────────────────────────────────────────────────
		/** 目标席位：详情页页头控件区。 */
		const SLOT = 'plugins.detail.actions';
		/** 本条目在席位里的单元格 id（自己取一个，别复用官方已占用的 id）。 */
		const ENTRY_ID = 'dsh-plugin-open-folder';
		/** 排在官方条目之间的位置（升序，官方卸载按钮不在此列）。 */
		const ENTRY_ORDER = 30;
		/** locale 命名空间：注册字典、并在 slot 注册里声明 `locale: NS` 以拿到 `t`。 */
		const NS = 'pluginOpenFolder';
		/** 宿主半路由。 */
		const OPEN_ENDPOINT = '/plugin-open-folder/open';
		const RESOLVE_ENDPOINT = '/plugin-open-folder/resolve';
		/** 注入的 <style> 节点 id（选择器统一加 .pof- 前缀，不污染全局）。 */
		const STYLE_ELEMENT_ID = 'dsh-plugin-open-folder-style';

		/**
		 * 内置兜底文案：locale 服务缺席（或还没就绪）时按钮也必须有字，
		 * 不能因为一个可选服务没到位就渲染空白。
		 */
		const FALLBACK = {
			zh: {
				open: '打开目录',
				opening: '打开中…',
				openLabel: '在文件管理器中打开 {name} 的目录',
				copyPath: '点击复制路径：{path}',
				copied: '已复制',
				copyFailed: '复制失败，请手动选中路径',
				requestFailed: '请求失败：{message}',
			},
			en: {
				open: 'Open folder',
				opening: 'Opening…',
				openLabel: 'Open the folder of {name} in the file manager',
				copyPath: 'Click to copy the path: {path}',
				copied: 'Copied',
				copyFailed: 'Copy failed — select the path manually',
				requestFailed: 'Request failed: {message}',
			},
		};

		const STYLE_TEXT = `
.pof-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 460px;
}
.pof-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-text-tertiary, #8a8f98);
  cursor: pointer;
  user-select: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
  border-bottom: 1px dashed currentColor;
}
.pof-hint:hover { color: var(--dsw-alias-text-secondary, #b5b9c0); }
.pof-hint-error {
  color: var(--dsw-alias-error, #e5484d);
  cursor: default;
  border-bottom-color: transparent;
}
.pof-hint-copied { color: var(--dsw-alias-success, #30a46c); }
`;

		// ── 文案 ────────────────────────────────────────────────────────────────
		/** 把 `{name}` 之类的占位符替换掉；缺参就原样留下。 */
		function format(template, params) {
			if (typeof template !== 'string') return String(template ?? '');
			if (params === undefined || params === null) return template;
			return template.replace(/\{(\w+)\}/g, (match, key) =>
				params[key] === undefined || params[key] === null ? match : String(params[key]),
			);
		}

		/**
		 * 活动翻译函数。默认读内置中文兜底；locale 服务就绪后替换成
		 * `locale.bind(NS)` 的绑定版（跟随后续语言切换）。
		 */
		let translate = (key, params) => format(FALLBACK.zh[key] ?? key, params);

		/** 组件内部用：优先传入的框架 `t`，其次活动 translate，最后中文兜底。 */
		function tr(key, params) {
			try {
				const out = translate(key, params);
				if (typeof out === 'string' && out !== '') return out;
			} catch {}
			return format(FALLBACK.zh[key] ?? key, params);
		}

		function resolveT(props) {
			return typeof props?.t === 'function' ? props.t : tr;
		}

		// ── 宿主半 HTTP ─────────────────────────────────────────────────────────
		/** 读响应体；非 JSON 退化为 null。 */
		async function readJson(response) {
			try {
				return await response.json();
			} catch {
				return null;
			}
		}

		/**
		 * 调宿主半。
		 * @param action `'open'` 打开目录，`'resolve'` 只解析路径。
		 * @param name 包名。
		 * @returns `{ ok: true, path, source?, opened? }` 或 `{ ok: false, message }`。
		 */
		async function request(action, name) {
			const wantsResolve = action === 'resolve';
			const url = wantsResolve ? `${RESOLVE_ENDPOINT}?name=${encodeURIComponent(name)}` : OPEN_ENDPOINT;
			const init = wantsResolve
				? { method: 'GET', credentials: 'same-origin' }
				: {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ name }),
					};
			let response;
			try {
				response = await fetch(url, init);
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
			const data = await readJson(response);
			if (data !== null && typeof data === 'object') {
				if (data.ok === true) {
					return {
						ok: true,
						path: typeof data.path === 'string' ? data.path : '',
						source: typeof data.source === 'string' ? data.source : undefined,
						opened: data.opened === true,
					};
				}
				const message = typeof data.message === 'string' && data.message !== '' ? data.message : `HTTP ${response.status}`;
				return { ok: false, message };
			}
			return { ok: false, message: `HTTP ${response.status}` };
		}

		/** 复制文本：优先 Clipboard API，失败退回临时 textarea + execCommand。 */
		async function copyToClipboard(text) {
			if (typeof text !== 'string' || text === '') return false;
			try {
				if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch {}
			try {
				if (typeof document === 'undefined' || !document.body) return false;
				const area = document.createElement('textarea');
				area.value = text;
				area.setAttribute('readonly', '');
				area.style.position = 'fixed';
				area.style.opacity = '0';
				document.body.appendChild(area);
				if (typeof area.select === 'function') area.select();
				const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') === true : false;
				area.remove();
				return ok;
			} catch {
				return false;
			}
		}

		// ── 组件 ────────────────────────────────────────────────────────────────
		/**
		 * 页头控件：一个「打开目录」按钮 + 一行辅助小字（成功显示路径，可点击复制；
		 * 失败显示宿主半返回的 message）。`kind: 'item'` 的官方插件页没有本地目录，
		 * 直接返回 null。
		 *
		 * props：`{ subject, t, requestOpen, resolvePath, copyPath }`
		 *  —— `t` 来自注册里声明的 `locale: NS`；后三个来自注册的 `inject: () => face`。
		 */
		function OpenFolderAction(props) {
			const t = resolveT(props);
			const subject = props?.subject;
			// bundle / row 页面才有本地目录；官方插件页（item）只有 id。
			const name =
				subject !== undefined &&
				subject !== null &&
				(subject.kind === 'bundle' || subject.kind === 'row') &&
				subject.pkg !== undefined &&
				subject.pkg !== null &&
				typeof subject.pkg.name === 'string' &&
				subject.pkg.name !== ''
					? subject.pkg.name
					: undefined;

			const [phase, setPhase] = react.useState('idle'); // idle | busy | ok | error
			const [path, setPath] = react.useState('');
			const [message, setMessage] = react.useState('');
			const [copied, setCopied] = react.useState(false);
			const copiedTimer = react.useRef(null);

			// 卸载时清掉复制提示的定时器
			react.useEffect(
				() => () => {
					if (copiedTimer.current !== null) {
						clearTimeout(copiedTimer.current);
						copiedTimer.current = null;
					}
				},
				[],
			);

			const open = typeof props?.requestOpen === 'function' ? props.requestOpen : (pkgName) => request('open', pkgName);
			const copy = typeof props?.copyPath === 'function' ? props.copyPath : copyToClipboard;

			const onClick = react.useCallback(() => {
				if (name === undefined) return;
				setPhase('busy');
				setMessage('');
				setPath('');
				setCopied(false);
				void (async () => {
					const result = await open(name);
					if (result !== null && result.ok === true) {
						setPhase('ok');
						setPath(result.path ?? '');
						setMessage('');
						return;
					}
					setPhase('error');
					setPath('');
					setMessage(result !== null && typeof result.message === 'string' && result.message !== '' ? result.message : tr('requestFailed', { message: 'unknown' }));
				})();
			}, [name, open]);

			const onCopy = react.useCallback(() => {
				if (path === '') return;
				void (async () => {
					const ok = await copy(path);
					if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
					setCopied(ok === true);
					copiedTimer.current = setTimeout(() => {
						copiedTimer.current = null;
						setCopied(false);
					}, 1600);
				})();
			}, [path, copy]);

			// 官方插件页没有本地目录：不渲染任何控件
			if (name === undefined) return null;

			const busy = phase === 'busy';
			const label = t('openLabel', { name });

			const button = react.createElement(
				primitives.Button,
				{
					variant: 'outline',
					size: 'sm',
					icon: react.createElement(primitives.IconFolderOpenOutlineRegular, { size: 13 }),
					disabled: busy,
					'data-plugin-open-folder-action': 'open',
					'aria-label': label,
					title: label,
					onClick,
				},
				busy ? t('opening') : t('open'),
			);

			let hint = null;
			if (phase === 'ok' && path !== '') {
				hint = react.createElement(
					'span',
					{
						className: copied ? 'pof-hint pof-hint-copied' : 'pof-hint',
						role: 'button',
						tabIndex: 0,
						'data-plugin-open-folder-action': 'copy-path',
						title: t('copyPath', { path }),
						onClick: onCopy,
						onKeyDown: (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								onCopy();
							}
						},
					},
					copied ? t('copied') : path,
				);
			} else if (phase === 'error' && message !== '') {
				hint = react.createElement(
					'span',
					{
						className: 'pof-hint pof-hint-error',
						'data-plugin-open-folder-action': 'error',
						title: message,
					},
					message,
				);
			}

			return react.createElement('span', { className: 'pof-wrap', 'data-plugin-open-folder': name }, button, hint);
		}

		/** 注入给组件的业务面（注册的 `inject: () => face`）。 */
		const face = {
			/** 解析并打开该包的目录。 */
			requestOpen: (name) => request('open', name),
			/** 只解析路径，不打开（留给以后做「显示路径」预览用）。 */
			resolvePath: (name) => request('resolve', name),
			/** 复制路径到剪贴板。 */
			copyPath: (text) => copyToClipboard(text),
		};

		// ── 插件本体 ────────────────────────────────────────────────────────────
		/** 本插件需要 slots 服务；locale 是可选增强，用 ctx.inject 单独挂。 */
		const inject = ['slots'];

		function apply(ctx) {
			const warn = (msg) => {
				try {
					console.warn(`[dsh-plugin-open-folder] ${msg}`);
				} catch {}
			};

			// ① 字典：注册 NS 并让 translate 跟随活动语言。
			//    locale 缺席时保持内置中文兜底，按钮照常渲染。
			ctx.inject?.(['locale'], (localeCtx) => {
				try {
					const bound = localeCtx.locale.bind(NS);
					translate = (key, params) => {
						try {
							const out = bound(key);
							if (typeof out === 'string' && out !== '') return format(out, params);
						} catch {}
						return format(FALLBACK.zh[key] ?? key, params);
					};
					localeCtx.effect(() => localeCtx.locale.register(NS, { zh: FALLBACK.zh, en: FALLBACK.en }));
				} catch (error) {
					warn(`locale 注册失败（用内置兜底文案继续）：${error instanceof Error ? error.message : String(error)}`);
				}
			});

			// ② 样式：一个带前缀的 <style>，卸载时撤掉。
			let style = null;
			try {
				if (typeof document !== 'undefined' && (document.head ?? document.body) !== undefined) {
					document.getElementById?.(STYLE_ELEMENT_ID)?.remove?.();
					style = document.createElement('style');
					style.id = STYLE_ELEMENT_ID;
					style.textContent = STYLE_TEXT;
					(document.head ?? document.body).appendChild(style);
				}
			} catch (error) {
				warn(`样式注入失败（功能不受影响）：${error instanceof Error ? error.message : String(error)}`);
			}
			ctx.effect(() => () => {
				try {
					style?.remove?.();
				} catch {}
			});

			// ③ 席位：官方插件页声明 plugins.detail.actions 后，这里登记一个条目。
			//    slots.inject 的工厂返回注册 disposer，席位下线/本插件卸载时由框架收走。
			if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') {
				warn('slots 服务不可用，跳过详情页按钮注册');
				return;
			}
			const seatDisposer = ctx.slots.inject(SLOT, () =>
				ctx.slots.register(
					{
						name: SLOT,
						id: ENTRY_ID,
						order: ENTRY_ORDER,
						label: () => tr('open'),
						locale: NS,
						inject: () => face,
					},
					OpenFolderAction,
				),
			);
			ctx.effect(() => () => {
				try {
					if (typeof seatDisposer === 'function') seatDisposer();
				} catch {}
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
