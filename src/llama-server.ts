import axios from 'axios';
import { Configuration } from './configuration';

// 定义成功的 HTTP 状态码
const STATUS_OK = 200

// Llama API 响应的接口定义
export interface LlamaResponse {
    content?: string;                    // 生成的内容
    generation_settings?: any;           // 生成设置
    tokens_cached?: number;              // 缓存的 token 数量
    truncated?: boolean;                 // 是否被截断
    timings?: {                         // 性能计时相关信息
        prompt_n?: number;               // 提示词的 token 数量
        prompt_ms?: number;              // 处理提示词所需时间（毫秒）
        prompt_per_second?: number;      // 每秒处理的提示词 token 数
        predicted_n?: number;            // 生成的 token 数量
        predicted_ms?: number;           // 生成所需时间（毫秒）
        predicted_per_second?: number;   // 每秒生成的 token 数
    };
}

// Llama 服务器类，用于与 Llama API 进行交互
export class LlamaServer{
    private extConfig: Configuration     // 存储配置信息

    constructor(config: Configuration) {
        this.extConfig = config
    }

    // 获取 Llama 补全结果的方法
    // 使用箭头函数确保 this 的正确绑定
    getLlamaCompletion = async (
        inputPrefix: string,     // 输入文本的前缀
        inputSuffix: string,     // 输入文本的后缀
        prompt: string,          // 主要提示词
        chunks: any,             // 额外的上下文块
        nindent: number         // 缩进级别
    ): Promise<LlamaResponse | undefined> => {
        // 构建请求负载
        const requestPayload = {
            input_prefix: inputPrefix,
            input_suffix: inputSuffix,
            input_extra: chunks,
            prompt: prompt,
            n_predict: this.extConfig.n_predict,    // 预测的 token 数量
            // 采样参数设置
            top_k: 40,                              // 保留概率最高的前 k 个 token
            top_p: 0.99,                           // 累积概率阈值
            stream: false,                         // 是否使用流式响应
            n_indent: nindent,                     // 缩进数量
            samplers: ["top_k", "top_p", "infill"], // 使用的采样器
            cache_prompt: true,                    // 是否缓存提示词
            t_max_prompt_ms: this.extConfig.t_max_prompt_ms,     // 处理提示词的最大时间
            t_max_predict_ms: this.extConfig.t_max_predict_ms    // 生成的最大时间
        };
        // 发送 POST 请求到 Llama API
        const response = await axios.post<LlamaResponse>(this.extConfig.endpoint + "/infill", requestPayload, this.extConfig.axiosRequestConfig);
        if (response.status != STATUS_OK || !response.data ) return undefined
        else return response.data;
    }

    // 为下一次补全准备 Llama 模型
    // 通过预热请求来优化后续补全的性能
    prepareLlamaForNextCompletion = (chunks: any[]): void => {
        // 构建预热请求的负载
        const requestPayload = {
            input_prefix: "",
            input_suffix: "",
            input_extra: chunks,
            prompt: "",
            n_predict: 1,                // 最小预测量
            top_k: 40,
            top_p: 0.99,
            stream: false,
            samplers: ["temperature"],   // 仅使用温度采样
            cache_prompt: true,
            t_max_prompt_ms: 1,          // 最小处理时间
            t_max_predict_ms: 1          // 最小生成时间
        };

        // 发送预热请求（不等待响应）
        axios.post<LlamaResponse>(this.extConfig.endpoint + "/infill", requestPayload, this.extConfig.axiosRequestConfig);
    }
}
