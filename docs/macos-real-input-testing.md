# macOS 真实输入测试方法

本文记录 HorseMD 在需要核验真实键盘、输入规则、焦点与源码保真时所使用的 macOS 原生输入方法。它用于补充项目现有的后台 Electron/CDP 回归：测试会在前台真实启动的 HorseMD 中发出底层键盘和鼠标事件；结果可通过源码画面截图、保存后的磁盘文件，或按需读取系统剪贴板交叉核验。

## 适用场景

- 富文本输入规则：标题、列表、嵌套列表、代码、公式等。
- 富文本与源码模式切换后的内容、结构和光标检查。
- 需要确认事件时序、窗口焦点或编辑器原生行为的疑难问题。
- 需要模拟逐字符输入而非一次性文本写入的场景。

## 基本原理

测试程序使用 `CGEvent` 和 `.cghidEventTap` 向 macOS 发布原始键盘、鼠标事件。每个字符都单独发送一次 key-down 和 key-up，中间保留短暂停顿，使 Electron、Milkdown、ProseMirror 和 React 按正常交互节奏处理事件。

运行前可确认当前进程具备事件发布能力：

```swift
import ApplicationServices

print(CGPreflightPostEventAccess())
```

输出 `true` 表示当前终端可发布事件。

## 基础工具代码

将以下内容保存为 `/tmp/horsemd-real-input.swift`：

```swift
import Cocoa
import ApplicationServices

let source = CGEventSource(stateID: .hidSystemState)!

func pause(_ seconds: Double) {
  Thread.sleep(forTimeInterval: seconds)
}

func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
  let down = CGEvent(
    keyboardEventSource: source,
    virtualKey: code,
    keyDown: true
  )!
  down.flags = flags
  down.post(tap: .cghidEventTap)

  pause(0.10)

  let up = CGEvent(
    keyboardEventSource: source,
    virtualKey: code,
    keyDown: false
  )!
  up.flags = flags
  up.post(tap: .cghidEventTap)

  pause(0.20)
}

func click(_ x: CGFloat, _ y: CGFloat) {
  let point = CGPoint(x: x, y: y)

  CGEvent(
    mouseEventSource: source,
    mouseType: .leftMouseDown,
    mouseCursorPosition: point,
    mouseButton: .left
  )?.post(tap: .cghidEventTap)

  pause(0.12)

  CGEvent(
    mouseEventSource: source,
    mouseType: .leftMouseUp,
    mouseCursorPosition: point,
    mouseButton: .left
  )?.post(tap: .cghidEventTap)

  pause(0.8)
}
```

常用虚拟键码：

```swift
// 字母：a=0, b=11, c=8, d=2, e=14, f=3, g=5, h=4
// i=34, j=38, k=40, l=37, m=46, n=45, o=31, p=35
// q=12, r=15, s=1, t=17, u=32, v=9, w=13, x=7, y=16, z=6
// 数字：1=18, 2=19, 3=20
// 标点：.=47, /=44, 空格=49
// 控制键：Enter=36, Tab=48
```

常用组合键：

```swift
key(45, flags: .maskCommand) // Cmd+N，新建文档
key(44, flags: .maskCommand) // Cmd+/，切换富文本/源码
key(0, flags: .maskCommand)  // Cmd+A，全选
key(8, flags: .maskCommand)  // Cmd+C，复制
key(20, flags: .maskShift)   // Shift+3，输入 #
```

## 列表与源码切换示例

下面的步骤对应一个未保存的新文档：标题、正文、两级有序列表，然后切换源码查看。

```swift
NSWorkspace.shared.launchApplication("HorseMD")
pause(2)

key(45, flags: .maskCommand)
pause(2)
click(600, 150) // 坐标按实际窗口位置调整

key(20, flags: .maskShift) // #
key(49)                    // 空格
text("test title")
key(36)                    // Enter
text("body")
key(36)
key(36)

key(18) // 1
key(47) // .
key(49) // 空格，触发有序列表
text("first")
key(36)
text("second")
key(36)
key(48) // Tab，嵌套
text("nested")

pause(2)
key(44, flags: .maskCommand) // 切源码
pause(2)
```

`text` 可以将字符映射为虚拟键码后逐个调用 `key`：

```swift
func text(_ value: String) {
  let map: [Character: CGKeyCode] = [
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14,
    "f": 3, "i": 34, "l": 37, "n": 45, "o": 31,
    "r": 15, "s": 1, "t": 17, "y": 16, " ": 49
  ]

  for character in value {
    key(map[character]!)
  }
}
```

编译、运行并查看结果：

```bash
swiftc /tmp/horsemd-real-input.swift -o /tmp/horsemd-real-input
/tmp/horsemd-real-input
```

需要将源码保存为文本证据时，可在源码模式执行 `Cmd+A`、`Cmd+C` 后用 `pbpaste` 读取；也可以直接使用 `screencapture -x result.png` 保存源码画面，或保存文件后读取磁盘内容。

上述场景的预期源码：

```md
# test title

body

1. first
2. second
   1. nested
```

## 输入法与运行方式

- 英文字母键码测试适合使用 ABC 键盘布局，便于精确控制每个键。
- 中文写作问题需要在中文输入法下额外测试真实的拼音输入、候选选择与上屏过程；这与英文原始键码路径是两类输入链路。
- 测试程序以同步前台方式执行时，窗口激活和键盘焦点最稳定。运行结束后可通过截图、磁盘文件和按需使用的 `pbpaste` 交叉核验。

## 验收记录建议

每条真实输入用例建议保留：

1. 测试输入步骤与按键节奏；
2. 富文本截图；
3. 切源码后的截图；
4. 可选的 `pbpaste` 源码快照；
5. 保存、关闭、重开后的磁盘内容；
6. 是否覆盖中文输入法、右键操作、快速连续输入等具体条件。
