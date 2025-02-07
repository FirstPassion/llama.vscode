import * as vscode from 'vscode';

export class Configuration {
    // 扩展基础配置项
    enabled = true                    // 是否启用扩展
    endpoint = "http=//127.0.0.1:8012"// LLM服务端点
    auto = true                       // 是否自动提示
    api_key = ""                      // API密钥
    n_prefix = 256                    // 提示上文长度
    n_suffix = 64                     // 提示下文长度
    n_predict = 128                   // 预测生成的最大长度
    t_max_prompt_ms = 500             // 提示处理最大时间(毫秒)
    t_max_predict_ms = 2500           // 预测生成最大时间(毫秒)
    show_info = true                  // 是否显示信息
    max_line_suffix = 8               // 最大行后缀数
    max_cache_keys = 250              // 缓存键最大数量
    ring_n_chunks = 16                // 环形缓冲区块数
    ring_chunk_size = 64              // 环形缓冲区块大小
    ring_scope = 1024                 // 环形缓冲作用范围
    ring_update_ms = 1000             // 环形缓冲更新间隔(毫秒)
    language = "en"                   // 界面语言
    // 附加配置项
    axiosRequestConfig = {}           // Axios请求配置
    disabledLanguages: string[] = []  // 禁用的语言列表
    RING_UPDATE_MIN_TIME_LAST_COMPL = 3000    // 上次完成后最小更新时间
    MIN_TIME_BETWEEN_COMPL = 600              // 完成之间的最小时间间隔
    MAX_LAST_PICK_LINE_DISTANCE = 32          // 最大行距离
    MAX_QUEUED_CHUNKS = 16                    // 最大队列块数
    DELAY_BEFORE_COMPL_REQUEST = 150          // 完成请求前的延迟
    MAX_EVENTS_IN_LOG = 250                   // 日志最大事件数

    // 多语言界面文本映射
    private languageBg = new Map<string, string>([
        ["no suggestion", "нямам предложение"],
        ["thinking...", "мисля..."],
    ]);
    private languageEn = new Map<string, string>([
        ["no suggestion", "no suggestion"],
        ["thinking...", "thinking..."],
    ]);
    private languageDe = new Map<string, string>([
        ["no suggestion", "kein Vorschlag"],
        ["thinking...", "Ich denke..."],
    ]);
    private languageRu = new Map<string, string>([
        ["no suggestion", "нет предложения"],
        ["thinking...", "думаю..."],
    ]);
    private languageEs = new Map<string, string>([
        ["no suggestion", "ninguna propuesta"],
        ["thinking...", "pensando..."],
    ]);
    private languageCn = new Map<string, string>([
        ["no suggestion", "无建议"],
        ["thinking...", "思考..."],
    ]);
    private languageFr = new Map<string, string>([
        ["no suggestion", "pas de suggestion"],
        ["thinking...", "pense..."],
    ]);

    // 支持的语言映射表
    languages = new Map<string, Map<string, string>>([
        ["bg", this.languageBg],      // 保加利亚语
        ["en", this.languageEn],      // 英语
        ["de", this.languageDe],      // 德语
        ["ru", this.languageRu],      // 俄语
        ["es", this.languageEs],      // 西班牙语
        ["cn", this.languageCn],      // 中文
        ["fr", this.languageFr],      // 法语
    ]);

    constructor(config: vscode.WorkspaceConfiguration) {
        this.updateConfigs(config);    // 初始化时更新配置
        this.setLlamaRequestConfig();  // 设置API请求配置
    }

    // 从VSCode配置中更新设置
    private updateConfigs = (config: vscode.WorkspaceConfiguration) => {
        // TODO: 处理配置值类型错误的情况
        this.endpoint = this.trimTrailingSlash(String(config.get<string>("endpoint")));
        this.auto = Boolean(config.get<boolean>("auto"));
        this.api_key = String(config.get<string>("api_key"));
        this.n_prefix = Number(config.get<number>("n_prefix"));
        this.n_suffix = Number(config.get<number>("n_suffix"));
        this.n_predict = Number(config.get<number>("n_predict"));
        this.t_max_prompt_ms = Number(config.get<number>("t_max_prompt_ms"));
        this.t_max_predict_ms = Number(config.get<number>("t_max_predict_ms"));
        this.show_info = Boolean(config.get<boolean>("show_info"));
        this.max_line_suffix = Number(config.get<number>("max_line_suffix"));
        this.max_cache_keys = Number(config.get<number>("max_cache_keys"));
        this.ring_n_chunks = Number(config.get<number>("ring_n_chunks"));
        this.ring_chunk_size = Number(config.get<number>("ring_chunk_size"));
        this.ring_scope = Number(config.get<number>("ring_scope"));
        this.ring_update_ms = Number(config.get<number>("ring_update_ms"));
        this.language = String(config.get<string>("language"));
        this.disabledLanguages = config.get<string[]>("disabledLanguages") || [];
        this.enabled = Boolean(config.get<boolean>("enabled", true));
    }

    // 获取指定UI文本的当前语言翻译
    getUiText = (uiText: string): string | undefined => {
        let langTexts = this.languages.get(this.language)
        if (langTexts == undefined) langTexts = this.languages.get("en")  // 默认使用英语
        return langTexts?.get(uiText)
    }

    // 处理配置变更事件
    updateOnEvent = (event: vscode.ConfigurationChangeEvent, config: vscode.WorkspaceConfiguration) => {
        this.updateConfigs(config);
        // 如果API密钥发生变化，更新请求配置
        if (event.affectsConfiguration("llama-vscode.api_key")) {
            this.setLlamaRequestConfig();
        }
    }

    // 移除URL末尾的斜杠
    trimTrailingSlash = (s: string): string => {
        if (s.length > 0 && s[s.length - 1] === '/') {
            return s.slice(0, - 1);
        }
        return s;
    }

    // 设置LLaMA API请求配置
    setLlamaRequestConfig = () => {
        this.axiosRequestConfig = {};
        // 如果存在API密钥，添加到请求头中
        if (this.api_key != undefined && this.api_key != "") {
            this.axiosRequestConfig = {
                headers: {
                    'Authorization': `Bearer ${this.api_key}`,
                    'Content-Type': 'application/json'
                },
            };
        }
    }
}
