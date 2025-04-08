/**
 * GPT 检测(适配 Surge/Loon 版)
 *
 * 适配 Sub-Store Node.js 版 请查看: https://t.me/zhetengsha/1209
 *
 * 欢迎加入 Telegram 群组 https://t.me/zhetengsha
 * 检测方法: https://zset.cc/archives/34/
 * 需求来源: @underHZLY
 * 讨论贴: https://www.nodeseek.com/post-78153-1
 *
 * 参数
 * - [timeout] 请求超时(单位: 毫秒) 默认 5000
 * - [retries] 重试次数 默认 1
 * - [retry_delay] 重试延时(单位: 毫秒) 默认 1000
 * - [concurrency] 并发数 默认 10
 * - [client] GPT 检测的客户端类型. 默认 iOS
 * - [method] 请求方法. 默认 get
 * - [gpt_prefix] 显示前缀. 默认为 "[GPT] "
 注: 节点上总是会添加一个 _gpt 字段, 可用于脚本筛选. 新增 _gpt_latency 字段, 指响应延迟
 * - [cache] 使用缓存, 默认不使用缓存
 * - [disable_failed_cache/ignore_failed_error] 禁用失败缓存. 即不缓存失败结果
 * 关于缓存时长
 * 当使用相关脚本时, 若在对应的脚本中使用参数开启缓存, 可设置持久化缓存 sub-store-csr-expiration-time 的值来自定义默认缓存时长, 默认为 172800000 (48 * 3600 * 1000, 即 48 小时)
 * 🎈Loon 可在插件中设置
 * 其他平台同理, 持久化缓存数据在 JSON 里
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  if (!isLoon && !isSurge) throw new Error('仅支持 Loon 和 Surge(ability=http-client-policy)')
  
  // 预解析参数，避免重复解析
  const PARAMS = {
    cacheEnabled: $arguments.cache,
    disableFailedCache: $arguments.disable_failed_cache || $arguments.ignore_failed_error,
    gptPrefix: $arguments.gpt_prefix ?? '[GPT] ',
    method: $arguments.method || 'get',
    url: $arguments.client === 'Android' ? 'https://android.chat.openai.com' : 'https://ios.chat.openai.com',
    timeout: parseFloat($arguments.timeout || 5000),
    retries: parseFloat($arguments.retries ?? 1),
    retryDelay: parseFloat($arguments.retry_delay ?? 1000),
    concurrency: parseInt($arguments.concurrency || 10),
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
  }
  
  const cache = scriptResourceCache
  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined
  
  // 使用优化版的并发执行函数
  await executeAsyncTasksOptimized(
    proxies.map(proxy => () => check(proxy)),
    { concurrency: PARAMS.concurrency }
  )
  
  return proxies
  
  async function check(proxy) {
    // 优化缓存ID生成 - 只提取关键属性
    const generateCacheId = (proxy) => {
      if (!PARAMS.cacheEnabled) return undefined
      
      // 从代理中提取关键字段用于缓存ID生成，减少需要序列化的数据量
      const { server, port, type, username, password, cipher } = proxy
      const keyProps = { server, port, type }
      if (username) keyProps.username = username
      if (password) keyProps.password = password
      if (cipher) keyProps.cipher = cipher
      
      return `gpt:${PARAMS.url}:${JSON.stringify(keyProps)}`
    }
    
    const id = generateCacheId(proxy)
    
    try {
      const node = ProxyUtils.produce([proxy], target)
      if (!node) return
      
      // 缓存检查
      if (PARAMS.cacheEnabled) {
        const cached = cache.get(id)
        if (cached) {
          if (cached.gpt) {
            proxy.name = `${PARAMS.gptPrefix}${proxy.name}`
            proxy._gpt = true
            proxy._gpt_latency = cached.gpt_latency
            $.info(`[${proxy.name}] 使用成功缓存`)
            return
          } else if (PARAMS.disableFailedCache) {
            $.info(`[${proxy.name}] 不使用失败缓存`)
          } else {
            $.info(`[${proxy.name}] 使用失败缓存`)
            return
          }
        }
      }
      
      // 发起请求
      const startedAt = Date.now()
      const res = await httpOptimized({
        method: PARAMS.method,
        headers: { 'User-Agent': PARAMS.userAgent },
        url: PARAMS.url,
        'policy-descriptor': node,
        node,
      })
      
      const status = parseInt(res.status ?? res.statusCode ?? 200)
      const latency = Date.now() - startedAt
      
      // 处理响应体，仅在需要时进行JSON解析
      let body, msg
      const bodyText = String(res.body ?? res.rawBody)
      
      // 只有当响应内容像JSON时才尝试解析
      if (bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[')) {
        try {
          body = JSON.parse(bodyText)
          msg = body?.error?.code || body?.error?.error_type || body?.cf_details
        } catch (e) {
          body = bodyText
        }
      } else {
        body = bodyText
      }
      
      $.info(`[${proxy.name}] status: ${status}, msg: ${msg}, latency: ${latency}`)
      
      // 判断节点是否支持GPT
      if (status == 403 && !/unsupported_country/.test(msg)) {
        proxy.name = `${PARAMS.gptPrefix}${proxy.name}`
        proxy._gpt = true
        proxy._gpt_latency = latency
        if (PARAMS.cacheEnabled) {
          $.info(`[${proxy.name}] 设置成功缓存`)
          cache.set(id, { gpt: true, gpt_latency: latency })
        }
      } else if (PARAMS.cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`)
        cache.set(id, {})
      }
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      if (PARAMS.cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`)
        cache.set(id, {})
      }
    }
  }
  
  // 优化的HTTP请求函数 - 使用迭代而非递归进行重试
  async function httpOptimized(opt = {}) {
    const METHOD = opt.method || PARAMS.method
    const TIMEOUT = opt.timeout || PARAMS.timeout
    const RETRIES = opt.retries ?? PARAMS.retries
    const RETRY_DELAY = opt.retry_delay ?? PARAMS.retryDelay
    
    let count = 0
    
    while (true) {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          const delay = RETRY_DELAY * count
          await $.wait(delay)
        } else {
          throw e
        }
      }
    }
  }
  
  // 优化的异步任务执行器
  function executeAsyncTasksOptimized(tasks, { concurrency = 1, result = false, wrap = false } = {}) {
    return new Promise((resolve, reject) => {
      const results = result ? new Array(tasks.length) : undefined
      let running = 0
      let index = 0
      let completed = 0
      
      function runNextTask() {
        // 当所有任务完成时，结束函数
        if (completed === tasks.length) {
          return resolve(results)
        }
        
        // 只要有空闲槽位和剩余任务，就继续执行
        while (running < concurrency && index < tasks.length) {
          const taskIndex = index++
          const task = tasks[taskIndex]
          
          running++
          
          Promise.resolve(task())
            .then(data => {
              if (result) {
                results[taskIndex] = wrap ? { data } : data
              }
            })
            .catch(error => {
              if (result) {
                results[taskIndex] = wrap ? { error } : error
              }
            })
            .finally(() => {
              running--
              completed++
              runNextTask()
            })
        }
      }
      
      // 开始执行任务
      runNextTask()
    })
  }
}
