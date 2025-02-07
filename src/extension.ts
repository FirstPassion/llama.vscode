import * as vscode from 'vscode';
import { Architect } from './architect';

export function activate(context: vscode.ExtensionContext) {
    let architect = new Architect();
    // 初始化状态栏，并注册事件监听器
    architect.setStatusBar(context);
    // 注册配置变更事件监听器，以便在配置发生变化时更新状态栏
    architect.setOnChangeConfiguration(context);
    // 注册一个补全提供者，用于提供内联补全项
    architect.setCompletionProvider(context);
    // 注册一个命令，用于手动触发补全
    architect.registerCommandManualCompletion(context);
    // 注册一个命令，用于强制生成新的补全建议，而不是使用缓存
    architect.registerCommandNoCacheCompletion(context);
    // 注册一个命令，用于复制某些信息到剪贴板
    architect.registerCommandCopyChunks(context);
    // 注册一个事件监听器，以便在VSCode工作区中的文本文件保存时执行某些操作
    architect.setOnSaveFile(context);
    // 设置一个周期性任务，用于定期更新环形缓冲区
    architect.setPeriodicRingBufferUpdate(context);
    // 注册两个命令，用于拦截复制和剪切操作，并在执行后执行某些操作
    architect.setClipboardEvents(context);
    // 注册活动文件变更事件监听器，以便在活动文件发生变化时执行某些操作
    architect.setOnChangeActiveFile(context);
    // 注册一个命令，用于接受前一行建议
    architect.registerCommandAcceptFirstLine(context);
    // 注册一个命令，用于接受前一个单词的建议
    architect.registerCommandAcceptFirstWord(context);
}

export function deactivate() {
    // Nothing to do. VS Code will dispose all registerd disposables
}
