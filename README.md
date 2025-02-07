# llama.vscode

VS Code 的本地 LLM 辅助文本完成扩展

![image](https://github.com/user-attachments/assets/857acc41-0b6c-4899-8f92-3020208a21eb)

---

![llama vscode-swift0](https://github.com/user-attachments/assets/b19499d9-f50d-49d4-9dff-ff3e8ba23757)

## 特征

- 输入时自动提示
- 按 `Tab` 键接受建议
- 按 `Shift + Tab` 键接受建议的第一行
- 按 `Ctrl/Cmd + Right` 键接受下一个单词
- 按 `Ctrl + L` 键手动切换建议
- 控制最大文本生成时间
- 配置光标周围上下文的范围
- 用打开和编辑的文件以及剪切的文本片段环绕上下文
- [通过智能上下文复用支持在低端硬件上处理非常大的上下文](https://github.com/ggerganov/llama.cpp/pull/9787)
- 显示性能统计信息

## 安装

### VS Code扩展设置

从VS Code扩展市场安装[llama-vscode](https://marketplace.visualstudio.com/items?itemName=ggml-org.llama-vscode)扩展：

![图片](https://github.com/user-attachments/assets/a5998b49-49-c5-4623-b3a8-7100-b72af27e)

注：也可在[Open VSX](https://open-vsx.org/extension/ggml-org/llama-vscode)获得

### ' llama.cpp ' setup

该插件需要一个[llama.cpp](https://github.com/ggerganov/llama.cpp)服务器实例在配置的端点上运行:
<img width="508" alt="image" src="https://github.com/user-attachments/assets/1cc40392-a92c-46df-8a4d-aa762c692ad7" />

#### Mac OS

```bash
brew install llama.cpp
```

#### 其他操作系统

使用[最新的二进制文件](https://github.com/ggerganov/llama.cpp/releases)或[从源代码构建llama.cpp](https://github.com/ggerganov/llama.cpp/blob/master/docs/build.md)。更多关于如何运行`llama.cpp`服务器的信息，请参考[Wiki](https://github.com/ggml-org/llama.vscode/wiki)。

llama.cpp设置

以下是建议的设置，具体取决于您拥有的VRAM数量：

-大于16GB VRAM：

  ```bash
  llama-server \
      -hf ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF \
      --port 8012 -ngl 99 -fa -ub 1024 -b 1024 \
      --ctx-size 0 --cache-reuse 256
  ```

-小于16GB VRAM：

  ```bash
  llama-server \
      -hf ggml-org/Qwen2.5-Coder-3B-Q8_0-GGUF \
      --port 8012 -ngl 99 -fa -ub 1024 -b 1024 \
      --ctx-size 0 --cache-reuse 256
  ```

-小于8GB VRAM：

  ```bash
  llama-server \
      -hf ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF \
      --port 8012 -ngl 99 -fa -ub 1024 -b 1024 \
      --ctx-size 0 --cache-reuse 256
  ```

<details>
  <summary>只使用cpu</summary>

这些都是只支持cpu的硬件的`llama-server`设置。请注意，质量将明显降低：

```bash
llama-server \
    -hf ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF \
    --port 8012 -ub 512 -b 512 --ctx-size 0 --cache-reuse 256
```

```bash
llama-server \
    -hf ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF \
    --port 8012 -ub 1024 -b 1024 --ctx-size 0 --cache-reuse 256
```
</details>

您可以使用系统可以处理的任何其他fim兼容模型。默认情况下，使用`-hf`标志下载的模型存储在：

- Mac OS: `~/Library/Caches/llama.cpp/`
- Linux: `~/.cache/llama.cpp`
- Windows: `LOCALAPPDATA`

### 推荐llm

该插件需要fim兼容的模型：[HF集合](https://huggingface.co/collections/ggml-org/llamavim-6720fece33898ac10544ecf9)

## 例子

在M2 Studio上本地运行的投机公司：

https://github.com/user-attachments/assets/cab99b93-4712-40b4-9c8d-cf86e98d4482

## 实现细节

该扩展旨在非常简单和轻量级，同时提供高质量和高性能的本地FIM完成，甚至在消费级硬件上。

-最初的实现是由Ivaylo Gardev [@igardev](https://github.com/igardev)使用[llama.vim](https://github.com/ggml-org/llama.vim)插件作为参考完成的
—技术说明：https://github.com/ggerganov/llama.cpp/pull/9787

## 其他ide

— Vim/Neovim: https://github.com/ggml-org/llama.vim
