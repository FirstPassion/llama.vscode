import { Configuration } from './configuration';
import { LlamaServer } from './llama-server';
import * as vscode from 'vscode';

/**
 * ExtraContext 类用于管理代码补全的上下文信息
 * 主要功能包括：
 * 1. 维护一个环形缓冲区来存储代码片段
 * 2. 收集光标附近的代码作为上下文
 * 3. 管理代码片段的队列和更新
 */
export class ExtraContext {
    private extConfig: Configuration
    private llamaServer: LlamaServer
    // 存储当前活跃的代码片段
    chunks: any[] = [];
    // 存储每个代码片段的行，用于计算相似度
    chunksLines: string[][] = []; 
    // 等待处理的代码片段队列
    queuedChunks: any[] = [];
    // 等待处理的代码片段行队列
    queuedChunksLines: string[][] = [];
    // 上次补全开始的时间戳
    lastComplStartTime = Date.now();
    // 上次选择代码行的位置
    lastLinePick = -9999;
    // 被移除的代码片段计数
    ringNEvict = 0;

    constructor(config: Configuration, llamaServer: LlamaServer) {
        this.extConfig = config
        this.llamaServer = llamaServer
    }

    /**
     * 定期更新环形缓冲区
     * 将队列中的代码片段转移到活跃缓冲区中，并确保不超过最大容量
     */
    periodicRingBufferUpdate = () => {
        // 检查队列状态和时间间隔是否满足更新条件
        if (this.queuedChunks === undefined
            || this.queuedChunks === null
            || this.queuedChunks.length == 0
            || Date.now() - this.lastComplStartTime < this.extConfig.RING_UPDATE_MIN_TIME_LAST_COMPL) {
            return;
        }
        // 从队列中取出第一个代码片段的行
        let queueChunkLns = this.queuedChunksLines.shift()
        if (queueChunkLns != undefined) {
            // 将代码片段添加到活跃缓冲区
            this.chunksLines.push(queueChunkLns);
            this.chunks.push(this.queuedChunks.shift());
            // 确保不超过最大容量限制
            while (this.chunks.length > this.extConfig.ring_n_chunks) {
                this.chunks.shift();
                this.chunksLines.shift()
            }
        }

        // 通知LLM服务器准备下一次补全
        this.llamaServer.prepareLlamaForNextCompletion(this.chunks)
    };

    /**
     * 添加用于代码补全的上下文代码片段
     * @param position 当前光标位置
     * @param context 内联补全上下文
     * @param document 当前文档
     */
    addFimContextChunks = async (position: vscode.Position, context: vscode.InlineCompletionContext, document: vscode.TextDocument) => {
        // 计算光标位置与上次选择位置的行距
        let deltaLines = Math.abs(position.line - this.lastLinePick);
        
        // 当光标移动距离超过阈值时，收集新的上下文
        if (deltaLines > this.extConfig.MAX_LAST_PICK_LINE_DISTANCE) {
            // 收集光标位置之前的代码作为前缀上下文
            let prefixChunkLines = this.getDocumentLines(
                Math.max(0, position.line - this.extConfig.ring_scope), 
                Math.max(0, position.line - this.extConfig.n_prefix), 
                document
            );
            this.pickChunk(prefixChunkLines, false, false, document);
            
            // 收集光标位置之后的代码作为后缀上下文
            let suffixChunkLines = this.getDocumentLines(
                Math.min(document.lineCount - 1, position.line + this.extConfig.n_suffix), 
                Math.min(document.lineCount - 1, position.line + this.extConfig.n_suffix + this.extConfig.ring_chunk_size), 
                document
            )
            this.pickChunk(suffixChunkLines, false, false, document);

            // 更新上次选择位置
            this.lastLinePick = position.line;
        }
    }

    /**
     * 获取文档中指定范围的行
     * @param startLine 起始行
     * @param endLine 结束行
     * @param document 目标文档
     * @returns 指定范围内的所有行文本数组
     */
    getDocumentLines = (startLine: number, endLine: number, document: vscode.TextDocument) => {
        return Array.from({ length: endLine - startLine + 1 }, (_, i) => document.lineAt(startLine + i).text);
    }

    /**
     * 选择并处理代码片段
     * @param lines 待处理的代码行
     * @param noMod 是否允许修改
     * @param doEvict 是否允许移除相似片段
     * @param doc 当前文档
     */
    pickChunk = (lines: string[], noMod: boolean, doEvict: boolean, doc: vscode.TextDocument) => {
        // 如果不允许修改且文档有未保存的更改，则返回
        if (noMod && doc.isDirty) {
            return
        }

        // 如果环形缓冲区大小设置为0或更小，则返回
        if (this.extConfig.ring_n_chunks <= 0)
            return;

        // 不处理过小的代码片段
        if (lines.length < 3)
            return

        // 根据配置的chunk大小处理代码片段
        let newChunkLines: string[]
        if (lines.length + 1 < this.extConfig.ring_chunk_size) {
            // 如果代码行数小于配置的大小，直接使用
            newChunkLines = lines
        } else {
            // 随机选择一个起始位置，获取半个chunk大小的代码
            let startLine = Math.floor(Math.random() * (Math.max(0, lines.length - this.extConfig.ring_chunk_size / 2 + 1)))
            let endline = Math.min(startLine + this.extConfig.ring_chunk_size / 2, lines.length)
            newChunkLines = lines.slice(startLine, endline)
        }
        // 将代码行合并为字符串
        let chunkString = newChunkLines.join('\n') + '\n'

        // 如果需要移除重复，检查是否已存在相同的代码片段
        if (doEvict
            && (this.chunks.some(ch => ch.text == chunkString)
                || this.queuedChunks.some(ch => ch.text == chunkString))) {
            return
        }

        // 移除相似度高于90%的现有代码片段
        if (doEvict) {
            for (let i = this.chunks.length - 1; i >= 0; i--) {
                if (this.jaccardSimilarity(this.chunksLines[i], newChunkLines) > 0.9) {
                    this.chunks.splice(i, 1)
                    this.chunksLines.splice(i, 1)
                    this.ringNEvict++;
                }
            }
        }

        // 移除队列中相似度高于90%的代码片段
        if (doEvict) {
            for (let i = this.queuedChunks.length - 1; i >= 0; i--) {
                if (this.jaccardSimilarity(this.queuedChunksLines[i], newChunkLines) > 0.9) {
                    this.queuedChunks.splice(i, 1)
                    this.queuedChunksLines.splice(i, 1)
                    this.ringNEvict++;
                }
            }
        }

        // 如果等待队列已满，移除最旧的代码片段
        if (this.queuedChunks.length >= this.extConfig.MAX_QUEUED_CHUNKS) {
            this.queuedChunks.splice(0, 1)
        }

        // 创建新的代码片段对象，包含文本内容、时间戳和文件名
        let newChunk = { 
            text: chunkString,      // 代码文本
            time: Date.now(),       // 创建时间
            filename: doc.fileName  // 所属文件
        };
        // 将新代码片段添加到等待队列
        this.queuedChunks.push(newChunk);
        this.queuedChunksLines.push(newChunkLines)
    }

    /**
     * 选择光标周围的代码片段
     * @param cursorLine 光标所在行
     * @param activeDocument 当前活跃文档
     */
    pickChunkAroundCursor = (cursorLine: number, activeDocument: vscode.TextDocument) => {
        // 获取光标上下各半个chunk大小的代码行
        let chunkLines = this.getDocumentLines(
            Math.max(0, cursorLine - this.extConfig.ring_chunk_size / 2), 
            Math.min(cursorLine + this.extConfig.ring_chunk_size / 2, activeDocument.lineCount - 1), 
            activeDocument
        )
        // 处理获取的代码片段，允许修改且需要移除相似片段
        this.pickChunk(chunkLines, true, true, activeDocument);
    }

    /**
     * 计算两个代码片段之间的Jaccard相似度
     * Jaccard相似度 = 交集大小 / 并集大小
     * @param lines0 第一个代码片段的行数组
     * @param lines1 第二个代码片段的行数组
     * @returns 相似度值（0-1之间）
     */
    jaccardSimilarity = (lines0: string[], lines1: string[]): number => {
        // 如果两个代码片段都为空，则认为它们完全相似
        if (lines0.length === 0 && lines1.length === 0) {
            return 1;
        }

        // 将代码行转换为集合，用于计算交集和并集
        const setA = new Set(lines0);
        const setB = new Set(lines1);

        // 计算两个集合的交集
        const intersection = new Set([...setA].filter(x => setB.has(x)));
        // 计算两个集合的并集
        const union = new Set([...setA, ...setB]);

        // 返回Jaccard相似度：交集大小除以并集大小
        return intersection.size / union.size;
    }

}
