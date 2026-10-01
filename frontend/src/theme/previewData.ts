/** 给 `scripts/preview-themes.mjs` 用的入口：只转发内置皮肤表。
 *
 *  为什么不直接 import `skins.ts`：它只有类型与常量、本来就能直接 import——
 *  但 `theme.ts` 里带着 `document` / `localStorage` 的调用，node 里跑不起来，
 *  而 `registry.ts`（活的那份清单）在模块加载时就会去读 localStorage。
 *  这个文件把「预览需要的那一份」圈出来——**只有内置皮肤**，因为预览图是给
 *  「产品自带什么样子」看的，与这台机器上导入了什么无关。
 *  **它不参与产品构建**（没有产品代码 import 它）。 */
export { BUILTIN_MANIFESTS, BUILTIN_SKIN_IDS, BUILTIN_SKINS } from './skins'