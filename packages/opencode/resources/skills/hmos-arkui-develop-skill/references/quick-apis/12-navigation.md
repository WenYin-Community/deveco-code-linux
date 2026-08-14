## 12. 导航与路由


> **组件索引**：`Navigation`、`NavPathStack 操作`、`NavDestination`、`Router`

### Navigation

**构造：** `Navigation()`

**属性方法：**

| 方法 | 签名 | 默认值 | 说明 |
|------|------|--------|------|
| .navDestination | `.navDestination(builder: (name: string, param: unknown) => void)` | — | 路由目标映射 |
| .title | `.title(value: ResourceStr \| CustomBuilder \| NavigationCommonTitle \| NavigationCustomTitle, options?: NavigationTitleOptions)` | — | 标题 |
| .subTitle | `.subTitle(value: string)` | — | 副标题（API 8，已废弃，用 .title 替代） |
| .mode | `.mode(NavigationMode)` | Auto | Stack/Split/Auto |
| .hideNavBar | `.hideNavBar(value: boolean)` | false | 隐藏导航栏（含标题栏+内容+工具栏） |
| .hideTitleBar | `.hideTitleBar(value: boolean)` | false | 隐藏标题栏 |
| .hideToolBar | `.hideToolBar(value: boolean)` | false | 隐藏工具栏 |
| .toolBar | `.toolBar(value: object \| CustomBuilder)` | — | 工具栏（旧接口） |
| .toolbarConfiguration | `.toolbarConfiguration(value: Array\<ToolbarItem\> \| CustomBuilder, options?)` | — | 工具栏（API 10+） |
| .navBarWidth | `.navBarWidth(value: Length)` | 240vp | 导航栏宽度（仅 Split 模式） |
| .navBarPosition | `.navBarPosition(value: NavBarPosition)` | Start | 导航栏位置 |

### NavPathStack 操作

| 方法 | 签名 | 说明 |
|------|------|------|
| pushPath | `pushPath(info: NavPathInfo, animated?: boolean)` | 压入页面 |
| pushPathByName | `pushPathByName(name: string, param: unknown, animated?: boolean)` | 按名称压入 |
| pop | `pop(animated?: boolean): NavPathInfo \| undefined` | 弹出，返回 NavPathInfo |
| pop | `pop(result: Object, animated?: boolean): NavPathInfo \| undefined` | 弹出并回传结果 |
| replacePath | `replacePath(info: NavPathInfo, animated?: boolean)` | 替换 |
| clear | `clear(animated?: boolean)` | 清空 |
| size | `size(): number` | 栈大小（方法，非属性） |
| getParent | `getParent(): NavPathStack \| null` | 获取父栈，无父返回 null |

### NavDestination

**构造：** `NavDestination()`

**属性方法：**

| 方法 | 签名 | 默认值 | 说明 |
|------|------|--------|------|
| .title | `.title(value: string \| CustomBuilder \| NavDestinationCommonTitle \| NavDestinationCustomTitle \| Resource, options?)` | — | 标题 |
| .hideTitleBar | `.hideTitleBar(boolean)` | false | 隐藏标题栏 |
| .hideBackButton | `.hideBackButton(boolean)` | false | 隐藏返回键 |
| .backgroundColor | `.backgroundColor(ResourceColor)` | — | 背景色 |

**事件：** `.onShown()` `.onHidden()` `.onBackPressed()`

### Router

| 方法 | 签名 | 说明 |
|------|------|------|
| pushUrl | `router.pushUrl({url, params?})` | 压入页面 |
| replaceUrl | `router.replaceUrl({url, params?})` | 替换当前页 |
| back | `router.back(url?)` | 返回 |
| clear | `router.clear()` | 清空栈 |
| getLength | `router.getLength(): number` | 栈大小 |
| getState | `router.getState(): RouterState` | 当前状态 |

---
