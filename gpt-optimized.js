/**
 * GPT 检测(适配 Surge/Loon 版)
 * 优化版本
 * 
 * 参数说明与原版相同
 */
async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const { isLoon, isSurge } = $.env;
  
  // 参数验证和初始化
  if (!isLoon && !isSurge) {
    throw new Error('仅支持 Loon 和 Surge(ability=http-client-policy)');
  }

  const {
    cache: cacheEnabled = false,
    disable_failed_cache: disableFailedCache = false,
    gpt_prefix: gptPrefix = '[GPT] ',
    method = 'get',
    client = 'iOS',
    concurrency = 10
  } = $arguments;

  const target = isLoon ? 'Loon' : 'Surge';
  const cache = scriptResourceCache;
  const baseUrl = client === 'Android' 
    ? 'https://android.chat.openai.com' 
    : 'https://ios.chat.openai.com';

  // 并发处理代理检测
  await batchProcess(proxies.map(proxy => () => checkProxy(proxy)), concurrency);
  return proxies;

  async function checkProxy(proxy) {
    const proxyInfo = extractProxyInfo(proxy);
    const cacheKey = cacheEnabled 
      ? `gpt:${baseUrl}:${JSON.stringify(proxyInfo)}` 
      : null;

    try {
      const node = ProxyUtils.produce([proxy], target);
      if (!node) return;

      // 检查缓存
      if (cacheEnabled) {
        const cachedResult = handleCache(cacheKey, proxy);
        if (cachedResult !== null) return cachedResult;
      }

      // 执行检测
      const { status, body, latency } = await testProxy(node);
      updateProxyStatus(proxy, status, body, latency, cacheKey);

    } catch (error) {
      $.error(`[${proxy.name}] 检测失败: ${error.message ?? error}`);
      if (cacheEnabled) {
        cache.set(cacheKey, {});
      }
    }
  }

  function extractProxyInfo(proxy) {
    return Object.fromEntries(
      Object.entries(proxy).filter(
        ([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key)
      )
    );
  }

  function handleCache(cacheKey, proxy) {
    if (!cacheKey) return null;
    
    const cached = cache.get(cacheKey);
    if (!cached) return null;

    if (cached.gpt) {
      proxy.name = `${gptPrefix}${proxy.name}`;
      proxy._gpt = true;
      proxy._gpt_latency = cached.gpt_latency;
      $.info(`[${proxy.name}] 使用成功缓存`);
      return true;
    }

    if (disableFailedCache) {
      $.info(`[${proxy.name}] 不使用失败缓存`);
      return null;
    }

    $.info(`[${proxy.name}] 使用失败缓存`);
    return true;
  }

  async function testProxy(node) {
    const startedAt = Date.now();
    const res = await makeRequest({
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
      },
      url: baseUrl,
      'policy-descriptor': node,
      node
    });

    const status = parseInt(res.status ?? res.statusCode ?? 200);
    let body = parseResponseBody(res.body ?? res.rawBody);
    const latency = Date.now() - startedAt;

    $.info(`[${node.name}] 状态: ${status}, 消息: ${body?.error?.code || body?.error?.error_type || body?.cf_details}, 延迟: ${latency}ms`);
    
    return { status, body, latency };
  }

  function parseResponseBody(body) {
    try {
      return typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      return body;
    }
  }

  function updateProxyStatus(proxy, status, body, latency, cacheKey) {
    const msg = body?.error?.code || body?.error?.error_type || body?.cf_details;
    const isSupported = status === 403 && !/unsupported_country/.test(msg);

    if (isSupported) {
      proxy.name = `${gptPrefix}${proxy.name}`;
      proxy._gpt = true;
      proxy._gpt_latency = latency;
      
      if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置成功缓存`);
        cache.set(cacheKey, { gpt: true, gpt_latency: latency });
      }
    } else if (cacheEnabled) {
      $.info(`[${proxy.name}] 设置失败缓存`);
      cache.set(cacheKey, {});
    }
  }

  async function makeRequest(opt) {
    const {
      method = 'get',
      timeout = parseFloat($arguments.timeout || 5000),
      retries = parseFloat($arguments.retries ?? 1),
      retry_delay = parseFloat($arguments.retry_delay ?? 1000)
    } = opt;

    let attempt = 0;
    
    const executeRequest = async () => {
      try {
        return await $.http[method.toLowerCase()]({ 
          ...opt, 
          timeout 
        });
      } catch (error) {
        if (attempt < retries) {
          attempt++;
          const delay = retry_delay * attempt;
          await $.wait(delay);
          return executeRequest();
        }
        throw error;
      }
    };

    return executeRequest();
  }

  function batchProcess(tasks, concurrency = 1) {
    return new Promise((resolve) => {
      let running = 0;
      let index = 0;
      const results = [];

      const executeNext = async () => {
        while (index < tasks.length && running < concurrency) {
          const currentIndex = index++;
          running++;
          
          tasks[currentIndex]()
            .then(result => results[currentIndex] = result)
            .catch(error => results[currentIndex] = error)
            .finally(() => {
              running--;
              executeNext();
            });
        }

        if (running === 0) resolve(results);
      };

      executeNext();
    });
  }
}
