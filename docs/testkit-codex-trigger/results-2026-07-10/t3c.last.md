在前端框架里，**event dispatch** 可以理解为：

> 当某个事件发生时，框架把这个事件“派发”给应该响应它的处理函数的过程。

它关注的不是“事件是什么”，而是“事件从哪里来、传给谁、按什么顺序传、处理后会触发什么更新”。

**一个典型流程**

比如用户点击按钮：

```text
用户点击
  ↓
浏览器产生 click 事件
  ↓
框架接收到事件
  ↓
框架找到对应的监听函数 onClick / @click / v-on:click
  ↓
执行你的 handler
  ↓
handler 修改状态
  ↓
框架调度组件更新 / 重新渲染
```

这里从“事件产生”到“调用对应 handler”的过程，就是 event dispatch。

**和 DOM 事件的关系**

浏览器原生 DOM 本身就有事件派发机制：

```js
element.dispatchEvent(new Event("click"))
```

DOM 事件会经历：

```text
capture 捕获阶段
target 目标阶段
bubble 冒泡阶段
```

前端框架通常会在这个基础上做一层自己的事件系统。

例如：

- React 有 Synthetic Event，把原生事件包装成统一的事件对象，并通过框架内部机制分发。
- Vue 里组件可以 `$emit` / `emit` 一个自定义事件，父组件监听它。
- Svelte 里也有 `dispatch` 概念，用来从组件向外发送事件。
- 一些应用还会有 event bus，本质也是把事件派发给订阅者。

**dispatch 和 emit 的区别**

日常语境里它们经常混用，但严格说：

- `emit` 更强调“发出一个事件”
- `dispatch` 更强调“把事件分发给对应监听者”

例如：

```text
组件 emit 一个 save 事件
框架 dispatch 这个事件给监听 save 的父组件
```

**它解决的问题**

event dispatch 的核心价值是解耦：

```text
事件来源不需要知道谁会处理它
处理者只需要声明自己关心什么事件
框架负责中间的转发、顺序、传播和更新调度
```

所以在前端框架里，event dispatch 本质上是一个**事件路由机制**：把用户操作、组件消息或自定义事件，按照框架规则送到对应的处理逻辑。