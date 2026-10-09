/**
 * Sub-Store GPT node check (Loon / Surge) - v2.0
 *
 * Purpose: mark nodes that pass the legacy iOS/Android ChatGPT endpoint check.
 * NOTE: HTTP 403 alone does not guarantee full ChatGPT usability.
 *       This script rejects known unsupported_country and Cloudflare challenge responses.
 *
 * Sub-Store script operator parameters (one # only):
 *   client=iOS&concurrency=3&timeout=4000&retries=0&cache=true&cache_ttl=3600000
 * Optional: retry_delay=500&gpt_prefix=[GPT]%20&include_unsupported_proxy=false
 *           cache_failed=false&failed_cache_ttl=120000
 *
 * Nodes remain in the output regardless of check result. Filter separately if desired.
 * Script compatibility: Sub-Store with Loon, or Surge with http-client-policy ability.
 */
async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const args = (typeof $arguments !== 'undefined' && $arguments) || {};
  const env = $.env || {};
  if (!env.isLoon && !env.isSurge) {
    throw new Error('[GPT-V2] 仅支持 Loon / Surge（Surge 需 http-client-policy 能力）');
  }

  const target = env.isLoon ? 'Loon' : 'Surge';
  const client = String(args.client || 'iOS').toLowerCase();
  const endpoint = client === 'android'
    ? 'https://android.chat.openai.com'
    : 'https://ios.chat.openai.com';
  const concurrency = integerArg(args.concurrency, 3, 1, 10);
  const timeout = integerArg(args.timeout, 4000, 1000, 15000);
  const retries = integerArg(args.retries, 0, 0, 2);
  const retryDelay = integerArg(args.retry_delay, 500, 0, 10000);
  const cacheEnabled = boolArg(args.cache, true);
  const cacheFailed = boolArg(args.cache_failed, false);
  const cacheTtl = integerArg(args.cache_ttl, 3600000, 60000, 86400000);
  const failedCacheTtl = integerArg(args.failed_cache_ttl, 120000, 10000, 3600000);
  const includeUnsupported = boolArg(args.include_unsupported_proxy, false);
  const prefix = args.gpt_prefix === undefined ? '[GPT] ' : String(args.gpt_prefix);
  const cache = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : null;
  const canCache = !!(cacheEnabled && cache && typeof cache.get === 'function' && typeof cache.set === 'function');
  const stats = { pass: 0, unsupported: 0, unknown: 0, error: 0, cached: 0 };

  if (!Array.isArray(proxies) || !proxies.length) return proxies;

  // Make repeat runs idempotent: never keep stale GPT labels from previous runs.
  for (const proxy of proxies) {
    proxy.name = stripPrefix(String(proxy.name || ''), prefix);
    proxy._gpt = false;
    proxy._gpt_status = 'unknown';
    delete proxy._gpt_latency;
  }

  let next = 0;
  async function worker() {
    while (next < proxies.length) {
      const index = next++;
      await check(proxies[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, proxies.length) }, () => worker()));

  $.info(`[GPT-V2] 完成: 总数=${proxies.length}, 通过=${stats.pass}, 地区限制=${stats.unsupported}, 未确认=${stats.unknown}, 请求错误=${stats.error}, 命中缓存=${stats.cached}`);
  return proxies;

  async function check(proxy) {
    const originalName = proxy.name;
    const cacheKey = canCache ? 'gpt-v2:' + endpoint + ':' + JSON.stringify(
      Object.fromEntries(Object.entries(proxy).filter(([key]) =>
        !/^(name|collectionName|subName|id|_.*)$/i.test(key)
      ))
    ) : null;

    try {
      if (cacheKey) {
        const saved = cache.get(cacheKey);
        if (saved && (saved.result === 'pass' || (cacheFailed && saved.result === 'unsupported'))) {
          apply(proxy, saved.result, saved.latency);
          stats.cached++;
          stats[saved.result]++;
          $.info(`[GPT-V2] [${originalName}] 缓存: ${saved.result}`);
          return;
        }
      }

      const node = ProxyUtils.produce([proxy], target, undefined, {
        'include-unsupported-proxy': includeUnsupported
      });
      if (!node) {
        stats.unknown++;
        proxy._gpt_status = 'incompatible';
        $.info(`[GPT-V2] [${originalName}] 节点协议不受当前运行环境支持，跳过`);
        return;
      }

      const startedAt = Date.now();
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await $.http.get({
            url: endpoint,
            headers: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
            },
            timeout,
            'policy-descriptor': node,
            node
          });
          break;
        } catch (e) {
          if (attempt >= retries) throw e;
          await $.wait(retryDelay * (attempt + 1));
        }
      }
      const latency = Date.now() - startedAt;
      // Never default a missing status to 200; status may be missing on failed requests.
      const status = Number(res && (res.status ?? res.statusCode)) || 0;
      const rawBody = res && (res.body ?? res.rawBody);
      const textBody = typeof rawBody === 'string' ? rawBody : safeStringify(rawBody);
      let body = rawBody;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { /* body may be HTML */ }
      }
      const errorCode = typeof body === 'object' && body !== null
        ? String(body.error?.code || body.error?.error_type || body.cf_details || '')
        : '';
      const signal = `${errorCode} ${textBody.slice(0, 2000)}`;
      const isRegionBlocked = /unsupported_country|unsupported_region|country_not_supported/i.test(signal);
      const isChallenge = /cloudflare|cf-ray|challenge-platform|captcha|just a moment|attention required/i.test(signal);
      let result = 'unknown';
      if (isRegionBlocked) result = 'unsupported';
      else if (status === 403 && !isChallenge) result = 'pass';

      apply(proxy, result, latency);
      stats[result]++;
      $.info(`[GPT-V2] [${originalName}] HTTP=${status}, 结果=${result}, code=${errorCode.slice(0, 100) || '-'}, 耗时=${latency}ms`);
      if (cacheKey && (result === 'pass' || (cacheFailed && result === 'unsupported'))) {
        cache.set(cacheKey, { result, latency }, result === 'pass' ? cacheTtl : failedCacheTtl);
      }
    } catch (e) {
      stats.error++;
      proxy._gpt_status = 'error';
      const msg = String(e && (e.message || e) || 'unknown error').slice(0, 160);
      $.error(`[GPT-V2] [${originalName}] 请求失败: ${msg}`);
    }
  }

  function apply(proxy, result, latency) {
    proxy._gpt = result === 'pass';
    proxy._gpt_status = result;
    if (result === 'pass') {
      proxy.name = `${prefix}${proxy.name}`;
      proxy._gpt_latency = latency;
    }
  }

  function boolArg(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(true|1|yes|on)$/i.test(String(value));
  }
  function integerArg(value, fallback, min, max) {
    if (value === undefined || value === null || value === '') return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(min, Math.min(max, Math.trunc(num))) : fallback;
  }
  function stripPrefix(name, mark) {
    if (!mark) return name;
    while (name.startsWith(mark)) name = name.slice(mark.length);
    return name;
  }
  function safeStringify(obj) {
    try { return JSON.stringify(obj) || ''; } catch (_) { return ''; }
  }
}
