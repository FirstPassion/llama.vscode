import * as crypto from 'crypto';

/**
 * LRU (Least Recently Used) 缓存实现
 * 使用 Map 数据结构来存储键值对，并维护访问顺序
 * 当缓存达到容量上限时，会移除最久未使用的项目
 */
export class LRUCache {
    // 缓存的最大容量
    private capacity: number;
    // 使用 Map 存储缓存项，Map 的特性保证了插入顺序
    private map: Map<string, string>;

    /**
     * 构造函数
     * @param capacity 缓存的最大容量，必须大于0
     * @throws 如果容量小于等于0，抛出错误
     */
    constructor(capacity: number) {
        if (capacity <= 0) {
            throw new Error("Capacity must be greater than 0");
        }
        this.capacity = capacity;
        this.map = new Map();
    }

    /**
     * 获取与指定键关联的值
     * 如果键存在，会将其移动到最近使用的位置（Map的末尾）
     * @param key 要检索的键
     * @returns 如果键存在则返回关联的值，否则返回 undefined
     */
    get = (key: string): string | undefined => {
        if (!this.map.has(key)) {
            return undefined;
        }

        // 将键值对移动到最近使用的位置
        const value = this.map.get(key)!;
        this.map.delete(key);
        this.map.set(key, value);

        return value;
    }

    /**
     * 插入或更新键值对
     * 如果键已存在，会更新值并将其移动到最近使用的位置
     * 如果缓存超出容量，会移除最久未使用的项目（Map的第一个元素）
     * @param key 要插入或更新的键
     * @param value 要关联的值
     */
    put = (key: string, value: string): void => {
        if (this.map.has(key)) {
            // 如果键存在，删除它以刷新其位置
            this.map.delete(key);
        }

        this.map.set(key, value);

        // 如果超出容量，移除最久未使用的项目
        if (this.map.size > this.capacity) {
            const leastRecentlyUsedKey = this.map.keys().next().value;
            if (leastRecentlyUsedKey != undefined) {
                this.map.delete(leastRecentlyUsedKey);
            }
        }
    }

    /**
     * 获取当前缓存中的项目数量
     * @returns 缓存中的项目数量
     */
    size = (): number => {
        return this.map.size;
    }

    /**
     * 计算请求上下文的SHA-256哈希值
     * @param request_context 需要计算哈希的请求上下文字符串
     * @returns 返回十六进制格式的哈希字符串
     */
    getHash = (request_context: string): string => {
        const hashSha256 = crypto.createHash('sha256');
        return hashSha256.update(request_context).digest('hex')
    }

    /**
     * 获取内部Map对象的引用
     * 注意：这个方法主要用于调试和测试目的
     * @returns 返回存储缓存项的Map对象
     */
    getMap = () => {
        return this.map;
    }
}
