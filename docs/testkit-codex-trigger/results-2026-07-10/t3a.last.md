前端框架里的 **event dispatch**，可以理解为：**某个事件发生后，系统把这个事件按照规则送到对应的监听者/处理函数那里执行**。

核心概念是三件事：

1. **事件产生**
   例如用户点击按钮、输入文本、滚动页面，或者代码主动触发一个自定义事件。

2. **事件对象被创建**
   事件通常会带一些信息，比如：
   - 事件类型：`click`、`input`、`submit`
   - 触发源：哪个 DOM 元素或组件
   - 附加数据：鼠标位置、输入内容、自定义 payload

3. **事件被分发给监听者**
   框架或浏览器会找到注册过的处理函数，然后调用它们。

例如原生 DOM：

```js
button.addEventListener("click", (event) => {
  console.log("button clicked");
});
```

当按钮被点击时，浏览器会把这个 `click` 事件 dispatch 给对应的监听函数。

事件分发通常还涉及 **传播路径**：

```text
外层元素 capture 阶段
  -> 目标元素 target 阶段
  -> 外层元素 bubble 阶段
```

也就是常说的：

- **capture**：从外到内捕获
- **target**：到达真正触发事件的元素
- **bubble**：从内到外冒泡

在框架里，这个概念会被封装得更高级：

React 里：

```jsx
<button onClick={handleClick}>Click</button>
```

你写的是 `onClick`，但背后 React 会接管底层 DOM 事件，把事件分发给对应组件的 handler。

Vue/Svelte 里，组件之间也可能 dispatch 自定义事件：

```js
dispatch("save", { id: 1 });
```

意思是：当前组件发出一个 `save` 事件，让父组件或外部监听者处理。

还有一种容易混淆的用法是状态管理里的 `dispatch`，比如 Redux：

```js
dispatch({ type: "ADD_TODO", payload: "read" });
```

这里的 dispatch 不是 DOM 事件，而是把一个 **action** 发送给状态管理系统，由 reducer 处理状态变化。

所以一句话总结：

**event dispatch 就是“事件发生后，把事件对象按照框架/浏览器定义的规则送到合适的处理函数”的过程。**  
它解决的是：谁触发了事件、事件带什么数据、谁应该响应、响应顺序是什么。