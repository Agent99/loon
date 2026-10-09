/**
 * GPT-V2 Safe / Sub-Store Loon & Surge
 * Default mode=fast: PASS THROUGH WITHOUT NETWORK REQUESTS or node changes.
 * mode=cache: read cached positive GPT results only, zero network.
 * mode=check: limited GPT connectivity checks; never filter or drop nodes.
 *
 * Examples:
 * #mode=fast
 * #mode=cache&cache=true
 * #mode=check&client=iOS&max_checks=6&concurrency=2&timeout=2500&retries=0&cache=true
 *
 * IMPORTANT: HTTP 403 is only a heuristic, NOT proof of ChatGPT usability.
 * If a later Sub-Store filter keeps only _gpt=true / [GPT] names,
 * disable it for the full-node subscription or the result can still be empty.
 */
async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const args = (typeof $arguments !== 'undefined' && $arguments) || {};
  const env = $.env || {};
  if (!Array.isArray(proxies) || proxies.length === 0) return proxies;

  const mode = String(args.mode || 'fast').toLowerCase();
  if (mode === 'fast' || !['cache', 'check'].includes(mode)) {
    $.info('[GPT-V2] FAST: 不进行网络请求，原样返回 ' + proxies.length + ' 个节点');
    return proxies;
  }
  if (!env.isLoon && !env.isSurge) {
    $.info('[GPT-V2] 不支持当前运行环境，直接返回原有节点');
    return proxies;
  }

  const target = env.isLoon ? 'Loon' : 'Surge';
  const endpoint = String(args.client || 'iOS').toLowerCase() === 'android'
    ? 'https://android.chat.openai.com' : 'https://ios.chat.openai.com';
  const timeout = intArg(args.timeout, 2500, 500, 15000);
  const retries = intArg(args.retries, 0, 0, 2);
  const retryDelay = intArg(args.retry_delay, 500, 0, 5000);
  const concurrency = intArg(args.concurrency, 2, 1, 6);
  const maxChecks = intArg(args.max_checks, 6, 0, 100);
  const maxErrors = intArg(args.max_errors, 3, 1, 100);
  const cacheTtl = intArg(args.cache_ttl, 3600000, 60000, 86400000);
  const failedTtl = intArg(args.failed_cache_ttl, 120000, 10000, 3600000);
  const prefix = args.gpt_prefix === undefined ? '[GPT] ' : String(args.gpt_prefix);
  const useCache = boolArg(args.cache, true);
  const includeUnsupported = boolArg(args.include_unsupported_proxy, false);
  const cache = typeof scriptResourceCache === 'undefined' ? null : scriptResourceCache;
  const cacheOk = useCache && cache && typeof cache.get === 'function' && typeof cache.set === 'function';

  const stats = { hits: 0, checked: 0, pass: 0, unsupported: 0, unknown: 0, error: 0, skipped: 0 };
  const queue = [];

  // Cache lookup first, independently of the online check quota.
  for (const proxy of proxies) {
    if (!proxy || typeof proxy !== 'object') continue;
    const key = cacheOk ? getKey(proxy) : null;
    const cached = key ? cache.get(key) : null;
    if (cached && cached.result === 'pass') {
      markPassed(proxy, cached.latency, 'cache');
      stats.hits++;
      stats.pass++;
    } else if (mode === 'check') {
      // Short negative cache prevents repeating known timeout/reset failures.
      if (cached && cached.result && cached.result !== 'pass') {
        stats.hits++;
        stats.skipped++;
        proxy._gpt_status = 'cached_' + String(cached.result);
      } else if (queue.length < maxChecks) {
        queue.push({ proxy, key });
      } else {
        stats.skipped++;
      }
    }
  }

  if (mode === 'cache') {
    $.info('[GPT-V2] CACHE: 输出 ' + proxies.length + ' 个节点，使用成功缓存 ' + stats.hits + ' 个；不发起网络请求');
    return proxies;
  }
  if (!queue.length) {
    $.info('[GPT-V2] CHECK: 没有待测节点；原样输出 ' + proxies.length + ' 个');
    return proxies;
  }

  let next = 0;
  async function worker() {
    while (next < queue.length && stats.error < maxErrors) {
      const task = queue[next++];
      await test(task);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  } catch (e) {
    $.error('[GPT-V2] 工作队列异常: ' + errorText(e));
  }

  stats.skipped += queue.length - stats.checked;
  $.info('[GPT-V2] CHECK: 输入=' + proxies.length +
    ', 实际检测=' + stats.checked + ', 成功=' + stats.pass +
    ', 地区限制=' + stats.unsupported + ', 未确认=' + stats.unknown +
    ', 请求失败=' + stats.error + ', 缓存命中=' + stats.hits +
    ', 跳过=' + stats.skipped + ', 输出=' + proxies.length);
  // IMPORTANT: Never filter proxies, even if every check failed.
  return proxies;

  async function test(task) {
    const proxy = task.proxy;
    const name = String(proxy.name || '(unnamed)');
    stats.checked++;
    try {
      const node = ProxyUtils.produce([proxy], target, undefined, {
        'include-unsupported-proxy': includeUnsupported
      });
      if (!node) {
        proxy._gpt_status = 'incompatible';
        stats.unknown++;
        return;
      }
      const startedAt = Date.now();
      let response;
      for (let retry = 0; ; retry++) {
        try {
          response = await $.http.get({
            method: 'get', url: endpoint, timeout,
            headers: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
            },
            'policy-descriptor': node, node
          });
          break;
        } catch (e) {
          if (retry >= retries) throw e;
          await $.wait(retryDelay * (retry + 1));
        }
      }
      const latency = Date.now() - startedAt;
      const status = Number(response && (response.status ?? response.statusCode)) || 0;
      let body = response && (response.body ?? response.rawBody);
      const bodyString = typeof body === 'string' ? body : safeStringify(body);
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) {}
      }
      const code = body && typeof body === 'object'
        ? String(body.error?.code || body.error?.error_type || body.cf_details || '') : '';
      const signal = (code + ' ' + bodyString.slice(0, 1600)).toLowerCase();
      let result = 'unknown';
      if (/unsupported_country|unsupported_region|country_not_supported/.test(signal)) result = 'unsupported';
      else if (status === 403 && !/cloudflare|challenge-platform|captcha|just a moment|attention required/.test(signal)) result = 'pass';

      if (result === 'pass') {
        markPassed(proxy, latency, 'check');
        stats.pass++;
      } else {
        // An inconclusive response should not wipe previously known _gpt success.
        proxy._gpt_status = result;
        if (result === 'unsupported') {
          proxy._gpt = false;
          proxy.name = removePrefix(name);
          stats.unsupported++;
        } else stats.unknown++;
      }
      if (task.key && (result === 'pass' || result === 'unsupported' || result === 'unknown')) {
        cache.set(task.key, { result, latency }, result === 'pass' ? cacheTtl : failedTtl);
      }
      $.info('[GPT-V2] [' + name + '] HTTP=' + status + ' ' + result + ', latency=' + latency + 'ms');
    } catch (e) {
      stats.error++;
      proxy._gpt_status = 'error';
      if (task.key) {
        try { cache.set(task.key, { result: 'error' }, failedTtl); } catch (_) {}
      }
      // Connection reset / timeout is a probe error, NOT a reason to delete the node.
      $.info('[GPT-V2] [' + name + '] 探测失败，保留节点: ' + errorText(e));
    }
  }

  function getKey(proxy) {
    const fields = Object.fromEntries(Object.entries(proxy).filter(([key]) =>
      !/^(name|collectionName|subName|id|_.*)$/i.test(key)
    ));
    return 'gpt-v2:' + endpoint + ':' + JSON.stringify(fields);
  }
  function markPassed(proxy, latency, origin) {
    proxy.name = prefix + removePrefix(String(proxy.name || ''));
    proxy._gpt = true;
    proxy._gpt_status = origin === 'cache' ? 'cached_pass' : 'pass';
    if (latency != null) proxy._gpt_latency = latency;
  }
  function removePrefix(name) {
    if (!prefix) return name;
    while (name.startsWith(prefix)) name = name.slice(prefix.length);
    return name;
  }
  function boolArg(v, d) {
    return v == null || v === '' ? d : /^(true|1|yes|on)$/i.test(String(v));
  }
  function intArg(v, d, min, max) {
    if (v == null || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : d;
  }
  function safeStringify(v) {
    try { return JSON.stringify(v) || ''; } catch (_) { return ''; }
  }
  function errorText(e) {
    return String(e && (e.message || e) || 'unknown').slice(0, 220);
  }
}
