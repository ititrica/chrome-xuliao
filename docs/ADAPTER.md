# 网页适配与设备输入（0.3.0）

任务编排在 `background.js`；单页流程在 `content/runner.js`；网页适配器 `content/adapter-chatgpt.js` 只读取 DOM；全部页面操作由 `lib/device-input.js` 通过 `chrome.debugger` 的原生 Input 命令执行。

## 只读适配器

| 方法 | 返回值 |
| --- | --- |
| `editor()` / `editorText()` | 可见输入框和当前文本 |
| `point(node)` | 可见且未被浮层遮挡的节点坐标；不滚动、不聚焦 |
| `sendButton()` / `stopButton()` / `retryButton()` / `bottomButton()` | 可用的相应按钮，或 null |
| `ready()` | 输入框已出现且页面可用 |
| `checkpoint()` | 当前用户和助手消息数量 |
| `sentUser(checkpoint, prompt)` | 检查点之后内容一致的用户气泡，忽略额外手动消息 |
| `sample(checkpoint, prompt)` | 本轮回复文本、图片、生成状态、完成标记和指纹 |
| `pageFault()` / `isBusy()` | 网页错误和生成状态 |

支持原有 `#prompt-textarea`、`data-message-author-role` 及新版 `data-composer-markdown`、`data-user-message-bubble`、`data-content-search-unit-key`、`data-talvt-turn-state`。中、英、日按钮名称作为补充；发送按钮限定在当前输入框所属表单，默认可兜底使用唯一的 submit 按钮，自定义选择器保持严格匹配。

纯图片回复可缺少 assistant 文本节点，此时通过 data-conversation-role 的助手区块读取 generated-image-gallery。混合文字和图片也限定在助手区块内，排除用户上传的图片；自定义助手选择器仍严格生效。

`sample` 将助手回复限制在匹配的用户消息与下一条用户消息之间。有最终状态时要求约 3.5 秒稳定内容；缺少完成标记时要求输入框可用、无真实流式生成信号、无启用的停止按钮，并稳定至少 10 秒。图片必须已加载，无图片不会被纯文字稳定判断提前跳过。文字和图片默认等待上限均为 1200 秒。

## 原生输入

内容脚本发送 `DEVICE_INPUT`，包含 `runId`、`taskId`、`turn`、`revision` 和白名单动作：`clear`、`type`、`send`、`enter`、`stop`、`retry`、`bottom`。没有任意脚本或任意 CDP 命令接口。

后台核对消息的发送标签页、当前批次、轮次、恢复版本、任务和批次状态，以及实际目标域名。发送动作还要求 dispatching 检查点，清空和打字要求 preparing 状态。设备事件在独立队列中执行，因此暂停/停止命令不必等待整条提示词输入完毕；每次事件前重新检查授权状态。

每次输入前激活目标页和窗口，新页面使用 active:true 打开。首次连接使用 `Emulation.setFocusEmulationEnabled` 支持后台标签页。输入事务在整个扩展内串行，避免多个标签页的原生焦点操作交错，模型回复的等待仍并发。鼠标使用移动、按下和释放；清空使用目标点击、平台全选与 Backspace；文本使用单字符事件，补充平面 Unicode 使用浏览器 IME 输入，换行使用 Shift+Enter。正文不通过 DOM 赋值、合成 JavaScript 事件或 execCommand 写入。

另一张新会话仍处于 opening 时，设备队列抛出 XULIAO_PAGE_LOADING，当前页稍后再输入，不消耗恢复次数。如发送尚未点击，会凭 dispatchId 撤销检查点再等待，避免把这次正常推迟当作不明发送。

完成、跳过、暂停和停止会释放调试连接。用户主动取消调试时暂停批次，尊重该操作。失效的输入消息不会在恢复后继续发送。

## 持久化流程与恢复

```text
ready → preparing → dispatching → waiting → ready / done
  ↑          自动核对、清空、重试             |
  └─────────────────────────────────────────┘
重试耗尽 → skipped → 调度下一组
```

- `PAGE_READY` 在新页面输入框稳定两秒后确认就绪，调度器再打开下一个并发页。
- `CLAIM` 进入 preparing，原生清空现有草稿并输入当前提示词。
- `COMMIT` 在发送前持久化检查点，进入 dispatching。
- `SENT` 确认匹配用户气泡，进入 waiting。
- `COMPLETE` 记录当前轮并递增一次，重置本轮重试次数。整组结束时保存 closePending、释放调试连接、关闭任务页，再补位；关闭失败由 watchdog 重试，成功前不打开替代页。历史 URL 和逐轮记录保留。
- `RECOVER` 递增恢复版本及重试计数，保存错误和重试时间。普通输入/发送故障保存 recoveryCheckpoint 后重新准备；回复故障可保留等待检查点。
- `ADOPT_SENT` 在重试前找到了原消息时恢复原检查点，继续等待，避免再次点击。
- 每轮最多三次重试，间隔 2、5、10 秒；第二次输入恢复可刷新网页。耗尽后跳过该组并补位，不等待人工确认。

恢复会递增 revision，旧脚本、旧输入请求和迟到消息被拒绝。批次 ID、标签页绑定和轮次同样用于隔离旧任务。运行期提示词为独立快照，编辑聊天库不影响当前批次。浏览器整体重启会暂停批次；普通 worker 激活保留运行状态。

网页不能提供服务器级事务保证，极端延迟时激进自动重发仍有重复风险。自有网页最好提供稳定消息 ID 和完成状态，并继续保留 DOM 观察作为界面验证。

## 自有网页接入

新增域名需同步修改 Manifest 的 host permissions/content script matches、调度器的新会话 URL、watchdog 和设备输入域名检查，不能只改设置中的选择器。建议使用稳定的输入框、发送、停止、用户、助手和完成标记，并让新标签页进入独立空白会话。

推荐沿用：`#prompt-textarea`、`data-testid="send-button"`、`data-testid="stop-button"`、`data-message-author-role="user/assistant"`，以及仅在最终回复完成时出现的 `data-testid="copy-turn-action-button"`。图片放在对应回复容器中，并用已加载的 img 表示结果。
