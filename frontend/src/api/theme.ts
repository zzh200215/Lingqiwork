import { request } from './request'
import type { ThemeConfig } from '../theme'

/** 主题的**后端副本**。
 *
 *  真值在 localStorage（首屏要同步读到，不能等一次网络往返）；这里存一份是为了
 *  「浏览器数据被清掉 / 换一个浏览器打开」时外观还在——工作台是这个人的东西，
 *  换台机器打开不该变成出厂配色。
 *
 *  存的是后端 `data/config.json` 的 `theme` 键，与其余偏好同一份文件、同一套
 *  「人可读可改」的约定，但**独立成一个端点**：主题是前端自己的形状，
 *  混进 `PrefsIn` 那张大表单里只会让两边互相牵制。 */
export const themeApi = {
  getTheme: () => request<{ theme: ThemeConfig | null }>('/api/settings/theme'),
  putTheme: (theme: ThemeConfig) =>
    request<{ theme: ThemeConfig }>('/api/settings/theme', {
      method: 'PUT',
      body: JSON.stringify({ theme }),
    }),
}
