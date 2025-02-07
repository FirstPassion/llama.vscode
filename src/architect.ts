// TODO 列表:
// - 如果有 linesuffix,只保留建议的第一行(减少响应长度)
// - 缓存下一个请求时,如果需要可以从前缀中删除前几行
// - 性能分析 - 检查每个操作花费的时间,以便优化(例如并行运行状态栏信息...,减少缓存搜索...)
// - 在250个元素和49个符号的情况下缓存搜索需要1/5毫秒 => 可以使用更大的缓存,可以搜索到行首
// - ShowInfo < 1/10 毫秒
// - 选择单行或单词时不要闪烁(部分恢复与上一个请求的匹配检查?)
// - (低优先级)Microsoft IntelliSense窗口 - 不显示或其他更优雅的处理方式

import * as vscode from 'vscode';
import { LRUCache } from './lru-cache';
import { ExtraContext } from './extra-context';
import { Configuration } from './configuration';
import { LlamaResponse, LlamaServer } from './llama-server';

// 定义建议详情的接口
interface SuggestionDetails {
    suggestion: string;      // 建议的内容
    position: vscode.Position;  // 建议的位置
    inputPrefix: string;     // 输入前缀
    inputSuffix: string;     // 输入后缀
    prompt: string;          // 提示文本
}

export class Architect {
    // 类的主要属性
    private extConfig: Configuration;          // 扩展配置
    private extraContext: ExtraContext;        // 额外上下文
    private llamaServer: LlamaServer;          // Llama服务器
    private lruResultCache: LRUCache;          // LRU缓存
    private eventlogs: string[] = [];          // 事件日志数组
    private fileSaveTimeout: NodeJS.Timeout | undefined;  // 文件保存超时
    private lastCompletion: SuggestionDetails = {        // 最后一次完成的建议
        suggestion: "", 
        position: new vscode.Position(0, 0), 
        inputPrefix: "", 
        inputSuffix: "", 
        prompt: ""
    };
    private myStatusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);  // 状态栏项
    private isRequestInProgress = false;       // 是否有请求正在进行
    private isForcedNewRequest = false;        // 是否强制新请求

    // 构造函数 - 初始化主要组件
    constructor() {
        const config = vscode.workspace.getConfiguration("llama-vscode");
        this.extConfig = new Configuration(config);
        this.llamaServer = new LlamaServer(this.extConfig);
        this.extraContext = new ExtraContext(this.extConfig, this.llamaServer);
        this.lruResultCache = new LRUCache(this.extConfig.max_cache_keys);
    }

    // 设置状态栏
    setStatusBar = (context: vscode.ExtensionContext) => {
        this.initializeStatusBar();           // 初始化状态栏
        this.registerEventListeners(context); // 注册事件监听器

        // 注册显示菜单的命令
        context.subscriptions.push(
            vscode.commands.registerCommand('llama-vscode.showMenu', async () => {
                // 获取当前语言和配置
                const currentLanguage = vscode.window.activeTextEditor?.document.languageId;
                const config = vscode.workspace.getConfiguration('llama-vscode');
                const languageSettings = config.get<Record<string, boolean>>('languageSettings') || {};
                const isLanguageEnabled = currentLanguage ? this.isCompletionEnabled(undefined, currentLanguage) : true;

                // 创建菜单项并显示
                const items = this.createMenuItems(currentLanguage, isLanguageEnabled);
                const selected = await vscode.window.showQuickPick(items, { title: "Llama Menu" });

                if (selected) {
                    await this.handleMenuSelection(selected, currentLanguage, languageSettings);
                }
            })
        );
    }

    // 监听配置变化
    setOnChangeConfiguration = (context: vscode.ExtensionContext) => {
        let configurationChangeDisp = vscode.workspace.onDidChangeConfiguration((event) => {
            const config = vscode.workspace.getConfiguration("llama-vscode");
            this.extConfig.updateOnEvent(event, config);
            vscode.window.showInformationMessage(`llama-vscode extension is updated.`);
            this.lruResultCache = new LRUCache(this.extConfig.max_cache_keys);
        });
        context.subscriptions.push(configurationChangeDisp);
    }

    // 监听活动文件变化
    setOnChangeActiveFile = (context: vscode.ExtensionContext) => {
        let changeActiveTextEditorDisp = vscode.window.onDidChangeActiveTextEditor((editor) => {
            // 处理前一个编辑器
            const previousEditor = vscode.window.activeTextEditor;
            if (previousEditor) {
                setTimeout(async () => {
                    // 为前一个编辑器的光标位置选择上下文块
                    this.extraContext.pickChunkAroundCursor(previousEditor.selection.active.line, previousEditor.document);
                }, 0);
            }
            
            // 处理新的活动编辑器
            if (editor) {
                let activeDocument = editor.document;
                const selection = editor.selection;
                const cursorPosition = selection.active;
                setTimeout(async () => {
                    // 为新编辑器的光标位置选择上下文块
                    this.extraContext.pickChunkAroundCursor(cursorPosition.line, activeDocument);
                }, 0);
            }
        });
        context.subscriptions.push(changeActiveTextEditorDisp);
    }

    // 注册接受第一行命令
    registerCommandAcceptFirstLine = (context: vscode.ExtensionContext) => {
        const acceptFirstLineCommand = vscode.commands.registerCommand(
            'extension.acceptFirstLine',
            async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    return;
                }

                // 获取最后一个内联补全项
                const lastItem = this.lastCompletion.suggestion;
                if (!lastItem) {
                    return;
                }
                let lastSuggestioLines = lastItem.split('\n');
                let insertLine = lastSuggestioLines[0] || '';

                // 如果第一行为空且有第二行,则插入第二行
                if (insertLine.trim() == "" && lastSuggestioLines.length > 1) {
                    insertLine = '\n' + lastSuggestioLines[1];
                }

                // 在光标位置插入文本
                const position = editor.selection.active;
                await editor.edit(editBuilder => {
                    editBuilder.insert(position, insertLine);
                });
            }
        );
        context.subscriptions.push(acceptFirstLineCommand);
    }

    // 注册接受第一个单词命令
    registerCommandAcceptFirstWord = (context: vscode.ExtensionContext) => {
        const acceptFirstWordCommand = vscode.commands.registerCommand(
            'extension.acceptFirstWord',
            async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    return;
                }

                // 获取最后一个建议
                const lastSuggestion = this.lastCompletion.suggestion;
                if (!lastSuggestion) {
                    return;
                }
                // 按行分割建议内容
                let lastSuggestioLines = lastSuggestion.split(/\r?\n/);
                let firstLine = lastSuggestioLines[0];
                let prefix = this.getLeadingSpaces(firstLine);
                // 获取第一行的第一个单词(包含前导空格)
                let firstWord = prefix + firstLine.trimStart().split(' ')[0] || '';
                let insertText = firstWord;

                // 如果第一行为空且有第二行,则使用第二行的第一个单词
                if (firstWord === "" && lastSuggestioLines.length > 1) {
                    let secondLine = lastSuggestioLines[1];
                    prefix = this.getLeadingSpaces(secondLine);
                    firstWord = prefix + secondLine.trimStart().split(' ')[0] || '';
                    insertText = '\n' + firstWord;
                }

                // 在光标位置插入文本
                const position = editor.selection.active;
                await editor.edit(editBuilder => {
                    editBuilder.insert(position, insertText);
                });
            }
        );
        context.subscriptions.push(acceptFirstWordCommand);
    }

    // 获取字符串开头的空白字符
    getLeadingSpaces = (input: string): string => {
        // 使用正则表达式匹配开头的空格
        const match = input.match(/^[ \t]*/);
        return match ? match[0] : "";
    }

    // 设置定期更新环形缓冲区
    setPeriodicRingBufferUpdate = (context: vscode.ExtensionContext) => {
        // 设置定时器定期更新环形缓冲区
        const ringBufferIntervalId = setInterval(this.extraContext.periodicRingBufferUpdate, this.extConfig.ring_update_ms);
        const rungBufferUpdateDisposable = {
            dispose: () => {
                clearInterval(ringBufferIntervalId);
                console.log('Periodic Task Extension has been deactivated. Interval cleared.');
            }
        };
        context.subscriptions.push(rungBufferUpdateDisposable);
    }

    // 设置文件保存监听器
    setOnSaveFile = (context: vscode.ExtensionContext) => {
        const onSaveDocDisposable = vscode.workspace.onDidSaveTextDocument(this.handleDocumentSave);
        context.subscriptions.push(onSaveDocDisposable);
    }

    // 注册手动触发补全命令
    registerCommandManualCompletion = (context: vscode.ExtensionContext) => {
        const triggerManualCompletionDisposable = vscode.commands.registerCommand('extension.triggerInlineCompletion', async () => {
            // 手动触发补全的快捷键
            if (!vscode.window.activeTextEditor) {
                vscode.window.showErrorMessage('No active editor!');
                return;
            }
            vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        });
        context.subscriptions.push(triggerManualCompletionDisposable);
    }

    // 注册不使用缓存的补全命令
    registerCommandNoCacheCompletion = (context: vscode.ExtensionContext) => {
        const triggerNoCacheCompletionDisposable = vscode.commands.registerCommand('extension.triggerNoCacheCompletion', async () => {
            if (!vscode.window.activeTextEditor) {
                vscode.window.showErrorMessage('No active editor!');
                return;
            }
            this.isForcedNewRequest = true;  // 强制发起新请求而不使用缓存
            vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        });
        context.subscriptions.push(triggerNoCacheCompletionDisposable);
    }

    // 注册复制代码块命令
    registerCommandCopyChunks = (context: vscode.ExtensionContext) => {
        const triggerCopyChunksDisposable = vscode.commands.registerCommand('extension.copyChunks', async () => {
            if (!vscode.window.activeTextEditor) {
                vscode.window.showErrorMessage('No active editor!');
                return;
            }
            // 合并事件日志
            let eventLogsCombined = ""
            if (this.eventlogs.length > 0){
                eventLogsCombined = this.eventlogs.reverse().reduce((accumulator, currentValue) => 
                    accumulator + currentValue + "\n" , "");
            }
            // 合并额外上下文信息
            let extraContext = ""
            if (this.extraContext.chunks.length > 0){
                extraContext = this.extraContext.chunks.reduce((accumulator, currentValue) => 
                    accumulator + "Time: " + currentValue.time + "\nFile Name: " + currentValue.filename + 
                    "\nText:\n" +  currentValue.text + "\n\n" , "");
            }
            // 合并补全缓存信息
            let completionCache = ""
            if (this.lruResultCache.size() > 0){
                completionCache = Array.from(this.lruResultCache.getMap().entries()).reduce(
                    (accumulator, [key, value]) => 
                    accumulator + "Key: " + key + "\nCompletion:\n" +  value + "\n\n" , "");
            }
            // 将所有信息复制到剪贴板
            vscode.env.clipboard.writeText(
                "Events:\n" + eventLogsCombined + 
                "\n\n------------------------------\n" + 
                "Extra context: \n" + extraContext + 
                "\n\n------------------------------\nCompletion cache: \n" + 
                completionCache
            )
        });
        context.subscriptions.push(triggerCopyChunksDisposable);
    }

    // 设置补全提供器
    setCompletionProvider = (context: vscode.ExtensionContext) => {
        const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },  // 匹配所有文件
            {
                provideInlineCompletionItems: async (document, position, context, token) => {
                    // 检查是否启用了补全功能
                    if (!this.isCompletionEnabled(document)) {
                        return undefined;
                    }
                    return await this.getCompletionItems(document, position, context, token);
                }
            }
        );
        context.subscriptions.push(providerDisposable);
    }

    // 设置剪贴板事件监听
    setClipboardEvents = (context: vscode.ExtensionContext) => {
        // 注册复制命令拦截器
        const copyCmd = vscode.commands.registerCommand('extension.copyIntercept', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                // 如果没有活动编辑器,执行默认复制操作
                await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
                return;
            }
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            let selectedLines = selectedText.split(/\r?\n/);
            // 异步运行以不影响复制操作
            setTimeout(async () => {
                this.extraContext.pickChunk(selectedLines, false, true, editor.document);
            }, 1000);

            // 执行默认复制命令
            await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
            this.addEventLog("", "COPY_INTERCEPT", selectedLines[0])
        });
        context.subscriptions.push(copyCmd);

        // 注册剪切命令拦截器
        const cutCmd = vscode.commands.registerCommand('extension.cutIntercept', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                // 如果没有活动编辑器,执行默认剪切操作
                await vscode.commands.executeCommand('editor.action.clipboardCutAction');
                return;
            }
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            let selectedLines = selectedText.split(/\r?\n/);
            // 异步运行以不影响剪切操作
            setTimeout(async () => {
                this.extraContext.pickChunk(selectedLines, false, true, editor.document);
            }, 1000);

            // 执行默认剪切命令
            await vscode.commands.executeCommand('editor.action.clipboardCutAction');
            this.addEventLog("", "CUT_INTERCEPT", selectedLines[0])
        });
        context.subscriptions.push(cutCmd);
    }

    // 处理文档保存事件
    handleDocumentSave = (document: vscode.TextDocument) => {
        // 清除之前的超时
        if (this.fileSaveTimeout) {
            clearTimeout(this.fileSaveTimeout);
        }

        // 设置新的超时处理
        this.fileSaveTimeout = setTimeout(() => {
            let chunkLines: string[] = []
            const editor = vscode.window.activeTextEditor;
            // 如果有活动编辑器且正在编辑保存的文档
            if (editor && editor.document === document) {
                const cursorPosition = editor.selection.active;
                const line = cursorPosition.line;
                this.extraContext.pickChunkAroundCursor(line, document)
            } else {
                // 否则获取整个文档的内容
                chunkLines = document.getText().split(/\r?\n/);
                this.extraContext.pickChunk(chunkLines, true, true, document);
            }
        }, 1000); // 延迟1秒执行
        this.addEventLog("", "SAVE", "")
    }

    // 延迟执行的工具函数
    delay = (ms: number) => {
        return new Promise<void>(resolve => setTimeout(resolve, ms));
    }

    // 添加事件日志
    addEventLog = (group: string, event: string, details: string) => {
        // 添加新的日志条目
        this.eventlogs.push(Date.now() + ", " + group + ", " + event + ", " + details.replace(",", " "));
        // 如果超出最大日志数量,删除最旧的日志
        if (this.eventlogs.length > this.extConfig.MAX_EVENTS_IN_LOG) {
            this.eventlogs.shift();
        }
    }

    // 获取补全项
    getCompletionItems = async (
        document: vscode.TextDocument, 
        position: vscode.Position, 
        context: vscode.InlineCompletionContext, 
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[] | null> => {
        let group = "GET_COMPLETION_" + Date.now();
        // 如果是自动触发但设置为手动模式,则返回null
        if (!this.extConfig.auto && context.triggerKind == vscode.InlineCompletionTriggerKind.Automatic) {
            this.addEventLog(group, "MANUAL_MODE_AUTOMATIC_TRIGGERING_RETURN", "")
            return null;
        }

        // 等待前一个请求完成
        while (this.isRequestInProgress) {
            await this.delay(this.extConfig.DELAY_BEFORE_COMPL_REQUEST);
            if (token.isCancellationRequested) {
                this.addEventLog(group, "CANCELLATION_TOKEN_RETURN", "waiting")
                return null;
            }
        }
        this.isRequestInProgress = true // 标记请求开始
        this.extraContext.lastComplStartTime = Date.now();

        // 收集本地上下文
        const prefixLines = this.getPrefixLines(document, position, this.extConfig.n_prefix);
        const suffixLines = this.getSuffixLines(document, position, this.extConfig.n_suffix);
        const lineText = document.lineAt(position.line).text
        const cursorIndex = position.character;
        const linePrefix = lineText.slice(0, cursorIndex);
        const lineSuffix = lineText.slice(cursorIndex);
        const nindent = lineText.length - lineText.trimStart().length

        // 如果是自动触发且后缀太长,则返回null
        if (context.triggerKind == vscode.InlineCompletionTriggerKind.Automatic && 
            lineSuffix.length > this.extConfig.max_line_suffix) {
            this.isRequestInProgress = false
            this.addEventLog(group, "TOO_LONG_SUFFIX_RETURN", "")
            return null
        }

        const prompt = linePrefix;
        const inputPrefix = prefixLines.join('\n') + '\n';
        const inputSuffix = lineSuffix + '\n' + suffixLines.join('\n') + '\n';

        // 尝试获取补全建议
        try {
            let data: LlamaResponse | undefined
            // 生成缓存键
            let hashKey = this.lruResultCache.getHash(inputPrefix + "|" + inputSuffix + "|" + prompt)
            // 尝试从缓存获取补全
            let completion = this.getCachedCompletion(hashKey, inputPrefix, inputSuffix, prompt)
            // 判断是否使用缓存的响应
            let isCachedResponse = !this.isForcedNewRequest && completion != undefined
            if (!isCachedResponse) {
                this.isForcedNewRequest = false
                // 如果请求被取消则返回
                if (token.isCancellationRequested){
                    this.isRequestInProgress = false
                    this.addEventLog(group, "CANCELLATION_TOKEN_RETURN", "just before server request")
                    return null;
                }
                this.showThinkingInfo();

                // 从服务器获取补全
                data = await this.llamaServer.getLlamaCompletion(
                    inputPrefix, 
                    inputSuffix, 
                    prompt, 
                    this.extraContext.chunks, 
                    nindent
                )
                if (data != undefined) completion = data.content;
                else completion = undefined
            }

            // 如果没有获取到补全建议,返回空数组
            if (completion == undefined || completion.trim() == ""){
                this.showInfo(undefined);
                this.isRequestInProgress = false
                this.addEventLog(group, "NO_SUGGESTION_RETURN", "")
                return [];
            }

            // 处理建议内容
            let suggestionLines = completion.split(/\r?\n/)
            this.removeTrailingNewLines(suggestionLines);

            // 检查是否应该丢弃建议
            if (this.shouldDiscardSuggestion(suggestionLines, document, position, linePrefix, lineSuffix)) {
                this.showInfo(undefined);
                this.isRequestInProgress = false
                this.addEventLog(group, "DISCARD_SUGGESTION_RETURN", "")
                return [];
            }

            // 更新建议内容
            completion = this.updateSuggestion(suggestionLines, lineSuffix);

            // 如果不是缓存响应则缓存结果
            if (!isCachedResponse) this.lruResultCache.put(hashKey, completion)
            // 保存最后一次补全的详细信息
            this.lastCompletion = this.getCompletionDetails(completion, position, inputPrefix, inputSuffix, prompt);

            // 异步执行不影响建议显示的操作
            setTimeout(async () => {
                // 显示信息
                if (isCachedResponse) this.showCachedInfo()
                else this.showInfo(data);
                
                // 如果请求未取消且行后缀为空,则缓存未来可能的建议
                if (!token.isCancellationRequested && lineSuffix.trim() === ""){
                    await this.cacheFutureSuggestion(inputPrefix, inputSuffix, prompt, suggestionLines);
                    await this.cacheFutureAcceptLineSuggestion(inputPrefix, inputSuffix, prompt, suggestionLines);
                }
                // 如果请求未取消,添加上下文块
                if (!token.isCancellationRequested){
                    this.extraContext.addFimContextChunks(position, context, document);
                }
            }, 0);

            this.isRequestInProgress = false
            this.addEventLog(group, "NORMAL_RETURN", suggestionLines[0])
            return [this.getSuggestion(completion, position)];
        } catch (err) {
            // 错误处理
            console.error("Error fetching llama completion:", err);
            vscode.window.showInformationMessage(`Error getting response. Please check if llama.cpp server is running. `);
            let errorMessage = "Error fetching completion"
            if (err instanceof Error) {
                vscode.window.showInformationMessage(err.message);
                errorMessage = err.message
            }
            this.isRequestInProgress = false
            this.addEventLog(group, "ERROR_RETURN", errorMessage)
            return [];
        }
    }


    private initializeStatusBar() {
        this.myStatusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            1000
        );
        this.myStatusBarItem.command = 'llama-vscode.showMenu';
        this.myStatusBarItem.tooltip = "Llama Settings";
        this.updateStatusBarText();
        this.myStatusBarItem.show();
    }

    private registerEventListeners(context: vscode.ExtensionContext) {
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('llama-vscode')) {
                    this.updateStatusBarText();
                }
            }),
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.updateStatusBarText();
            })
        );
    }

    private createMenuItems(currentLanguage: string | undefined, isLanguageEnabled: boolean): vscode.QuickPickItem[] {
        return [
            {
                label: `${this.extConfig.enabled ? 'Disable' : 'Enable'} All Completions`,
                description: `Turn ${this.extConfig.enabled ? 'off' : 'on'} completions globally`
            },
            currentLanguage ? {
                label: `${isLanguageEnabled ? 'Disable' : 'Enable'} Completions for ${currentLanguage}`,
                description: `Currently ${isLanguageEnabled ? 'enabled' : 'disabled'}`
            } : null,
            {
                label: "$(gear) Edit Settings...",
            },
            {
                label: "$(book) View Documentation...",
            }
        ].filter(Boolean) as vscode.QuickPickItem[];
    }

    private async handleMenuSelection(selected: vscode.QuickPickItem, currentLanguage: string | undefined, languageSettings: Record<string, boolean>) {
        switch (selected.label) {
            case "$(gear) Edit Settings...":
                await vscode.commands.executeCommand('workbench.action.openSettings', 'llama-vscode');
                break;
            case "$(book) View Documentation...":
                await vscode.env.openExternal(vscode.Uri.parse('https://github.com/ggml-org/llama.vscode'));
                break;
            default:
                await this.handleCompletionToggle(selected.label, currentLanguage, languageSettings);
                break;
        }
        this.updateStatusBarText();
    }

    private async handleCompletionToggle(label: string, currentLanguage: string | undefined, languageSettings: Record<string, boolean>) {
        const config = vscode.workspace.getConfiguration('llama-vscode');
        if (label.includes('All Completions')) {
            await config.update('enabled', !this.extConfig.enabled, true);
        } else if (currentLanguage && label.includes(currentLanguage)) {
            const isLanguageEnabled = languageSettings[currentLanguage] ?? true;
            languageSettings[currentLanguage] = !isLanguageEnabled;
            await config.update('languageSettings', languageSettings, true);
        }
    }

    private updateStatusBarText() {
        const editor = vscode.window.activeTextEditor;
        const currentLanguage = editor?.document.languageId;
        const isEnabled = this.extConfig.enabled;
        const isLanguageEnabled = currentLanguage ? this.isCompletionEnabled(editor.document) : true;

        if (!isEnabled) {
            this.myStatusBarItem.text = "$(x) llama.vscode";
        } else if (currentLanguage && !isLanguageEnabled) {
            this.myStatusBarItem.text = `$(x) llama.vscode (${currentLanguage})`;
        } else {
            this.myStatusBarItem.text = "$(check) llama.vscode";
        }
    }

    private isCompletionEnabled(document?: vscode.TextDocument, language?: string): boolean {
        if (!this.extConfig.enabled) return false;

        const languageToCheck = language ?? document?.languageId;
        if (languageToCheck) {
            const config = vscode.workspace.getConfiguration('llama-vscode');
            const languageSettings = config.get<Record<string, boolean>>('languageSettings') || {};
            return languageSettings[languageToCheck] ?? true;
        }

        return true;
    }

    // 缓存未来可能的建议
    cacheFutureSuggestion = async (inputPrefix: string, inputSuffix: string, prompt: string, suggestionLines: string[]) => {
        let futureInputPrefix = inputPrefix;
        let futureInputSuffix = inputSuffix;
        // 构建未来的提示(当前提示 + 第一行建议)
        let futurePrompt = prompt + suggestionLines[0];

        // 如果建议有多行
        if (suggestionLines.length > 1) {
            // 更新未来的输入前缀(当前前缀 + 当前提示 + 除最后一行外的所有建议行)
            futureInputPrefix = inputPrefix + prompt + suggestionLines.slice(0, -1).join('\n') + '\n';
            // 最后一行作为未来的提示
            futurePrompt = suggestionLines[suggestionLines.length - 1];
            // 如果前缀行数超过限制,则只保留后面的行
            let futureInputPrefixLines = futureInputPrefix.slice(0,-1).split(/\r?\n/);
            if (futureInputPrefixLines.length > this.extConfig.n_prefix){
                futureInputPrefix = futureInputPrefixLines.slice(
                    futureInputPrefixLines.length - this.extConfig.n_prefix
                ).join('\n') + '\n';
            }
        }

        // 生成缓存键并检查是否已缓存
        let futureHashKey = this.lruResultCache.getHash(
            futureInputPrefix + "|" + futureInputSuffix + "|" + futurePrompt
        );
        let cached_completion = this.lruResultCache.get(futureHashKey);
        if (cached_completion != undefined) return;

        // 获取未来的补全建议
        let futureData = await this.llamaServer.getLlamaCompletion(
            futureInputPrefix, 
            futureInputSuffix, 
            futurePrompt, 
            this.extraContext.chunks, 
            prompt.length - prompt.trimStart().length
        );

        // 处理并缓存补全结果
        let futureSuggestion = "";
        if (futureData != undefined && futureData.content != undefined && futureData.content.trim() != "") {
            futureSuggestion = futureData.content;
            let suggestionLines = futureSuggestion.split(/\r?\n/);
            this.removeTrailingNewLines(suggestionLines);
            futureSuggestion = suggestionLines.join('\n');
            let futureHashKey = this.lruResultCache.getHash(
                futureInputPrefix + "|" + futureInputSuffix + "|" + futurePrompt
            );
            this.lruResultCache.put(futureHashKey, futureSuggestion);
        }
    }

    // 缓存接受行建议时的未来建议
    cacheFutureAcceptLineSuggestion = async (inputPrefix: string, inputSuffix: string, prompt: string, suggestionLines: string[]) => {
        // 对于单行建议不需要缓存
        if (suggestionLines.length > 1) {
            let futureInputSuffix = inputSuffix;
            // 构建未来的输入前缀(当前前缀 + 当前提示 + 第一行建议 + 换行)
            let futureInputPrefix = inputPrefix + prompt + suggestionLines[0] + '\n';
            // 未来的提示为空,因为我们要缓存剩余的所有行
            let futurePrompt = "";
            // 生成缓存键
            let futureHashKey = this.lruResultCache.getHash(
                futureInputPrefix + "|" + futureInputSuffix + "|" + futurePrompt
            )
            // 将剩余行作为未来建议
            let futureSuggestion = suggestionLines.slice(1).join('\n')
            // 检查是否已缓存
            let cached_completion = this.lruResultCache.get(futureHashKey)
            // 如果未缓存则添加到缓存
            if (cached_completion != undefined) return;
            else this.lruResultCache.put(futureHashKey, futureSuggestion);
        }
    }

    // 获取指定位置前的行
    getPrefixLines = (document: vscode.TextDocument, position: vscode.Position, nPrefix: number): string[] => {
        const startLine = Math.max(0, position.line - nPrefix);
        return Array.from({ length: position.line - startLine }, (_, i) => document.lineAt(startLine + i).text);
    }

    // 获取指定位置后的行
    getSuffixLines = (document: vscode.TextDocument, position: vscode.Position, nSuffix: number): string[] => {
        const endLine = Math.min(document.lineCount - 1, position.line + nSuffix);
        return Array.from({ length: endLine - position.line }, (_, i) => document.lineAt(position.line + 1 + i).text);
    }

    // 显示状态栏信息
    showInfo = (data: LlamaResponse | undefined) => {
        if (data == undefined || data.content == undefined || data.content.trim() == "" ) {
            // 无建议时显示的信息
            if (this.extConfig.show_info) {
                this.myStatusBarItem.text = `llama-vscode | ${this.extConfig.getUiText("no suggestion")} | r: ${this.extraContext.chunks.length} / ${this.extConfig.ring_n_chunks}, e: ${this.extraContext.ringNEvict}, q: ${this.extraContext.queuedChunks.length} / ${this.extConfig.MAX_QUEUED_CHUNKS} | t: ${Date.now() - this.extraContext.lastComplStartTime} ms `;
            } else {
                this.myStatusBarItem.text = `llama-vscode | ${this.extConfig.getUiText("no suggestion")} | t: ${Date.now() - this.extraContext.lastComplStartTime} ms `;
            }
        } else {
            // 有建议时显示的详细信息
            if (this.extConfig.show_info) {
                this.myStatusBarItem.text = `llama-vscode | c: ${data.tokens_cached} / ${data.generation_settings.n_ctx ?? 0}, r: ${this.extraContext.chunks.length} / ${this.extConfig.ring_n_chunks}, e: ${this.extraContext.ringNEvict}, q: ${this.extraContext.queuedChunks.length} / ${this.extConfig.MAX_QUEUED_CHUNKS} | p: ${data.timings?.prompt_n} (${data.timings?.prompt_ms?.toFixed(2)} ms, ${data.timings?.prompt_per_second?.toFixed(2)} t/s) | g: ${data.timings?.predicted_n} (${data.timings?.predicted_ms?.toFixed(2)} ms, ${data.timings?.predicted_per_second?.toFixed(2)} t/s) | t: ${Date.now() - this.extraContext.lastComplStartTime} ms `;
            } else {
                this.myStatusBarItem.text = `llama-vscode | t: ${Date.now() - this.extraContext.lastComplStartTime} ms `;
            }
        }
        this.myStatusBarItem.show();
    }

    // 显示缓存信息
    showCachedInfo = () => {
        if (this.extConfig.show_info) {
            this.myStatusBarItem.text = `llama-vscode | C: ${this.lruResultCache.size()} / ${this.extConfig.max_cache_keys} | t: ${Date.now() - this.extraContext.lastComplStartTime} ms`;
        }else {
            this.myStatusBarItem.text = `llama-vscode | t: ${Date.now() - this.extraContext.lastComplStartTime} ms`;
        }
        this.myStatusBarItem.show();
    }

    // 显示时间信息
    showTimeInfo = (startTime: number) => {
        this.myStatusBarItem.text = `llama-vscode | t: ${Date.now() - startTime} ms`;
        this.myStatusBarItem.show();
    }

    // 显示思考中的提示
    showThinkingInfo = () => {
        this.myStatusBarItem.text = `llama-vscode | ${this.extConfig.getUiText("thinking...")}`;
        this.myStatusBarItem.show();
    }

    // 获取补全建议
    getSuggestion = (completion: string, position: vscode.Position) => {
        return new vscode.InlineCompletionItem(
            completion,
            new vscode.Range(position, position)
        );
    }

    // 判断是否应该丢弃建议
    shouldDiscardSuggestion = (suggestionLines: string[], document: vscode.TextDocument, position: vscode.Position, linePrefix: string, lineSuffix: string) => {
        let discardSuggestion = false;
        // 如果建议为空则丢弃
        if (suggestionLines.length == 0) return true;
        // 如果只有一行且为空则丢弃
        if (suggestionLines.length == 1 && suggestionLines[0].trim() == "") return true;

        // 如果光标在最后一行则不丢弃
        if (position.line == document.lineCount - 1) return false;

        // 如果第一行为空或与后缀相同,且后续行重复,则丢弃
        if (suggestionLines.length > 1
            && (suggestionLines[0].trim() == "" || suggestionLines[0].trim() == lineSuffix.trim())
            && suggestionLines.slice(1).every((value, index) => value === document.lineAt((position.line + 1) + index).text))
            return true;

        // 如果只有一行且与后缀相同则丢弃
        if (suggestionLines.length == 1 && suggestionLines[0] == lineSuffix) return true;

        // 查找第一个非空行
        let firstNonEmptyDocLine = position.line + 1;
        while (firstNonEmptyDocLine < document.lineCount && document.lineAt(firstNonEmptyDocLine).text.trim() === "")
            firstNonEmptyDocLine++;

        // 如果到文件末尾都是空行则不丢弃
        if (firstNonEmptyDocLine >= document.lineCount) return false;

        // 检查建议是否重复已有内容
        if (linePrefix + suggestionLines[0] === document.lineAt(firstNonEmptyDocLine).text) {
            // 如果只有一行则丢弃
            if (suggestionLines.length == 1) return true;

            // 如果第二行是下一行的前缀则丢弃
            if (suggestionLines.length === 2
                && suggestionLines[1] == document.lineAt(firstNonEmptyDocLine + 1).text.slice(0, suggestionLines[1].length))
                return true;

            // 如果中间的行与文档中的行相同则丢弃
            if (suggestionLines.length > 2 && suggestionLines.slice(1).every((value, index) => 
                value === document.lineAt((firstNonEmptyDocLine + 1) + index).text))
                return true;
        }
        return discardSuggestion;
    }

    // 更新建议内容
    updateSuggestion = (suggestionLines: string[], lineSuffix: string) => {
        // 如果有后缀内容
        if (lineSuffix.trim() != ""){
            // 如果建议的第一行以后缀结尾,则去掉后缀部分
            if (suggestionLines[0].endsWith(lineSuffix)) return suggestionLines[0].slice(0, -lineSuffix.length);
            // 如果有多行,只返回第一行
            if (suggestionLines.length > 1) return suggestionLines[0];
        } 

        // 否则返回所有行组合
        return suggestionLines.join("\n");
    }

    // 移除尾部的空行
    removeTrailingNewLines = (suggestionLines: string[]) => {
        while (suggestionLines.length > 0 && suggestionLines.at(-1)?.trim() == "") {
            suggestionLines.pop();
        }
    }

    // 获取补全详情
    getCompletionDetails = (completion: string, position: vscode.Position, inputPrefix: string, inputSuffix: string, prompt: string) => {
        return { 
            suggestion: completion,    // 建议内容
            position: position,        // 位置
            inputPrefix: inputPrefix,  // 输入前缀
            inputSuffix: inputSuffix,  // 输入后缀
            prompt: prompt            // 提示文本
        };
    }

    // 从缓存获取补全
    getCachedCompletion = (hashKey: string, inputPrefix: string, inputSuffix: string, prompt: string) => {
        // 直接尝试获取完全匹配的缓存
        let result = this.lruResultCache.get(hashKey);
        if (result != undefined) return result;

        // 如果没有完全匹配,尝试部分匹配
        for (let i = prompt.length; i >= 0; i--) {
            let newPrompt = prompt.slice(0, i);
            let promptCut = prompt.slice(i);
            let hash = this.lruResultCache.getHash(inputPrefix + "|" + inputSuffix + "|" + newPrompt);
            let result = this.lruResultCache.get(hash);
            // 如果找到部分匹配且匹配部分与提示文本相符
            if (result != undefined && promptCut == result.slice(0,promptCut.length)) 
                return result.slice(prompt.length - newPrompt.length);
        }

        return undefined;
    }
}
