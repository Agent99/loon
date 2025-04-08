import pLimit from 'p-limit';
import http from 'http';
import https from 'https';

// 初始化配置
const CONCURRENCY = 10;
const RETRIES = 1;
const BASE_TIMEOUT = 1000;
const CACHE_TTL = 60000; // 缓存有效期(毫秒)
const cache = new Map();
const limit = pLimit(CONCURRENCY);
const keepAliveAgent = new https.Agent({ keepAlive: true });

// 动态计算超时（示例：简单平均）
function calculateTimeout(node) {
  const historicalAvg = node.history?.responseTime || BASE_TIMEOUT;
  return historicalAvg * 2; // 允许波动
}

// 判断错误是否可重试
function isRetryable(error) {
  // 网络错误、超时错误通常可以重试
  return error.name === 'AbortError' || 
         error.code === 'ECONNRESET' || 
         error.code === 'ETIMEDOUT' ||
         error.code === 'ECONNREFUSED';
}

// 处理响应
function processResponse(response, node) {
  // 保存响应时间用于将来优化
  const now = Date.now();
  if (!node.history) node.history = {};
  
  if (response.ok) {
    node.history.responseTime = node.history.responseTime 
      ? (node.history.responseTime * 0.7 + (now - node.startTime) * 0.3) // 加权平均
      : (now - node.startTime);
    return { 
      status: response.status, 
      success: true,
      time: now - node.startTime
    };
  }
  
  return {
    status: response.status,
    success: false
  };
}

// 带超时和复用的请求
async function fetchNode(node) {
  const controller = new AbortController();
  const timeout = calculateTimeout(node);
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  node.startTime = Date.now();
  
  try {
    const response = await fetch(node.url, {
      agent: keepAliveAgent,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// 重试逻辑
async function withRetry(fn, node) {
  let retryCount = 0;
  while (retryCount <= RETRIES) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || retryCount === RETRIES) throw error;
      retryCount++;
      
      // 指数退避重试
      const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
      await new Promise(res => setTimeout(res, delay));
      
      // 记录重试信息
      if (!node.history) node.history = {};
      if (!node.history.retries) node.history.retries = 0;
      node.history.retries++;
    }
  }
}

// 检查节点主逻辑
async function checkNode(node) {
  // 检查缓存是否有效
  const cachedResult = cache.get(node.id);
  if (cachedResult && (Date.now() - cachedResult.timestamp < CACHE_TTL)) {
    return cachedResult.data;
  }
  
  try {
    const response = await withRetry(() => fetchNode(node), node);
    const result = processResponse(response, node);
    
    // 更新缓存，添加时间戳
    cache.set(node.id, {
      data: result,
      timestamp: Date.now()
    });
    
    return result;
  } catch (error) {
    return { 
      error: error.message,
      success: false
    };
  }
}

// 定期清理过期缓存
function setupCacheCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        cache.delete(key);
      }
    }
  }, CACHE_TTL);
}

// 初始化缓存清理
setupCacheCleanup();

// 并发执行
export default async function (nodes) {
  const tasks = nodes.map(node => 
    limit(() => checkNode(node))
  );
  return Promise.all(tasks);
} 